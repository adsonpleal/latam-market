/**
 * Consultas de leitura.
 *
 * Tudo que sai daqui filtra por `snapshot.ok = 1` — snapshot aberto (crawl em
 * andamento) ou abortado é invisível. Os tipos são a fronteira: `core/` só conhece
 * estas formas, nunca linhas cruas do SQLite.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";

export interface ItemRow {
  itemId: number;
  name: string;
  nameNorm: string;
  imgPath: string | null;
  dbType: string | null;
  slots: number | null;
  inMarket: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
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
export function latestSnapshotId(
  db: DatabaseSync,
  dataset: Dataset,
  server: Server,
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM snapshot
        WHERE dataset = ? AND server = ? AND ok = 1 AND source <> 'live'
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(dataset, server) as { id: number } | undefined;
  return row?.id ?? null;
}

export function listSnapshots(db: DatabaseSync, limit = 20): SnapshotRow[] {
  const rows = db
    .prepare(
      `SELECT id, server, dataset, started_at, finished_at, row_count, source
         FROM snapshot WHERE ok = 1 ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
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
 * O catálogo inteiro, com os fatos de mercado DAQUELE servidor.
 *
 * `LEFT JOIN` porque o catálogo é do jogo e existe nos dois servidores, enquanto
 * `item_market` só ganha linha quando o item aparece numa coleta. Sem o LEFT, um item
 * nunca anunciado em NIDHOGG sumiria da busca lá — e ele existe, só não está à venda.
 */
export function allItems(db: DatabaseSync, server: Server): ItemRow[] {
  const rows = db
    .prepare(
      `SELECT i.item_id, i.name, i.name_norm, i.img_path, i.db_type, i.slots,
              i.item_type, i.equip_slots,
              m.in_market, m.first_seen, m.last_seen
         FROM item i
         LEFT JOIN item_market m ON m.item_id = i.item_id AND m.server = ?`,
    )
    .all(server) as Array<Record<string, unknown>>;
  return rows.map(toItem);
}

function toItem(r: Record<string, unknown>): ItemRow {
  return {
    itemId: r["item_id"] as number,
    name: r["name"] as string,
    nameNorm: r["name_norm"] as string,
    imgPath: (r["img_path"] as string | null) ?? null,
    dbType: (r["db_type"] as string | null) ?? null,
    slots: (r["slots"] as number | null) ?? null,
    inMarket: (r["in_market"] as number) === 1,
    firstSeen: (r["first_seen"] as number | null) ?? null,
    lastSeen: (r["last_seen"] as number | null) ?? null,
    itemType: (r["item_type"] as string | null) ?? null,
    equipSlots: ((r["equip_slots"] as string | null) ?? "").split(",").filter(Boolean),
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
export function latestPricePoints(db: DatabaseSync, snapshotId: number): PricePoint[] {
  const rows = db
    .prepare(
      `SELECT item_id, ts, total_cnt, min_price, max_price, avg_price
         FROM price_point WHERE snapshot_id = ?`,
    )
    .all(snapshotId) as Array<Record<string, unknown>>;
  return rows.map(toPricePoint);
}

/** Anúncios de um snapshot, já ordenados por preço — é a ordem em que serão servidos. */
export function listingsOfSnapshot(db: DatabaseSync, snapshotId: number): ListingRow[] {
  const rows = db
    .prepare(
      `SELECT l.ssi, l.item_id, l.price, l.cnt, l.slot_max, l.map_id, s.name, s.seller
         FROM listing l JOIN store s ON s.id = l.store_id
        WHERE l.snapshot_id = ?
        ORDER BY l.item_id, l.price`,
    )
    .all(snapshotId) as Array<Record<string, unknown>>;
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
export function priceHistory(
  db: DatabaseSync,
  server: Server,
  itemId: number,
  fromTs: number,
  toTs: number,
): PricePoint[] {
  const rows = db
    .prepare(
      `SELECT item_id, ts, total_cnt, min_price, max_price, avg_price
         FROM price_point
        WHERE server = ? AND item_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`,
    )
    .all(server, itemId, fromTs, toTs) as Array<Record<string, unknown>>;
  return rows.map(toPricePoint);
}

export function listingHistory(
  db: DatabaseSync,
  server: Server,
  itemId: number,
  fromTs: number,
  toTs: number,
  bucket: "hour" | "day" = "day",
): StatsPoint[] {
  const sql =
    bucket === "day"
      ? `SELECT item_id, day AS ts, listings, units, min_price, p25, median, p75, max_price
           FROM listing_daily
          WHERE server = ? AND item_id = ? AND day >= ? AND day <= ? ORDER BY day`
      : `SELECT item_id, ts, listings, units, min_price, p25, median, p75, max_price
           FROM listing_stats
          WHERE server = ? AND item_id = ? AND ts >= ? AND ts <= ? ORDER BY ts`;
  const rows = db.prepare(sql).all(server, itemId, fromTs, toTs) as Array<
    Record<string, unknown>
  >;
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
export function baseline(
  db: DatabaseSync,
  server: Server,
  itemId: number,
  fromTs: number,
): { days: number; avgMedian: number; minSeen: number } | null {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS days, AVG(median) AS avg_median, MIN(min_price) AS min_seen
         FROM listing_daily WHERE server = ? AND item_id = ? AND day >= ?`,
    )
    .get(server, itemId, fromTs) as Record<string, unknown> | undefined;
  const days = (row?.["days"] as number) ?? 0;
  if (days === 0) return null;
  return {
    days,
    avgMedian: Math.round(row!["avg_median"] as number),
    minSeen: row!["min_seen"] as number,
  };
}
