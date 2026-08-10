/**
 * As formas que saem da camada `core`.
 *
 * São o contrato compartilhado entre a API REST e o MCP: as duas devolvem exatamente
 * estes objetos, sem remodelar. É o que garante que `GET /api/v1/items/501` e a
 * ferramenta `get_price` respondam a mesma coisa — se divergirem, é bug, e existe um
 * teste de paridade justamente para isso.
 */

import type { ItemLinks } from "./links.js";

export type { ItemLinks } from "./links.js";

/**
 * Identificação de um item, sem preço.
 *
 * Vai junto em toda resposta que menciona um item — busca, preço, pechinchas,
 * inventário de replay. Inclui os links de propósito: um agente que só devolve
 * números obriga a pessoa a ir procurar o item na mão.
 */
export interface ItemBrief {
  itemId: number;
  name: string;
  slots: number | null;
  /** Categoria do item (`adaga`, `cabeca`, `carta`…). Ver `core/taxonomy.ts`. */
  type: string | null;
  /** Se o item já apareceu em alguma coleta de mercado. */
  inMarket: boolean;
  links: ItemLinks;
}

/** Agregado que o próprio site publica (dataset market-price). */
export interface MarketAggregate {
  min: number | null;
  max: number | null;
  avg: number | null;
  /** Unidades já vendidas, acumulado histórico do site. */
  totalSold: number | null;
  /** Quando esta coleta foi feita (epoch em segundos). */
  at: number;
}

/** O que nós medimos das lojas abertas na última coleta. */
export interface OfferSummary {
  /** Quantas lojas estão vendendo. */
  stores: number;
  /** Soma das unidades à venda. */
  units: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  at: number;
}

export interface Offer {
  price: number;
  qty: number;
  store: string;
  seller: string;
  mapId: number | null;
}

export interface ItemPrice extends ItemBrief {
  /** Preço agregado publicado pelo site; null quando o item nunca foi vendido. */
  market: MarketAggregate | null;
  /** Resumo das lojas abertas agora; null quando ninguém está vendendo. */
  offers: OfferSummary | null;
  /** As ofertas mais baratas, já ordenadas. */
  cheapest: Offer[];
}

export interface HistoryPoint {
  /** Epoch em segundos. */
  ts: number;
  /** Da série do site (market-price). */
  marketAvg?: number | null;
  marketMin?: number | null;
  /** Do que medimos das lojas. */
  offerMin?: number;
  offerMedian?: number;
  stores?: number;
}

/** Aviso sobre a idade do dado. Vai junto em toda resposta que devolve preço. */
export interface Freshness {
  /** Quando o dataset de agregados foi coletado. */
  marketAt: number | null;
  /** Quando as lojas foram coletadas. */
  tradingAt: number | null;
  /** Idade da coleta de lojas, em minutos. */
  tradingAgeMin: number | null;
}
