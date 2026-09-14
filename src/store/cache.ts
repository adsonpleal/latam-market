/**
 * O mercado corrente, em memória.
 *
 * O mercado inteiro cabe com folga (~5 mil itens com preço, ~20 mil ofertas), então
 * nenhuma leitura da API precisa tocar o disco. O banco existe para o histórico e para
 * sobreviver a restart (ver `load.ts`), não para o caminho quente.
 *
 * **Toda mudança publica um objeto NOVO**, numa atribuição só. JS é single-threaded, então a
 * troca é o ponto atômico: um leitor nunca vê um item pela metade. E há quem dependa da
 * identidade — `core/items.ts` memoiza as listas de ids pelo objeto do cache; mexer no
 * objeto no lugar serviria a lista velha para sempre.
 *
 * A ingestão agora é por item, conforme a coleta anda, então as publicações são muitas e
 * pequenas: cada uma copia só os mapas que mudou. Copiar um `Map` de 5 mil entradas custa
 * microssegundos, e acontece algumas centenas de vezes por coleta.
 */

import type { Server } from "../core/servers.js";
import type { ItemRow, ListingRow, PricePoint } from "./read.js";

export interface MarketCache {
  /** Snapshot de origem de cada dataset, ou null se nunca houve um fechado. */
  marketSnapshotId: number | null;
  tradingSnapshotId: number | null;
  /** Quando cada dataset foi coletado — é o que `data_status` devolve. */
  marketAt: number | null;
  tradingAt: number | null;
  /**
   * Muda a CADA publicação, inclusive no meio de uma coleta.
   *
   * É o que entra no ETag das rotas de mercado. `tradingAt` só anda quando a coleta fecha,
   * e com a publicação por item um ETag feito dele responderia 304 a quem pergunta no meio
   * de uma coleta que já mudou metade dos itens. O prefixo do boot faz um restart invalidar
   * tudo, já que o contador recomeça.
   */
  revision: string;

  items: Map<number, ItemRow>;
  /**
   * Ids que já apareceram no mercado DESTE servidor.
   *
   * Fora do `ItemRow` porque o catálogo é do jogo e este fato é do servidor.
   */
  inMarket: Set<number>;
  /** Nome normalizado exato -> id. O caminho dominante de resolução por nome. */
  byNameNorm: Map<string, number>;
  prices: Map<number, PricePoint>;
  /** Ofertas por item, já ordenadas por preço crescente. */
  listings: Map<number, ListingRow[]>;
}

const BOOT = Date.now().toString(36);
let counter = 0;
const nextRevision = (): string => `${BOOT}.${++counter}`;

const EMPTY: MarketCache = {
  marketSnapshotId: null,
  tradingSnapshotId: null,
  marketAt: null,
  tradingAt: null,
  revision: `${BOOT}.0`,
  items: new Map(),
  inMarket: new Set(),
  byNameNorm: new Map(),
  prices: new Map(),
  listings: new Map(),
};

const caches = new Map<Server, MarketCache>();

export function getCache(server: Server): MarketCache {
  return caches.get(server) ?? EMPTY;
}

/**
 * O catálogo indexado, pronto para virar cache.
 *
 * Os DOIS servidores usam o mesmo: `items` e `byNameNorm` são do jogo, não do mercado. Os
 * dois `MarketCache` guardam a MESMA referência de `Map`, então o catálogo é indexado uma
 * vez e ocupa memória uma vez.
 */
export interface CatalogueIndex {
  items: Map<number, ItemRow>;
  byNameNorm: Map<string, number>;
}

export function indexCatalogue(rows: Iterable<ItemRow>): CatalogueIndex {
  const items = new Map<number, ItemRow>();
  const byNameNorm = new Map<string, number>();
  for (const item of rows) {
    items.set(item.itemId, item);
    // Nomes repetem no catálogo (variantes do mesmo item); o primeiro ganha, que é o de
    // menor id e na prática o item base.
    if (!byNameNorm.has(item.nameNorm)) byNameNorm.set(item.nameNorm, item.itemId);
  }
  return { items, byNameNorm };
}

/** Publica um cache inteiro (boot, testes). */
export function setCache(server: Server, cache: Omit<MarketCache, "revision">): void {
  caches.set(server, { ...cache, revision: nextRevision() });
}

/**
 * Troca as ofertas de alguns itens. `null` (ou lista vazia) tira o item do "à venda".
 *
 * `inMarket` ganha os itens com oferta: aparecer à venda é a definição de "já passou pelo
 * mercado".
 */
export function applyTradingItems(server: Server, changes: Map<number, ListingRow[] | null>): void {
  if (changes.size === 0) return;
  const current = getCache(server);
  const listings = new Map(current.listings);
  let inMarket = current.inMarket;
  for (const [itemId, rows] of changes) {
    if (!rows || rows.length === 0) {
      listings.delete(itemId);
      continue;
    }
    listings.set(itemId, rows);
    if (!inMarket.has(itemId)) {
      if (inMarket === current.inMarket) inMarket = new Set(inMarket);
      inMarket.add(itemId);
    }
  }
  caches.set(server, { ...current, listings, inMarket, revision: nextRevision() });
}

/** Troca o agregado do site de alguns itens. */
export function applyPricePoints(server: Server, points: readonly PricePoint[]): void {
  if (points.length === 0) return;
  const current = getCache(server);
  const prices = new Map(current.prices);
  let inMarket = current.inMarket;
  for (const p of points) {
    prices.set(p.itemId, p);
    if (!inMarket.has(p.itemId)) {
      if (inMarket === current.inMarket) inMarket = new Set(inMarket);
      inMarket.add(p.itemId);
    }
  }
  caches.set(server, { ...current, prices, inMarket, revision: nextRevision() });
}

/** Anda o relógio de um dataset: a coleta fechou com cobertura suficiente. */
export function publishFreshness(
  server: Server,
  update: Partial<Pick<MarketCache, "tradingAt" | "tradingSnapshotId" | "marketAt" | "marketSnapshotId">>,
): void {
  const current = getCache(server);
  caches.set(server, { ...current, ...update, revision: nextRevision() });
}

/** Esquece tudo. Existe para os testes, que trocam de mundo. */
export function resetCaches(): void {
  caches.clear();
}
