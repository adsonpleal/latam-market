/**
 * Decodificação de um replay `.rrf`, no recorte que este projeto precisa:
 * quem gravou, quando, e o que havia no inventário, no carrinho e vestido.
 *
 * O parser em si virou biblioteca — `rrfparser`, compartilhada com o simulador e
 * o RagnaRecap. Aqui sobrou o adaptador: `decodeSnapshot` lê só os contêineres,
 * sem o fluxo de pacotes, então o empacotador descarta todos os decodificadores
 * de pacote na hora do build.
 *
 * **O retrato é do início da gravação.** O contêiner de itens é uma fotografia
 * tirada quando o replay começou; itens pegos ou consumidos durante a gravação
 * chegam como pacotes no fluxo e não entram aqui. Na prática isso não atrapalha,
 * porque um replay gravado para conferir inventário dura segundos — mas é a
 * razão de o campo se chamar `recordedAt` e de a API devolver esse carimbo junto
 * com os itens.
 */

import { decodeSnapshot, type ItemRecord as LibItemRecord } from "rrfparser";

export interface RandomOption {
  id: number;
  value: number;
  param: number;
}

export interface ItemRecord {
  /** Índice do slot dentro do próprio container (não é global). */
  slot: number;
  itemId: number;
  qty: number;
  /** Bitmask de equipLocation; 0 quando não está sendo usado. */
  equipped: number;
  refine: number;
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

export function decodeReplay(buf: ArrayBuffer): DecodedReplay {
  const { session, items } = decodeSnapshot(buf);

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
  };
}
