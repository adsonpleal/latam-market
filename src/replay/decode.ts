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
  type ItemRecord as LibItemRecord,
  type Replay as LibReplay,
  type StorageChangeEvent,
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
 * Aplica depósitos e retiradas sobre a listagem de um armazém, na ordem em que vieram.
 *
 * ⚠ **Isto devia morar no `rrfparser`, não aqui.** O que esta função sabe é protocolo, não
 * mercado: que o `index` é alça e não posição, que uma retirada não listada vem com
 * `itemId` 0, que há uma listagem por abertura. A própria lib manda cada consumidor
 * resolver isso ("apply these in order to the last StorageSnapshot of the same kind"), o
 * que significa que o simulador e o RagnaRecap vão escrever esta mesma função de novo,
 * cada um com a sua resposta para o item fantasma — exatamente a duplicação que a lib foi
 * criada para acabar (ver 94b06dd). O certo é um `storageAt(replay, kind)` na 1.2, com os
 * casos de `decode.test.ts` indo junto; até lá, isto é um paliativo.
 *
 * Existe separada e exportada para ser testável direto: nenhum dos replays que temos em
 * mão movimenta item com a janela aberta, então o caminho só se exercita com entrada
 * montada à mão.
 *
 * A alça é o `index` do servidor. Uma retirada de índice que a listagem não trouxe é
 * ignorada — sem a linha original não há o que subtrair, e a biblioteca já resolve o
 * `itemId` como 0 nesse caso, que entraria na conta como um item fantasma.
 */
export function applyStorageChanges(
  items: LibStorageItem[],
  changes: StorageChangeEvent[],
): LibStorageItem[] {
  const byIndex = new Map(items.map((i) => [i.index, { ...i }]));

  for (const change of changes) {
    const current = byIndex.get(change.index);

    if (change.added) {
      if (current) current.qty += change.amount;
      else {
        byIndex.set(change.index, {
          index: change.index,
          itemId: change.itemId,
          qty: change.amount,
          equipped: 0,
          refine: change.refine,
          grade: change.grade,
          cards: change.cards,
          options: change.options,
        });
      }
      continue;
    }

    if (!current) continue;
    current.qty -= change.amount;
    if (current.qty <= 0) byIndex.delete(change.index);
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * O armazém como estava no fim da gravação, ou `null` se nunca foi aberto.
 *
 * A biblioteca entrega uma listagem por abertura, então a pessoa que abre, fecha e abre
 * de novo aparece duas vezes. A última é a que vale: o servidor relista o conteúdo atual
 * a cada abertura, então tudo que foi movimentado antes dela já está refletido ali, e
 * reaplicar aqueles eventos contaria o mesmo depósito duas vezes.
 */
function latestStorage(replay: LibReplay, kind: StorageKind): DecodedStorage | null {
  const last = replay.storages.filter((s) => s.kind === kind).at(-1);
  if (!last) return null;

  // `>=` e não `>`: a listagem e um movimento podem cair no mesmo milissegundo, e nesse
  // empate o movimento é depois dela — não daria para depositar numa janela que já fechou.
  const after = replay.storageChanges.filter((c) => c.kind === kind && c.time >= last.time);

  return {
    items: applyStorageChanges(last.items, after).map(fromStorage),
    usedSlots: last.usedSlots,
    maxSlots: last.maxSlots,
    openedAtMs: last.time,
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
