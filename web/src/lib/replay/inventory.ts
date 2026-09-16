/**
 * Do replay para a tela: pega os itens de um `.rrf` e dá nome a eles.
 *
 * Roda no navegador — o arquivo nunca sai do computador de quem o abriu. Até 2026-09-15 isto
 * morava num servidor, que também colocava preço em cada item a partir do mercado que
 * coletava; a coleta morreu com a proteção contra robôs do site oficial, e com ela o motivo
 * de mandar o replay para longe. O parser é o `rrfparser`, que roda igual nos dois lugares.
 *
 * Regra que continua valendo: **nada some e nada é inventado**. Um id fora do catálogo
 * aparece como "Item desconhecido", e o que o replay não mostra (um armazém que não foi
 * aberto) vira `null` e aviso em `notes`, não uma lista vazia.
 */

import type { ItemBrief, ItemIndex } from "../catalogue/catalogue.js";
import { enumerate, plural } from "../format.js";
import { decodeReplay, type DecodedStorage, type ItemRecord } from "./decode.js";

/** De onde saiu um item: o nome de cada container da resposta. */
export type ItemOrigin = "inventory" | "cart" | "equipped" | "storage" | "guildStorage";

export interface InventoryItem {
  item: ItemBrief;
  /** Posição dentro do próprio container. Identifica a linha quando o mesmo item se repete. */
  slot: number;
  qty: number;
  refine: number;
  /** Grau de encantamento: 0 nenhum, 1 D, 2 C, 3 B, 4 A. */
  grade: number;
  cards: number[];
  /** Nomes das cartas/encantes, na mesma ordem de `cards`; `#id` quando fora do catálogo. */
  cardNames: string[];
  /** Bitmask de local de equipamento; 0 fora dos containers de equipado. */
  equipped: number;
}

export interface InventoryContainer {
  items: InventoryItem[];
}

/** Um armazém, com a ocupação que o servidor informou ao abrir a janela. */
export interface InventoryStorage extends InventoryContainer {
  /**
   * Ocupação como o servidor mandou; `-1` quando não mandou. Discordar de `items.length`
   * significa listagem incompleta, e vira nota em `notes` — ver `DecodedStorage`.
   */
  usedSlots: number;
  maxSlots: number;
  /** ms desde o início da sessão em que a janela foi aberta. */
  openedAtMs: number;
}

export interface ReplayInventory {
  recordedAt: number;
  character: { name: string; map: string; baseLevel: number; jobLevel: number };
  inventory: InventoryContainer;
  cart: InventoryContainer;
  equipped: InventoryContainer;
  /**
   * Armazém do Kafra e do clã, ou `null` quando a janela não foi aberta na gravação.
   *
   * `null` não é o mesmo que vazio: um armazém aberto e vazio vem como zero itens. Só
   * dá para dizer "está vazio" no segundo caso.
   */
  storage: InventoryStorage | null;
  guildStorage: InventoryStorage | null;
  /**
   * Containers de item cujo significado ainda não foi identificado (ids 4517, 4522…).
   *
   * Já não são "possivelmente o armazém", como se supunha antes: os armazéns não passam
   * por contêiner nenhum, e numa gravação feita com as duas janelas abertas estes vêm
   * vazios do mesmo jeito. O armazém está em `storage` e `guildStorage`.
   */
  unidentified: Record<number, InventoryItem[]>;
  notes: string[];
}

function toInventoryItem(index: ItemIndex, rec: ItemRecord): InventoryItem {
  // Um id fora do catálogo (item novo, ou catálogo desatualizado) não pode sumir da
  // lista: a pessoa tem o item na mochila e esperaria vê-lo. Aparece sem nome, que é a
  // verdade sobre ele — e com o id, que é por onde ela descobre que item é.
  const item: ItemBrief = index.get(rec.itemId) ?? {
    itemId: rec.itemId,
    name: `Item desconhecido #${rec.itemId}`,
    slots: null,
  };

  return {
    item,
    slot: rec.slot,
    qty: rec.qty,
    refine: rec.refine,
    grade: rec.grade,
    cards: rec.cards,
    cardNames: rec.cards.map((id) => index.get(id)?.name ?? `#${id}`),
    equipped: rec.equipped,
  };
}

/**
 * Nomeia um container e fixa a ordem.
 *
 * Maior pilha primeiro, depois nome, e o slot como último desempate. Sem preço não há
 * "mais valioso" para pôr no topo, e a ordem do arquivo é a das abas do cliente — que muda
 * com qualquer item pego. Uma ordem estável faz duas leituras do mesmo replay darem a mesma
 * tabela.
 */
function toContainer(index: ItemIndex, records: ItemRecord[]): InventoryContainer {
  const items = records.map((rec) => toInventoryItem(index, rec));
  items.sort(
    (a, b) => b.qty - a.qty || a.item.name.localeCompare(b.item.name, "pt-BR") || a.slot - b.slot,
  );
  return { items };
}

/** Nomeia um armazém preservando a ocupação; `null` atravessa como `null`. */
function toStorage(index: ItemIndex, storage: DecodedStorage | null): InventoryStorage | null {
  if (storage === null) return null;
  return {
    ...toContainer(index, storage.items),
    usedSlots: storage.usedSlots,
    maxSlots: storage.maxSlots,
    openedAtMs: storage.openedAtMs,
  };
}

/** Lê o arquivo e nomeia cada item pelo catálogo. Lança se o arquivo não for um replay. */
export function readReplay(buf: ArrayBuffer, index: ItemIndex): ReplayInventory {
  const replay = decodeReplay(buf);

  const inventory = toContainer(index, replay.items.inventory);
  const cart = toContainer(index, replay.items.cart);
  // Costume e sombrio entram junto com o equipamento normal: a interface mostra os dois
  // como "equipado", e o bitmask de `equipped` ainda distingue quem precisar.
  const equipped = toContainer(index, [...replay.items.equipped, ...replay.items.equippedCostume]);
  const storage = toStorage(index, replay.storage);
  const guildStorage = toStorage(index, replay.guildStorage);

  const unidentified: Record<number, InventoryItem[]> = {};
  for (const [chunkId, records] of Object.entries(replay.items.unknown)) {
    unidentified[Number(chunkId)] = toContainer(index, records).items;
  }

  const notes: string[] = [
    "O retrato é do início da gravação; itens pegos ou gastos durante o replay não aparecem.",
  ];

  if (Object.keys(unidentified).length > 0) {
    notes.push(
      `O replay traz ` +
        plural(
          Object.keys(unidentified).length,
          "container de item ainda não identificado",
          "containers de item ainda não identificados",
        ) +
        `. Estão em 'unidentified', à parte do inventário.`,
    );
  }

  // Só o que não está na tela como número. Quantos itens e quantos slots cada armazém
  // tem já sai em `storage`/`guildStorage`; o que sobra aqui é o que nenhum campo diz: o
  // que a ausência de um armazém significa, de quando ele vale e de quem são os itens.
  // O "do" vai em cada rótulo, e não no prefixo: "armazém do Kafra e clã" está errado, e o
  // verbo tem que concordar com quantos faltaram.
  const missing = [storage === null && "do Kafra", guildStorage === null && "do clã"].filter(
    (s): s is string => s !== false,
  );
  if (missing.length > 0) {
    const um = missing.length === 1;
    notes.push(
      `${um ? "O armazém" : "Os armazéns"} ${enumerate(missing)} ` +
        `${um ? "não foi aberto" : "não foram abertos"} nesta gravação — e isso não é o ` +
        `mesmo que estar vazio. Para ver o conteúdo, grave um replay com a janela do ` +
        `armazém aberta.`,
    );
  }
  if (missing.length < 2) {
    // O armazém segue outro relógio, e não o início da gravação como o resto.
    notes.push(
      "O conteúdo do armazém vale do momento em que a janela foi aberta, mais os " +
        "depósitos e retiradas que vieram depois.",
    );
  }
  if (guildStorage !== null && guildStorage.items.length > 0) {
    notes.push("Atenção: o armazém do clã é compartilhado. Os itens dele não são só seus.");
  }

  // O servidor manda a própria contagem de pilhas junto da listagem. Quando ela discorda
  // do que contamos, a listagem chegou partida em mais de um pacote e um deles se perdeu:
  // faltam itens. O que não sabemos vira aviso, não uma lista que finge estar completa.
  for (const [label, s] of [
    ["do Kafra", storage],
    ["do clã", guildStorage],
  ] as const) {
    if (s === null || s.usedSlots < 0 || s.usedSlots === s.items.length) continue;
    notes.push(
      `A listagem do armazém ${label} veio incompleta: o servidor informou ` +
        `${plural(s.usedSlots, "pilha", "pilhas")}, mas só ${s.items.length} chegaram.`,
    );
  }

  return {
    recordedAt: replay.recordedAt,
    character: {
      name: replay.character.name,
      map: replay.character.map,
      baseLevel: replay.character.baseLevel,
      jobLevel: replay.character.jobLevel,
    },
    inventory,
    cart,
    equipped,
    storage,
    guildStorage,
    unidentified,
    notes,
  };
}
