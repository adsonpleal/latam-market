/**
 * Ponte entre o replay e o mercado: pega os itens de um `.rrf` e coloca preço neles.
 *
 * Regra que orienta tudo aqui: **nada de inventar valor**. Um item sem oferta e sem
 * histórico sai com preço `null`, e o total avisa quantos ficaram de fora. O contrário
 * — chutar um valor para fechar a conta — produziria um "seu inventário vale X" que
 * parece preciso e não é.
 */

import type { Server } from "./servers.js";
import { decodeReplay } from "../replay/rrf/decode.js";
import type { ItemRecord } from "../replay/rrf/items.js";
import { toBrief } from "./items.js";
import { cheapestOffers, freshness, marketAggregate, offerSummary } from "./prices.js";
import type { Freshness, ItemBrief, MarketAggregate } from "./types.js";
import { plural } from "../util/text.js";

export interface ValuedItem {
  item: ItemBrief;
  /** Posição dentro do próprio container. Identifica a linha quando o mesmo item se repete. */
  slot: number;
  qty: number;
  refine: number;
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

export interface ReplayValuation {
  recordedAt: number;
  character: { name: string; map: string; baseLevel: number; jobLevel: number };
  inventory: ValuedContainer;
  cart: ValuedContainer;
  equipped: ValuedContainer;
  /** Soma de inventário + carrinho + equipado. */
  totalValue: number;
  freshness: Freshness;
  /**
   * Containers de item cujo significado ainda não foi identificado (ids 4517, 4522…).
   * Vêm à parte e NÃO entram no total: contá-los sem saber o que são inflaria a conta.
   */
  unidentified: Record<number, ValuedItem[]>;
  notes: string[];
}

/**
 * Um exemplar com refino ou carta não é o item "base" que o mercado cota. Sinalizar é
 * a única saída honesta — o site agrega por id e não expõe o refino dos anúncios.
 */
function caveatFor(rec: ItemRecord): string | null {
  const bits: string[] = [];
  if (rec.refine > 0) bits.push(`refino +${rec.refine}`);
  if (rec.cards.length > 0) bits.push(plural(rec.cards.length, "carta/encante", "cartas/encantes"));
  if (rec.options.length > 0) {
    bits.push(plural(rec.options.length, "bônus aleatório", "bônus aleatórios"));
  }
  if (bits.length === 0) return null;
  return `Preço de referência é do item base; este tem ${bits.join(" e ")} e vale mais.`;
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

export function valueReplay(server: Server, buf: ArrayBuffer): ReplayValuation {
  const replay = decodeReplay(buf);

  const inventory = valueContainer(server, replay.items.inventory);
  const cart = valueContainer(server, replay.items.cart);
  // Costume e sombrio entram junto com o equipamento normal: para valorar, a
  // distinção entre os dois não muda nada.
  const equipped = valueContainer(server, [...replay.items.equipped, ...replay.items.equippedCostume]);

  const unidentified: Record<number, ValuedItem[]> = {};
  for (const [chunkId, records] of Object.entries(replay.items.unknown)) {
    unidentified[Number(chunkId)] = valueContainer(server, records).items;
  }

  const notes: string[] = [];
  const unpriced = inventory.unpriced + cart.unpriced + equipped.unpriced;
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
        ` (possivelmente armazém). Estão em 'unidentified' e não somam no total.`,
    );
  }
  notes.push(
    "O retrato é do início da gravação; itens pegos ou gastos durante o replay não aparecem.",
  );

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
    totalValue: inventory.value + cart.value + equipped.value,
    freshness: freshness(server),
    unidentified,
    notes,
  };
}

export interface SellCandidate extends ValuedItem {
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

  const pool = [
    ...valuation.inventory.items,
    ...valuation.cart.items,
    ...(opts.includeEquipped ? valuation.equipped.items : []),
  ];

  const out: SellCandidate[] = [];
  for (const v of pool) {
    if (v.total === null || v.total < minValue) continue;
    if (v.stores > maxCompetition) continue;

    const reason =
      v.stores === 0
        ? `Ninguém vendendo agora — você define o preço.`
        : v.stores <= 3
          ? `Só ${plural(v.stores, "loja", "lojas")} concorrendo, a mais barata a ${v.unitPrice!.toLocaleString("pt-BR")}z.`
          : `${v.stores} lojas concorrendo; a mediana está em ${(v.unitMedian ?? v.unitPrice!).toLocaleString("pt-BR")}z.`;

    out.push({ ...v, competition: v.stores, reason });
  }

  out.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
  return out;
}
