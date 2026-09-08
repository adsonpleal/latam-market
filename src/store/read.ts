/**
 * Consultas de leitura.
 *
 * Tudo que sai daqui filtra por `snapshot.ok = 1` — snapshot aberto (crawl em
 * andamento) ou abortado é invisível. Os tipos são a fronteira: `core/` só conhece
 * estas formas, nunca linhas cruas do SQLite.
 */

import type { Db } from "./port.js";

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";

export interface ItemRow {
  itemId: number;
  name: string;
  nameNorm: string;
  imgPath: string | null;
  dbType: string | null;
  slots: number | null;
  /** Id de categoria derivado da descrição (ver `core/taxonomy.ts`). */
  itemType: string | null;
  /** Ids de slot de equipamento. Vazio quando não é equipamento. */
  equipSlots: string[];
}

export interface PricePoint {
  itemId: number;
  ts: number;
  totalCnt: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
}

export interface ListingRow {
  ssi: string;
  itemId: number;
  price: number;
  cnt: number;
  slotMax: string | null;
  storeName: string;
  seller: string;
  mapId: number | null;
}

export interface StatsPoint {
  itemId: number;
  ts: number;
  listings: number;
  units: number;
  minPrice: number;
  p25: number;
  median: number;
  p75: number;
  maxPrice: number;
}

export interface SnapshotRow {
  id: number;
  server: string;
  dataset: string;
  startedAt: number;
  finishedAt: number | null;
  rowCount: number;
  source: string;
}

/**
 * Id do snapshot fechado mais recente para um dataset.
 *
 * Exclui `source = 'live'` de propósito. A consulta ao vivo saiu na 0.6.0, então nada
 * produz essas linhas hoje — mas bancos antigos as têm, e cada uma cobria um item só. Se
 * entrasse aqui viraria "o retrato mais recente do mercado": um retrato em que todos os
 * outros 4 mil itens sumiram.
 */
export async function latestSnapshotId(
  db: Db,
  dataset: Dataset,
  server: Server,
): Promise<number | null> {
  const row = await db.first<{ id: number }>(
    `SELECT id FROM snapshot
        WHERE dataset = ? AND server = ? AND ok = 1 AND source <> 'live'
        ORDER BY started_at DESC LIMIT 1`,
    dataset,
    server,
  );
  return row?.id ?? null;
}

export async function listSnapshots(
  db: Db,
  limit = 20,
): Promise<SnapshotRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, server, dataset, started_at, finished_at, row_count, source
         FROM snapshot WHERE ok = 1 ORDER BY started_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    id: r["id"] as number,
    server: r["server"] as string,
    dataset: r["dataset"] as string,
    startedAt: r["started_at"] as number,
    finishedAt: (r["finished_at"] as number | null) ?? null,
    rowCount: r["row_count"] as number,
    source: r["source"] as string,
  }));
}

/**
 * O catálogo inteiro. Igual nos dois servidores, porque é do jogo.
 *
 * O `LEFT JOIN` com `item_market` que existia aqui saiu: "já apareceu no mercado" é fato
 * POR SERVIDOR e agora vive no `MarketCache`, num `Set` à parte (ver `inMarketIds`). O que
 * a separação compra é o catálogo poder ser carregado UMA vez e servir os dois servidores
 * — no Worker ele vem de um asset estático, e duplicá-lo por servidor custaria alguns MB
 * de um isolate que tem 128.
 */
export async function allItems(db: Db): Promise<ItemRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT item_id, name, name_norm, img_path, db_type, slots, item_type, equip_slots
       FROM item`,
  );
  return rows.map(toItem);
}

/** Ids que já apareceram no mercado DAQUELE servidor. */
export async function inMarketIds(db: Db, server: Server): Promise<Set<number>> {
  const rows = await db.all<{ item_id: number }>(
    `SELECT item_id FROM item_market WHERE server = ? AND in_market = 1`,
    server,
  );
  return new Set(rows.map((r) => r.item_id));
}

function toItem(r: Record<string, unknown>): ItemRow {
  return {
    itemId: r["item_id"] as number,
    name: r["name"] as string,
    nameNorm: r["name_norm"] as string,
    imgPath: (r["img_path"] as string | null) ?? null,
    dbType: (r["db_type"] as string | null) ?? null,
    slots: (r["slots"] as number | null) ?? null,
    itemType: (r["item_type"] as string | null) ?? null,
    equipSlots: ((r["equip_slots"] as string | null) ?? "")
      .split(",")
      .filter(Boolean),
  };
}

function toPricePoint(r: Record<string, unknown>): PricePoint {
  return {
    itemId: r["item_id"] as number,
    ts: r["ts"] as number,
    totalCnt: (r["total_cnt"] as number | null) ?? null,
    minPrice: (r["min_price"] as number | null) ?? null,
    maxPrice: (r["max_price"] as number | null) ?? null,
    avgPrice: (r["avg_price"] as number | null) ?? null,
  };
}

/** Agregados do market-price no snapshot mais recente. */
export async function latestPricePoints(
  db: Db,
  snapshotId: number,
): Promise<PricePoint[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT item_id, ts, total_cnt, min_price, max_price, avg_price
         FROM price_point WHERE snapshot_id = ?`,
    snapshotId,
  );
  return rows.map(toPricePoint);
}

/** Anúncios de um snapshot, já ordenados por preço — é a ordem em que serão servidos. */
export async function listingsOfSnapshot(
  db: Db,
  snapshotId: number,
): Promise<ListingRow[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT l.ssi, l.item_id, l.price, l.cnt, l.slot_max, l.map_id, s.name, s.seller
         FROM listing l JOIN store s ON s.id = l.store_id
        WHERE l.snapshot_id = ?
        ORDER BY l.item_id, l.price`,
    snapshotId,
  );
  return rows.map((r) => ({
    ssi: r["ssi"] as string,
    itemId: r["item_id"] as number,
    price: r["price"] as number,
    cnt: r["cnt"] as number,
    slotMax: (r["slot_max"] as string | null) ?? null,
    storeName: r["name"] as string,
    seller: r["seller"] as string,
    mapId: (r["map_id"] as number | null) ?? null,
  }));
}

/**
 * Série histórica de um item.
 *
 * Junta as duas fontes numa linha do tempo só: `price_point` é o agregado que o
 * próprio site publica, `listing_daily`/`listing_stats` é o que nós medimos dos
 * anúncios. As duas respondem perguntas diferentes e não devem ser somadas.
 */
export async function priceHistory(
  db: Db,
  server: Server,
  itemId: number,
  fromTs: number,
  toTs: number,
): Promise<PricePoint[]> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT item_id, ts, total_cnt, min_price, max_price, avg_price
         FROM price_point
        WHERE server = ? AND item_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
    server,
    itemId,
    fromTs,
    toTs,
  );
  return rows.map(toPricePoint);
}

export async function listingHistory(
  db: Db,
  server: Server,
  itemId: number,
  fromTs: number,
  toTs: number,
  bucket: "hour" | "day" = "day",
): Promise<StatsPoint[]> {
  const sql =
    bucket === "day"
      ? `SELECT item_id, day AS ts, listings, units, min_price, p25, median, p75, max_price
           FROM listing_daily
          WHERE server = ? AND item_id = ? AND day >= ? AND day <= ? ORDER BY day`
      : `SELECT item_id, ts, listings, units, min_price, p25, median, p75, max_price
           FROM listing_stats
          WHERE server = ? AND item_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`;
  const rows = await db.all<Record<string, unknown>>(
    sql,
    server,
    itemId,
    fromTs,
    toTs,
  );
  return rows.map((r) => ({
    itemId: r["item_id"] as number,
    ts: r["ts"] as number,
    listings: r["listings"] as number,
    units: r["units"] as number,
    minPrice: r["min_price"] as number,
    p25: r["p25"] as number,
    median: r["median"] as number,
    p75: r["p75"] as number,
    maxPrice: r["max_price"] as number,
  }));
}

/**
 * Estatística de referência de um item numa janela: a média das medianas diárias.
 *
 * É o número contra o qual `appraise` compara um preço proposto. Usa `listing_daily`
 * (que vive para sempre) em vez dos anúncios crus (que são apagados).
 */
export async function baseline(
  db: Db,
  server: Server,
  itemId: number,
  fromTs: number,
): Promise<{ days: number; avgMedian: number; minSeen: number } | null> {
  const row = await db.first<Record<string, unknown>>(
    `SELECT COUNT(*) AS days, AVG(median) AS avg_median, MIN(min_price) AS min_seen
         FROM listing_daily WHERE server = ? AND item_id = ? AND day >= ?`,
    server,
    itemId,
    fromTs,
  );
  const days = (row?.["days"] as number) ?? 0;
  if (days === 0) return null;
  return {
    days,
    avgMedian: Math.round(row!["avg_median"] as number),
    minSeen: row!["min_seen"] as number,
  };
}
