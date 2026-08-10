/**
 * Preços: o estado atual de um item e sua série histórica.
 *
 * As duas fontes NÃO são a mesma coisa e nunca são somadas:
 *  - `market`  é o agregado que o próprio site publica (min/máx/média de tudo que já
 *              foi vendido). Responde "quanto esse item costuma valer".
 *  - `offers`  é o que medimos das lojas abertas agora. Responde "por quanto dá para
 *              comprar neste momento".
 * Um item pode ter `market` sem `offers` (já vendeu, ninguém vendendo agora) e o
 * contrário (anunciado agora, nunca vendido).
 */

import type { DatabaseSync } from "node:sqlite";

import type { Server } from "./servers.js";
import { getCache } from "../store/cache.js";
import { listingHistory, priceHistory } from "../store/read.js";
import { quantileIndex } from "../util/stats.js";
import { searchItems, toBrief, type SearchOptions } from "./items.js";
import type {
  Freshness,
  HistoryPoint,
  ItemPrice,
  MarketAggregate,
  Offer,
  OfferSummary,
} from "./types.js";

/** Quantas ofertas acompanham um preço por padrão. */
export const DEFAULT_CHEAPEST = 5;

export function freshness(server: Server): Freshness {
  const cache = getCache(server);
  return {
    marketAt: cache.marketAt,
    tradingAt: cache.tradingAt,
    tradingAgeMin:
      cache.tradingAt === null
        ? null
        : Math.round((Date.now() / 1000 - cache.tradingAt) / 60),
  };
}

export function offerSummary(server: Server, itemId: number): OfferSummary | null {
  const cache = getCache(server);
  const listings = cache.listings.get(itemId);
  if (!listings || listings.length === 0 || cache.tradingAt === null) return null;

  // Já vêm ordenados por preço do cache, então o percentil é uma posição no próprio
  // balde; um anúncio conta uma vez independente da quantidade, porque o preço é por
  // unidade e uma loja com 300 peças não deve dominar a mediana.
  const at = (p: number): number => listings[quantileIndex(listings.length, p)]!.price;
  return {
    stores: listings.length,
    units: listings.reduce((sum, l) => sum + l.cnt, 0),
    min: listings[0]!.price,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    max: listings[listings.length - 1]!.price,
    at: cache.tradingAt,
  };
}

/**
 * O agregado publicado pelo site, se houver.
 *
 * Vive numa função própria porque dois lugares precisam dele — o preço de um item e a
 * avaliação de replay — e duplicar a montagem deixaria os dois divergirem calados.
 */
export function marketAggregate(server: Server, itemId: number): MarketAggregate | null {
  const cache = getCache(server);
  const point = cache.prices.get(itemId);
  if (!point || cache.marketAt === null) return null;

  return {
    min: point.minPrice,
    max: point.maxPrice,
    avg: point.avgPrice,
    totalSold: point.totalCnt,
    at: point.ts,
  };
}

export function cheapestOffers(
  server: Server,
  itemId: number,
  limit = DEFAULT_CHEAPEST,
): Offer[] {
  const listings = getCache(server).listings.get(itemId) ?? [];
  return listings.slice(0, Math.max(0, limit)).map((l) => ({
    price: l.price,
    qty: l.cnt,
    store: l.storeName,
    seller: l.seller,
    mapId: l.mapId,
  }));
}

export function itemPrice(
  server: Server,
  itemId: number,
  cheapest = DEFAULT_CHEAPEST,
): ItemPrice | null {
  const brief = toBrief(server, itemId);
  if (!brief) return null;

  return {
    ...brief,
    market: marketAggregate(server, itemId),
    offers: offerSummary(server, itemId),
    cheapest: cheapestOffers(server, itemId, cheapest),
  };
}

export interface SearchPrices {
  total: number;
  items: ItemPrice[];
}

/**
 * A busca com o preço de cada linha.
 *
 * Existe para a tabela do site, que mostra "mais barato", "mediana" e "média vendida" em
 * colunas: sem isto ela precisaria de uma segunda requisição por página, e ordenar por
 * preço no servidor — que é o que faz a ordem valer para o TOTAL, e não só para os
 * cinquenta carregados — não teria como acontecer.
 *
 * Mora aqui, e não em `core/items.ts`, porque este módulo já importa `toBrief`: a seta
 * continua apontando para um lado só. `searchItems` segue devolvendo `ItemBrief`, que é o
 * que o MCP consome — encher a resposta do agente de preço em toda busca gastaria o
 * contexto dele sem ninguém ter pedido.
 *
 * Uma oferta por item, e não um parâmetro: a única coluna que lê oferta individual é a do
 * vendedor, e ela mostra a primeira.
 */
export function searchPrices(opts: SearchOptions): SearchPrices {
  const { total, items } = searchItems(opts);
  return {
    total,
    // Acrescenta ao brief que a busca já montou, em vez de chamar `itemPrice` — que
    // refaria o `toBrief`, e com ele o `linksFor` de cada linha: duas URLs remontadas por
    // item, de longe a coisa mais cara deste caminho. O resto é leitura de `Map`.
    items: items.map((brief) => ({
      ...brief,
      market: marketAggregate(opts.server, brief.itemId),
      offers: offerSummary(opts.server, brief.itemId),
      cheapest: cheapestOffers(opts.server, brief.itemId, 1),
    })),
  };
}

export interface ItemPrices {
  prices: ItemPrice[];
  /** Ids pedidos que não existem no catálogo deste servidor. */
  missing: number[];
}

/**
 * Preço de vários itens numa passada.
 *
 * Existe para a aba Favoritos, que consulta em laço no navegador: com uma rota por item,
 * uma pessoa com trinta favoritos custaria trinta requisições a cada ciclo, e a aba fica
 * aberta o dia inteiro. Em lote é uma. Não há SQL novo aqui — `itemPrice` é leitura do
 * cache quente (`store/cache.ts`), então cem ids são cem buscas em `Map`.
 *
 * Só aceita id, nunca nome — quem tem nome passa por `resolveItems` (`core/items.ts`)
 * antes, que separa o que resolveu do que ficou ambíguo. Aqui a lista já é de ids.
 *
 * Id desconhecido vai para `missing` em vez de sumir da resposta: quem colou um id errado
 * precisa saber disso, e um buraco silencioso na lista significaria um alerta que nunca
 * dispara sem ninguém entender por quê.
 *
 * Id repetido é lido uma vez só. A regra mora aqui e não em quem chama porque as duas
 * formas de repetir chegam por caminhos diferentes — `502,502` na query da rota, ou dois
 * nomes distintos do mesmo item vindos do agente — e as duas querem a mesma resposta.
 */
export function itemPrices(
  server: Server,
  itemIds: number[],
  cheapest = DEFAULT_CHEAPEST,
): ItemPrices {
  const prices: ItemPrice[] = [];
  const missing: number[] = [];
  const lidos = new Set<number>();

  for (const itemId of itemIds) {
    if (lidos.has(itemId)) continue;
    lidos.add(itemId);
    const price = itemPrice(server, itemId, cheapest);
    if (price) prices.push(price);
    else missing.push(itemId);
  }

  return { prices, missing };
}

export interface HistoryOptions {
  itemId: number;
  /** Janela em dias. */
  days?: number;
  bucket?: "hour" | "day";
}

/**
 * Série histórica combinada.
 *
 * As duas fontes entram na mesma linha do tempo mas em campos separados, porque
 * medem coisas diferentes. Um ponto pode ter só um dos lados preenchido.
 */
export function history(
  db: DatabaseSync,
  server: Server,
  opts: HistoryOptions,
): HistoryPoint[] {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 730);
  const bucket = opts.bucket ?? (days <= 3 ? "hour" : "day");
  const to = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;

  const byTs = new Map<number, HistoryPoint>();
  const at = (ts: number): HistoryPoint => {
    let p = byTs.get(ts);
    if (!p) byTs.set(ts, (p = { ts }));
    return p;
  };

  for (const p of priceHistory(db, server, opts.itemId, from, to)) {
    const point = at(bucket === "day" ? Math.floor(p.ts / 86400) * 86400 : p.ts);
    point.marketAvg = p.avgPrice;
    point.marketMin = p.minPrice;
  }

  for (const s of listingHistory(db, server, opts.itemId, from, to, bucket)) {
    const point = at(s.ts);
    point.offerMin = s.minPrice;
    point.offerMedian = s.median;
    point.stores = s.listings;
  }

  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
