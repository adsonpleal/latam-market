/**
 * Ponte entre o replay e o mercado: pega os itens de um `.rrf` e coloca preço neles.
 *
 * Regra que orienta tudo aqui: **nada de inventar valor**. Um item sem oferta e sem
 * histórico sai com preço `null`, e o total avisa quantos ficaram de fora. O contrário
 * — chutar um valor para fechar a conta — produziria um "seu inventário vale X" que
 * parece preciso e não é.
 */

import type { Server } from "./servers.js";
import { decodeReplay } from "../replay/decode.js";
import type { DecodedStorage, ItemRecord } from "../replay/decode.js";
import { toBrief } from "./items.js";
import { cheapestOffers, freshness, marketAggregate, offerSummary } from "./prices.js";
import type { Freshness, ItemBrief, MarketAggregate } from "./types.js";
import { enumerate, plural } from "../util/text.js";

export interface ValuedItem {
  item: ItemBrief;
  /** Posição dentro do próprio container. Identifica a linha quando o mesmo item se repete. */
  slot: number;
  qty: number;
  refine: number;
  /** Grau de encantamento: 0 nenhum, 1 D, 2 C, 3 B, 4 A. */
  grade: number;
  cards: number[];
  /** Nomes das cartas/encantes, quando conhecidos. */
  cardNames: string[];
  /** Bitmask de local de equipamento; 0 fora dos containers de equipado. */
  equipped: number;
  /** Menor preço anunciado agora, por unidade. Null quando ninguém vende. */
  unitPrice: number | null;
  /** Mediana das ofertas, por unidade. Referência mais estável que o mínimo. */
  unitMedian: number | null;
  /** `unitPrice * qty`, ou null quando não há preço. */
  total: number | null;
  /** Quantas lojas vendem este item agora. */
  stores: number;
  /** Soma das unidades à venda agora. Null quando ninguém vende. */
  units: number | null;
  /**
   * O agregado que o site publica: quanto o item já foi vendido e por quanto.
   *
   * É outra medida, não um segundo preço — `unitPrice` é o anúncio mais barato de
   * agora, isto é o acumulado histórico. Somar os dois não significa nada.
   */
  market: MarketAggregate | null;
  /**
   * Aviso quando o preço não vale para ESTE exemplar: o mercado agrega por id de item,
   * sem separar refino, cartas ou opções aleatórias. Uma arma +9 encantada custa muito
   * mais que a mesma arma +0, e nós não temos como saber quanto.
   */
  priceCaveat: string | null;
}

export interface ValuedContainer {
  items: ValuedItem[];
  /** Soma dos `total` conhecidos. */
  value: number;
  /** Quantos itens ficaram sem preço. */
  unpriced: number;
}

/** Um armazém avaliado, com a ocupação que o servidor informou ao abrir a janela. */
export interface ValuedStorage extends ValuedContainer {
  /**
   * Ocupação como o servidor mandou; `-1` quando não mandou. Discordar de `items.length`
   * significa listagem incompleta, e vira nota em `notes` — ver `DecodedStorage`.
   */
  usedSlots: number;
  maxSlots: number;
  /** ms desde o início da sessão em que a janela foi aberta. */
  openedAtMs: number;
}

/** De onde saiu um item. Usado nas sugestões de venda, que misturam os containers. */
export type ItemOrigin = "inventory" | "cart" | "equipped" | "storage" | "guildStorage";

export interface ReplayValuation {
  recordedAt: number;
  character: { name: string; map: string; baseLevel: number; jobLevel: number };
  inventory: ValuedContainer;
  cart: ValuedContainer;
  equipped: ValuedContainer;
  /**
   * Armazém do Kafra e do clã, ou `null` quando a janela não foi aberta na gravação.
   *
   * `null` não é o mesmo que vazio: um armazém aberto e vazio vem como zero itens. Só
   * dá para dizer "está vazio" no segundo caso.
   */
  storage: ValuedStorage | null;
  guildStorage: ValuedStorage | null;
  /**
   * Soma de tudo que o replay mostrou: inventário, carrinho, equipado e os armazéns que
   * foram abertos.
   *
   * Por isso ele **não é comparável entre replays**: a mesma pessoa gravando sem passar
   * no Kafra tem um total menor sem ter perdido nada. Para comparar duas gravações, some
   * os containers que existem nas duas.
   */
  totalValue: number;
  freshness: Freshness;
  /**
   * Containers de item cujo significado ainda não foi identificado (ids 4517, 4522…).
   * Vêm à parte e NÃO entram no total: contá-los sem saber o que são inflaria a conta.
   *
   * Já não são "possivelmente o armazém", como se supunha antes: os armazéns não passam
   * por contêiner nenhum, e numa gravação feita com as duas janelas abertas estes vêm
   * vazios do mesmo jeito. O armazém está em `storage` e `guildStorage`.
   */
  unidentified: Record<number, ValuedItem[]>;
  notes: string[];
}

/** Letra que o cliente imprime na frente do refino: "+11 [C] Gakkung Primordial-LT". */
const GRADE_LETTER: Record<number, string> = { 1: "D", 2: "C", 3: "B", 4: "A" };

/**
 * Um exemplar com refino ou carta não é o item "base" que o mercado cota. Sinalizar é
 * a única saída honesta — o site agrega por id e não expõe o refino dos anúncios.
 */
function caveatFor(rec: ItemRecord): string | null {
  const bits: string[] = [];
  if (rec.refine > 0) bits.push(`refino +${rec.refine}`);
  if (rec.grade > 0) bits.push(`grau ${GRADE_LETTER[rec.grade] ?? rec.grade}`);
  if (rec.cards.length > 0) bits.push(plural(rec.cards.length, "carta/encante", "cartas/encantes"));
  if (rec.options.length > 0) {
    bits.push(plural(rec.options.length, "bônus aleatório", "bônus aleatórios"));
  }
  if (bits.length === 0) return null;
  return `Preço de referência é do item base; este tem ${enumerate(bits)} e vale mais.`;
}

function valueRecord(server: Server, rec: ItemRecord): ValuedItem {
  // Um id fora do catálogo (item novo, ou catálogo desatualizado) não pode sumir da
  // lista: a pessoa tem o item na mochila e esperaria vê-lo. Aparece sem nome e sem
  // preço, que é a verdade sobre ele.
  const unknownName = `Item desconhecido #${rec.itemId}`;
  const item = toBrief(server, rec.itemId) ?? {
    itemId: rec.itemId,
    name: unknownName,
    slots: null,
    type: null,
    inMarket: false,
    // O link do Divine Pride ainda vale: lá o id provavelmente existe, e é onde a
    // pessoa vai descobrir que item é esse. O do mercado, não — buscar pelo texto
    // "Item desconhecido" não acharia nada.
    links: { divinePride: `https://www.divine-pride.net/database/item/${rec.itemId}`, market: null, marketHistory: null },
  };

  const summary = offerSummary(server, rec.itemId);
  const cheapest = cheapestOffers(server, rec.itemId, 1);
  const unitPrice = cheapest[0]?.price ?? null;

  return {
    item,
    slot: rec.slot,
    qty: rec.qty,
    refine: rec.refine,
    grade: rec.grade,
    cards: rec.cards,
    cardNames: rec.cards.map((id) => toBrief(server, id)?.name ?? `#${id}`),
    equipped: rec.equipped,
    unitPrice,
    unitMedian: summary?.median ?? null,
    total: unitPrice === null ? null : unitPrice * rec.qty,
    stores: summary?.stores ?? 0,
    units: summary?.units ?? null,
    market: marketAggregate(server, rec.itemId),
    priceCaveat: caveatFor(rec),
  };
}

function valueContainer(server: Server, records: ItemRecord[]): ValuedContainer {
  const items: ValuedItem[] = [];
  let value = 0;
  let unpriced = 0;

  for (const rec of records) {
    const valued = valueRecord(server, rec);
    if (valued.total === null) unpriced++;
    else value += valued.total;
    items.push(valued);
  }

  // Mais valioso primeiro: é a ordem em que a pessoa quer ler.
  items.sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
  return { items, value, unpriced };
}

/** Avalia um armazém preservando a ocupação; `null` atravessa como `null`. */
function valueStorage(server: Server, storage: DecodedStorage | null): ValuedStorage | null {
  if (storage === null) return null;
  return {
    ...valueContainer(server, storage.items),
    usedSlots: storage.usedSlots,
    maxSlots: storage.maxSlots,
    openedAtMs: storage.openedAtMs,
  };
}

export function valueReplay(server: Server, buf: ArrayBuffer): ReplayValuation {
  const replay = decodeReplay(buf);

  const inventory = valueContainer(server, replay.items.inventory);
  const cart = valueContainer(server, replay.items.cart);
  // Costume e sombrio entram junto com o equipamento normal: para valorar, a
  // distinção entre os dois não muda nada.
  const equipped = valueContainer(server, [...replay.items.equipped, ...replay.items.equippedCostume]);
  const storage = valueStorage(server, replay.storage);
  const guildStorage = valueStorage(server, replay.guildStorage);

  const unidentified: Record<number, ValuedItem[]> = {};
  for (const [chunkId, records] of Object.entries(replay.items.unknown)) {
    unidentified[Number(chunkId)] = valueContainer(server, records).items;
  }

  const notes: string[] = [];
  const counted = [inventory, cart, equipped, storage, guildStorage].filter((c) => c !== null);
  const unpriced = counted.reduce((sum, c) => sum + c.unpriced, 0);
  if (unpriced > 0) {
    notes.push(
      `${unpriced} item(ns) sem preço: ninguém está vendendo agora, então não entraram no total.`,
    );
  }
  if (Object.keys(unidentified).length > 0) {
    notes.push(
      `O replay traz ` +
        plural(
          Object.keys(unidentified).length,
          "container de item ainda não identificado",
          "containers de item ainda não identificados",
        ) +
        `. Estão em 'unidentified' e não somam no total.`,
    );
  }
  notes.push(
    "O retrato é do início da gravação; itens pegos ou gastos durante o replay não aparecem.",
  );

  // Só o que não está na resposta como número. Quantos itens e quantos slots cada armazém
  // tem já sai em `storage`/`guildStorage`, e a interface põe os dois lado a lado como
  // cifra — repetir isso em prosa rendia "35 de 300 slots" duas vezes na mesma tela. O que
  // sobra aqui é o que nenhum campo diz: o que a ausência de um armazém significa, e de
  // quem são os itens.
  // O "do" vai em cada rótulo, e não no prefixo: "armazém do Kafra e clã" está errado, e o
  // verbo tem que concordar com quantos faltaram.
  const missing = [storage === null && "do Kafra", guildStorage === null && "do clã"].filter(
    (s): s is string => s !== false,
  );
  if (missing.length > 0) {
    const um = missing.length === 1;
    notes.push(
      `${um ? "O armazém" : "Os armazéns"} ${enumerate(missing)} ` +
        `${um ? "não foi aberto" : "não foram abertos"} nesta gravação, então ` +
        `${um ? "não entrou" : "não entraram"} no total — e não é o mesmo que estar vazio. ` +
        `Para incluir, grave um replay com a janela do armazém aberta.`,
    );
  }
  if (missing.length < 2) {
    // Duas coisas que nenhum campo da resposta diz: de QUANDO vale o armazém (outro
    // relógio, não o início da gravação como o resto), e que por ele entrar no total dois
    // replays só se comparam se ambos tiverem passado no armazém.
    notes.push(
      "O armazém entrou no total. O conteúdo dele vale do momento em que a janela foi " +
        "aberta, mais os depósitos e retiradas que vieram depois — por isso o total só se " +
        "compara com o de outro replay que também tenha aberto o armazém.",
    );
  }
  if (guildStorage !== null && guildStorage.items.length > 0) {
    notes.push(
      "Atenção: o armazém do clã é compartilhado. Os itens dele entram no total e nas " +
        "sugestões de venda, mas não são só seus.",
    );
  }

  // O servidor manda a própria contagem de pilhas junto da listagem. Quando ela discorda
  // do que contamos, a listagem chegou partida em mais de um pacote e um deles se perdeu:
  // faltam itens, e o total está POR BAIXO. É o mesmo princípio do item sem preço — o que
  // não sabemos vira aviso, não um número que finge estar fechado.
  for (const [label, s] of [
    ["do Kafra", storage],
    ["do clã", guildStorage],
  ] as const) {
    if (s === null || s.usedSlots < 0 || s.usedSlots === s.items.length) continue;
    notes.push(
      `A listagem do armazém ${label} veio incompleta: o servidor informou ` +
        `${plural(s.usedSlots, "pilha", "pilhas")}, mas só ${s.items.length} chegaram. ` +
        `O valor dele está por baixo.`,
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
    totalValue: counted.reduce((sum, c) => sum + c.value, 0),
    freshness: freshness(server),
    unidentified,
    notes,
  };
}

export interface SellCandidate extends ValuedItem {
  /**
   * De qual container o item saiu.
   *
   * A lista mistura mochila, carrinho e armazém, e sem isto não há como agir sobre ela:
   * o item pode estar guardado no Kafra, ou no armazém do clã, que é compartilhado.
   */
  origin: ItemOrigin;
  /**
   * Quão fácil é vender: número de lojas concorrendo. Poucas lojas e preço alto é o
   * caso interessante; muitas lojas significa que você entra numa fila.
   */
  competition: number;
  reason: string;
}

/**
 * Filtra o que vale a pena colocar à venda.
 *
 * "Lucro" aqui é o que dá para pedir hoje, não margem sobre custo — o mercado do jogo
 * não expõe por quanto a pessoa adquiriu o item. O critério é valor total acima de um
 * piso e concorrência baixa o suficiente para o item efetivamente sair.
 */
export function sellCandidates(
  valuation: ReplayValuation,
  opts: { minValue?: number; maxCompetition?: number; includeEquipped?: boolean } = {},
): SellCandidate[] {
  const minValue = opts.minValue ?? 10_000;
  const maxCompetition = opts.maxCompetition ?? 15;

  // Os armazéns entram sempre que existem: o que está guardado no Kafra é justamente o
  // que costuma estar ali para ser vendido depois. `origin` é o que deixa a lista
  // acionável — sem ela, "venda isto" não diz onde o item está.
  //
  // A origem fica ao lado da lista a que pertence, e não copiada em cada item: é uma
  // constante por grupo. `includeEquipped` desligado vira lista vazia em vez de um spread
  // condicional.
  const groups: Array<[ItemOrigin, ValuedItem[]]> = [
    ["inventory", valuation.inventory.items],
    ["cart", valuation.cart.items],
    ["equipped", opts.includeEquipped ? valuation.equipped.items : []],
    ["storage", valuation.storage?.items ?? []],
    ["guildStorage", valuation.guildStorage?.items ?? []],
  ];

  const out: SellCandidate[] = [];
  for (const [origin, items] of groups) {
    for (const v of items) {
      if (v.total === null || v.total < minValue) continue;
      if (v.stores > maxCompetition) continue;

      const reason =
        v.stores === 0
          ? `Ninguém vendendo agora — você define o preço.`
          : v.stores <= 3
            ? `Só ${plural(v.stores, "loja", "lojas")} concorrendo, a mais barata a ${v.unitPrice!.toLocaleString("pt-BR")}z.`
            : `${v.stores} lojas concorrendo; a mediana está em ${(v.unitMedian ?? v.unitPrice!).toLocaleString("pt-BR")}z.`;

      out.push({ ...v, origin, competition: v.stores, reason });
    }
  }

  out.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return out;
}
