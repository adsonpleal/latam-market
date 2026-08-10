/**
 * Cache quente do snapshot mais recente.
 *
 * O mercado inteiro cabe em memória com folga (~5 mil itens agregados, ~20 mil
 * anúncios), então nenhuma leitura da API precisa tocar o disco. O banco existe para
 * o histórico e para sobreviver a restart, não para o caminho quente.
 *
 * A reconstrução monta um objeto NOVO e o publica numa atribuição só. Isso importa:
 * o worker do crawl termina no meio de requisições em andamento, e um leitor jamais
 * pode ver o índice pela metade. Como JS é single-threaded, a atribuição é o ponto
 * atômico — nenhum lock necessário.
 */

import type { DatabaseSync } from "node:sqlite";

import { SERVERS, type Server } from "../core/servers.js";
import {
  allItems,
  latestPricePoints,
  latestSnapshotId,
  listingsOfSnapshot,
  type ItemRow,
  type ListingRow,
  type PricePoint,
} from "./read.js";

export interface MarketCache {
  /** Quando o cache foi montado (epoch em segundos). */
  builtAt: number;
  /** Snapshot de origem de cada dataset, ou null se nunca houve um fechado. */
  marketSnapshotId: number | null;
  tradingSnapshotId: number | null;
  /** Quando cada dataset foi coletado — é o que `data_status` devolve. */
  marketAt: number | null;
  tradingAt: number | null;

  items: Map<number, ItemRow>;
  /**
   * Nome normalizado exato -> id.
   *
   * É o caminho dominante: o agente quase sempre repete um nome que leu numa resposta
   * anterior. Resolver isso varrendo os 14 mil nomes custa ~0,5 ms; pelo mapa, menos
   * de 0,001 ms. A varredura continua existindo para a busca parcial.
   */
  byNameNorm: Map<string, number>;
  prices: Map<number, PricePoint>;
  /** Anúncios por item, já ordenados por preço crescente. */
  listings: Map<number, ListingRow[]>;
}

const EMPTY: MarketCache = {
  builtAt: 0,
  marketSnapshotId: null,
  tradingSnapshotId: null,
  marketAt: null,
  tradingAt: null,
  items: new Map(),
  byNameNorm: new Map(),
  prices: new Map(),
  listings: new Map(),
};

/**
 * Um cache por servidor.
 *
 * A publicação atômica descrita no topo continua valendo, agora por entrada: o `set`
 * troca o cache de UM servidor por um objeto pronto, e quem estiver lendo o outro nem
 * percebe. Continua sem lock — a troca é uma operação só, e JS é single-threaded.
 */
const caches = new Map<Server, MarketCache>();

export function getCache(server: Server): MarketCache {
  return caches.get(server) ?? EMPTY;
}

function buildCache(db: DatabaseSync, server: Server): MarketCache {
  const marketSnapshotId = latestSnapshotId(db, "market-price", server);
  const tradingSnapshotId = latestSnapshotId(db, "trading", server);

  const items = new Map<number, ItemRow>();
  const byNameNorm = new Map<string, number>();
  for (const item of allItems(db, server)) {
    items.set(item.itemId, item);
    // Nomes repetem no catálogo (variantes do mesmo item); o primeiro ganha, que é
    // o de menor id e na prática o item base.
    if (!byNameNorm.has(item.nameNorm)) byNameNorm.set(item.nameNorm, item.itemId);
  }

  const prices = new Map<number, PricePoint>();
  let marketAt: number | null = null;
  if (marketSnapshotId !== null) {
    for (const p of latestPricePoints(db, marketSnapshotId)) {
      prices.set(p.itemId, p);
      marketAt = p.ts;
    }
  }

  const listings = new Map<number, ListingRow[]>();
  let tradingAt: number | null = null;
  if (tradingSnapshotId !== null) {
    // A query já vem ORDER BY item_id, price, então cada bucket sai ordenado de graça.
    for (const l of listingsOfSnapshot(db, tradingSnapshotId)) {
      let bucket = listings.get(l.itemId);
      if (!bucket) listings.set(l.itemId, (bucket = []));
      bucket.push(l);
    }
    tradingAt = snapshotStartedAt(db, tradingSnapshotId);
  }
  if (marketAt === null && marketSnapshotId !== null) {
    marketAt = snapshotStartedAt(db, marketSnapshotId);
  }

  return {
    builtAt: Math.floor(Date.now() / 1000),
    marketSnapshotId,
    tradingSnapshotId,
    marketAt,
    tradingAt,
    items,
    byNameNorm,
    prices,
    listings,
  };
}

function snapshotStartedAt(db: DatabaseSync, id: number): number | null {
  const row = db.prepare(`SELECT started_at FROM snapshot WHERE id = ?`).get(id) as
    | { started_at: number }
    | undefined;
  return row?.started_at ?? null;
}

/**
 * Reconstrói e publica um servidor. Chamado depois de cada snapshot fechado — só o
 * servidor que foi coletado, para não pagar a reconstrução do outro à toa.
 */
export function refreshCache(db: DatabaseSync, server: Server): MarketCache {
  const next = buildCache(db, server);
  caches.set(server, next);
  return next;
}

/** Reconstrói todos os servidores. É o caminho do boot. */
export function refreshAllCaches(db: DatabaseSync): void {
  for (const server of SERVERS) refreshCache(db, server);
}
