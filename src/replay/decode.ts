/**
 * Decodificação de um replay `.rrf`, no recorte que este projeto precisa: quem gravou,
 * quando, o que havia no inventário, no carrinho e vestido — e, quando a janela foi
 * aberta durante a gravação, o que havia nos armazéns do Kafra e do clã.
 *
 * O parser em si virou biblioteca — `rrfparser`, compartilhada com o simulador e o
 * RagnaRecap. Aqui sobrou o adaptador.
 *
 * **Os armazéns custam o fluxo de pacotes.** Inventário, carrinho e equipamento moram
 * nos contêineres do arquivo, e antes daqui este adaptador lia só eles, por
 * `decodeSnapshot` — o que deixava o empacotador descartar todo decodificador de pacote
 * na hora do build. Os armazéns não estão em contêiner nenhum: o servidor os manda como
 * pacotes de listagem no instante em que a janela abre. Lê-los exige `decodeReplay`, que
 * decodifica o fluxo inteiro, e o preço é esse — os decodificadores de pacote voltaram
 * para o bundle (+23 KB no `dist/server.mjs`).
 *
 * O preço em tempo **cresce com o tamanho do arquivo**, e é aí que a troca muda de
 * natureza: `decodeSnapshot` custava o tamanho dos contêineres, quase o mesmo para uma
 * gravação de dez segundos ou de uma hora. Agora percorremos e alocamos a lista de todo
 * evento do fluxo — dano, passos, invocações — para jogar tudo fora e ficar só com a
 * sessão, os itens e os dois armazéns. Medido no replay de conferir inventário, de 64 KB,
 * são 0,5 ms contra 0,9 ms; num arquivo perto do limite de `config.limits.replayBytes`
 * (8 MB) é muito mais, e síncrono, no laço de eventos da API. Ou seja: 0,9 ms é a medida
 * de um caso pequeno, não um teto.
 *
 * **O retrato é do início da gravação** — para inventário, carrinho e equipamento. O
 * contêiner de itens é uma fotografia tirada quando o replay começou; itens pegos ou
 * consumidos durante a gravação chegam como pacotes no fluxo e não entram aqui. É a razão
 * de o campo se chamar `recordedAt` e de a API devolver esse carimbo junto com os itens.
 *
 * Os armazéns seguem outro relógio: valem do instante em que a janela foi aberta (o
 * `openedAtMs` de cada um), mais os depósitos e retiradas que vieram depois.
 */

import {
  decodeReplay as decodeFull,
  storageAt,
  type ItemRecord as LibItemRecord,
  type Replay as LibReplay,
  type StorageItem as LibStorageItem,
  type StorageKind,
} from "rrfparser";

export interface RandomOption {
  id: number;
  value: number;
  param: number;
}

export interface ItemRecord {
  /**
   * Índice do slot dentro do próprio container (não é global). Nos armazéns é o índice
   * que o servidor usa como alça do item na listagem — único ali dentro, e por isso
   * serve para identificar a linha, mas não é uma posição estável do armazém.
   */
  slot: number;
  itemId: number;
  qty: number;
  /** Bitmask de equipLocation; 0 quando não está sendo usado. */
  equipped: number;
  refine: number;
  /** Grau de encantamento: 0 nenhum, 1 D, 2 C, 3 B, 4 A. */
  grade: number;
  /** Ids de carta/encantamento; zeros já removidos. */
  cards: number[];
  options: RandomOption[];
}

export interface ItemContainers {
  inventory: ItemRecord[];
  cart: ItemRecord[];
  equipped: ItemRecord[];
  equippedCostume: ItemRecord[];
  unknown: Record<number, ItemRecord[]>;
}

/** Um armazém como estava na gravação. */
export interface DecodedStorage {
  items: ItemRecord[];
  /**
   * Pilhas em uso e capacidade, como o servidor informou junto da listagem; `-1` quando
   * ele não mandou a contagem.
   *
   * `usedSlots` é a contagem do próprio servidor, e vale menos como número do que como
   * conferência: se ela discorda de `items.length`, a listagem veio partida em vários
   * pacotes e um se perdeu. `core/replay.ts` usa exatamente essa discordância para avisar
   * que o valor do armazém está por baixo. Para a contagem de agora, `items.length`.
   */
  usedSlots: number;
  maxSlots: number;
  /** ms desde o início da sessão em que a listagem chegou. */
  openedAtMs: number;
}

export interface ReplayCharacter {
  name: string;
  map: string;
  accountId: number;
  job: number;
  baseLevel: number;
  jobLevel: number;
}

export interface DecodedReplay {
  /** Momento da gravação, em epoch de segundos (o header guarda hora local). */
  recordedAt: number;
  character: ReplayCharacter;
  items: ItemContainers;
  /**
   * Armazém do Kafra, ou `null` quando a janela não foi aberta durante a gravação.
   *
   * `null` e vazio são coisas diferentes: `null` é "não sabemos, ninguém abriu", e um
   * armazém aberto e vazio vem como uma lista de zero itens. Contar um pelo outro diria
   * "seu armazém está vazio" para quem simplesmente não passou no Kafra.
   */
  storage: DecodedStorage | null;
  /** Armazém do clã/guilda, com a mesma distinção entre `null` e vazio. */
  guildStorage: DecodedStorage | null;
}

/**
 * A biblioteca devolve as cartas por posição, com zero no soquete vazio, porque
 * o simulador precisa saber em qual soquete cada encante está. Aqui a posição
 * não importa — e um zero viraria "#0" na lista de nomes de `valueRecord`, além
 * de inflar o `cards.length` que `caveatFor` usa —, então filtramos.
 */
const strip = (r: LibItemRecord): ItemRecord => ({
  ...r,
  cards: r.cards.filter((c) => c > 0),
});

const stripAll = (rs: LibItemRecord[]): ItemRecord[] => rs.map(strip);

/**
 * Item de armazém no formato dos demais containers; nada em armazém está vestido.
 *
 * Passa por `strip` em vez de copiar campo por campo: a regra das cartas com zero é a
 * mesma, e uma segunda lista de campos escrita à mão calaria sobre qualquer campo novo de
 * `ItemRecord` — foi o que quase aconteceu com `grade`. O `index` sai na desestruturação
 * para não vazar no JSON da API ao lado do `slot` que ele virou.
 */
const fromStorage = ({ index, ...r }: LibStorageItem): ItemRecord =>
  strip({ ...r, slot: index, equipped: 0 });

/**
 * O armazém como estava no fim da gravação, ou `null` se nunca foi aberto.
 *
 * Quem junta a listagem com os depósitos e retiradas é a lib, pelo `storageAt` da 1.2 —
 * antes disso essa costura morava aqui, e não devia: o que ela sabe é protocolo (que o
 * `index` é alça e não posição, que a última listagem já reflete o que veio antes dela,
 * que uma retirada não listada tem de ser descartada), não mercado. A lib mandava cada
 * consumidor resolver isso, o que ia render uma cópia por consumidor — a duplicação que
 * ela foi criada para acabar. Aqui sobrou só a tradução para o formato da casa.
 */
function latestStorage(replay: LibReplay, kind: StorageKind): DecodedStorage | null {
  const snapshot = storageAt(replay, kind);
  if (snapshot === null) return null;

  return {
    items: snapshot.items.map(fromStorage),
    usedSlots: snapshot.usedSlots,
    maxSlots: snapshot.maxSlots,
    openedAtMs: snapshot.time,
  };
}

export function decodeReplay(buf: ArrayBuffer): DecodedReplay {
  const replay = decodeFull(buf);
  const { sessionInfo: session, items } = replay;

  return {
    // O header grava a hora local de quem gravou, sem fuso. A lib devolve a data
    // construída como local; converter para epoch é o mais próximo da verdade
    // que dá para chegar.
    recordedAt: Math.floor(session.recordedAt.getTime() / 1000),
    character: {
      name: session.player,
      map: session.map,
      accountId: session.aid,
      job: session.job,
      baseLevel: session.baseLevel,
      jobLevel: session.jobLevel,
    },
    items: {
      inventory: stripAll(items.inventory),
      cart: stripAll(items.cart),
      equipped: stripAll(items.equipped),
      equippedCostume: stripAll(items.equippedCostume),
      unknown: Object.fromEntries(
        Object.entries(items.unknown).map(([id, rs]) => [
          Number(id),
          stripAll(rs),
        ]),
      ),
    },
    storage: latestStorage(replay, "storage"),
    guildStorage: latestStorage(replay, "guildStorage"),
  };
}
