/**
 * Caminho de escrita: catálogo, snapshots e ingestão das linhas coletadas.
 *
 * A dedupe por `ssi` / `itemId` vira aqui a chave primária das tabelas — `INSERT OR
 * REPLACE` resolve a sobreposição proposital da coleta sem precisar de um Set do lado do
 * processo.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { type Dataset } from "../core/datasets.js";
import { type Server } from "../core/servers.js";
import { LATAM_ITEMS_PATH } from "./paths.js";
import type { LatamItem, MarketPriceRow, Row, TradingRow } from "./rows.js";
// `core/taxonomy.ts` é um módulo folha, sem dependência de volta para `store/`, então
// esta seta não fecha ciclo — a classificação é regra de domínio e mora no core.
import { classify } from "../core/taxonomy.js";
import { normalizeName, stripSlotSuffix } from "../util/text.js";
import { nowSec, transact } from "./db.js";

export interface OpenSnapshot {
  id: number;
  dataset: Dataset;
  server: Server;
  startedAt: number;
}

export function beginSnapshot(
  db: DatabaseSync,
  dataset: Dataset,
  server: Server,
  // `live` não é mais produzido (a consulta ao vivo saiu na 0.6.0); continua aceito porque
  // o histórico em produção tem essas linhas e o teste de leitura precisa forjá-las.
  source: "crawl" | "import" | "live" = "crawl",
  startedAt = nowSec(),
): OpenSnapshot {
  const info = db
    .prepare(
      `INSERT INTO snapshot (server, dataset, started_at, source, ok) VALUES (?, ?, ?, ?, 0)`,
    )
    .run(server, dataset, startedAt, source);
  return { id: Number(info.lastInsertRowid), dataset, server, startedAt };
}

/**
 * Fecha o snapshot. Só aqui `ok` vira 1 — antes disso as linhas existem no banco mas
 * nenhum leitor as enxerga, então um crawl que morre no meio não publica dado parcial.
 *
 * `row_count` é contado do próprio banco, não acumulado por quem chamou. A coleta se
 * sobrepõe de propósito, então o mesmo anúncio é escrito várias vezes e colapsa na chave
 * primária: um contador de chamadas registrava 84.483 onde havia 3.869 linhas de verdade —
 * e esse número é publicado em `/api/v1/snapshots`. É por isso que esta função devolve a
 * contagem: para quem chamou não ter motivo de manter a própria.
 */
/** Fecha o snapshot e devolve quantas linhas ele realmente tem. */
export function finishSnapshot(db: DatabaseSync, snapshotId: number, dataset: Dataset): number {
  const table = dataset === "trading" ? "listing" : "price_point";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE snapshot_id = ?`)
    .get(snapshotId) as { n: number };

  db.prepare(`UPDATE snapshot SET finished_at = ?, row_count = ?, ok = 1 WHERE id = ?`).run(
    nowSec(),
    row.n,
    snapshotId,
  );
  // Devolvido porque é o único número honesto: somar o retorno de `writeRows` conta a
  // sobreposição da coleta (ver o comentário lá) e infla ~20x.
  return row.n;
}

/** Descarta um snapshot que não fechou (e tudo que ele gravou). */
export function abortSnapshot(db: DatabaseSync, snapshotId: number): void {
  transact(db, () => {
    db.prepare(`DELETE FROM listing WHERE snapshot_id = ?`).run(snapshotId);
    db.prepare(`DELETE FROM price_point WHERE snapshot_id = ?`).run(snapshotId);
    db.prepare(`DELETE FROM snapshot WHERE id = ?`).run(snapshotId);
  });
}

// --------------------------------------------------------------------------
// Catálogo
// --------------------------------------------------------------------------

/**
 * Carrega latam-items.json para a tabela `item`.
 *
 * Idempotente: preserva `in_market`, `first_seen` e `last_seen`, que vêm do mercado
 * e não do catálogo — reimportar o catálogo não pode apagar o que já foi observado.
 */
export function loadCatalogue(db: DatabaseSync, path = LATAM_ITEMS_PATH): number {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, LatamItem>;
  const stmt = db.prepare(
    `INSERT INTO item (item_id, name, name_norm, slots, aegis_name, item_type, equip_slots)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       name = excluded.name,
       name_norm = excluded.name_norm,
       slots = excluded.slots,
       aegis_name = excluded.aegis_name,
       item_type = excluded.item_type,
       equip_slots = excluded.equip_slots`,
  );

  return transact(db, () => {
    let n = 0;
    for (const [id, entry] of Object.entries(raw)) {
      const itemId = Number(id);
      if (!Number.isFinite(itemId)) continue;
      const name = stripSlotSuffix(entry.name);
      // `db_type` não entra aqui: ele só existe depois de o item aparecer numa coleta,
      // e a queda para ele acontece na leitura (ver `core/items.ts`).
      const { type, slots } = classify(name, entry.description, null);
      stmt.run(
        itemId,
        name,
        normalizeName(name),
        entry.slots ?? null,
        entry.aegisName ?? null,
        type,
        slots.length > 0 ? slots.join(",") : null,
      );
      n++;
    }
    return n;
  });
}

/**
 * Registra no catálogo os itens que o mercado devolveu.
 *
 * O site conhece itens que o catálogo não tem (e vice-versa), então uma linha de
 * mercado é fonte legítima de nome. Só não sobrescreve um nome que já veio do
 * catálogo — o do catálogo é o canônico.
 */
function upsertItemsFromRows(
  db: DatabaseSync,
  server: Server,
  rows: Row[],
  ts: number,
): void {
  prepare(db);

  for (const row of rows) {
    const name = stripSlotSuffix(row.itemName);
    itemStmt!.run(row.itemId, name, normalizeName(name), row.databaseImgPath, row.databaseType);
    itemMarketStmt!.run(row.itemId, server, ts, ts);
  }
}

// --------------------------------------------------------------------------
// Ingestão
// --------------------------------------------------------------------------

let marketStmt: StatementSync | null = null;
let listingStmt: StatementSync | null = null;
let storeStmt: StatementSync | null = null;
let storeSelect: StatementSync | null = null;
let itemStmt: StatementSync | null = null;
let itemMarketStmt: StatementSync | null = null;
let preparedFor: DatabaseSync | null = null;

function prepare(db: DatabaseSync): void {
  if (preparedFor === db) return;
  // O catálogo é do jogo: nome, ícone e tipo valem para os dois servidores.
  itemStmt = db.prepare(
    `INSERT INTO item (item_id, name, name_norm, img_path, db_type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       img_path = COALESCE(excluded.img_path, item.img_path),
       db_type  = COALESCE(excluded.db_type, item.db_type)`,
  );
  // "Visto no mercado" é por servidor.
  itemMarketStmt = db.prepare(
    `INSERT INTO item_market (item_id, server, in_market, first_seen, last_seen)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (item_id, server) DO UPDATE SET
       in_market  = 1,
       first_seen = COALESCE(item_market.first_seen, excluded.first_seen),
       last_seen  = excluded.last_seen`,
  );
  marketStmt = db.prepare(
    `INSERT INTO price_point (server, item_id, ts, snapshot_id, total_cnt, min_price, max_price, avg_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (server, item_id, ts) DO UPDATE SET
       total_cnt = excluded.total_cnt, min_price = excluded.min_price,
       max_price = excluded.max_price, avg_price = excluded.avg_price`,
  );
  listingStmt = db.prepare(
    `INSERT OR REPLACE INTO listing
       (snapshot_id, ssi, item_id, map_id, price, cnt, slot_max, store_type, store_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  storeStmt = db.prepare(`INSERT OR IGNORE INTO store (name, seller) VALUES (?, ?)`);
  storeSelect = db.prepare(`SELECT id FROM store WHERE name = ? AND seller = ?`);
  preparedFor = db;
}

/** Cache de (loja, vendedor) -> id, para não fazer dois statements por anúncio. */
const storeIds = new Map<string, number>();

function storeIdFor(name: string, seller: string): number {
  const key = `${name}\0${seller}`;
  const hit = storeIds.get(key);
  if (hit !== undefined) return hit;
  storeStmt!.run(name, seller);
  const row = storeSelect!.get(name, seller) as { id: number };
  storeIds.set(key, row.id);
  return row.id;
}

/**
 * Grava um lote de linhas dentro do snapshot aberto.
 *
 * Chame dentro de uma transação por unidade de crawl (<= 1000 linhas): mantém o write
 * lock em poucos milissegundos, o que é o que permite a API ler durante o crawl.
 */
export function writeRows(db: DatabaseSync, snap: OpenSnapshot, rows: Row[]): number {
  if (rows.length === 0) return 0;
  prepare(db);

  return transact(db, () => {
    upsertItemsFromRows(db, snap.server, rows, snap.startedAt);

    if (snap.dataset === "market-price") {
      for (const r of rows as MarketPriceRow[]) {
        marketStmt!.run(
          snap.server,
          r.itemId,
          snap.startedAt,
          snap.id,
          r.totalItemCnt,
          r.minItemPrice,
          r.maxItemPrice,
          r.avgItemPrice,
        );
      }
    } else {
      for (const r of rows as TradingRow[]) {
        listingStmt!.run(
          snap.id,
          r.ssi,
          r.itemId,
          r.mapId,
          r.itemPrice,
          r.itemCnt,
          // Este `||` faz trabalho de verdade, ao contrário dos `??` que havia aqui: o
          // site manda `""` quando o item não tem slot, e isso é NULL, não string vazia.
          r.slotMaxCount || null,
          r.storeTypeName,
          storeIdFor(r.storeName, r.itemSellerCharName),
        );
      }
    }
    return rows.length;
  });
}

// --------------------------------------------------------------------------
// Rollups
// --------------------------------------------------------------------------

/**
 * Consolida os anúncios de um snapshot em `listing_stats`.
 *
 * Os percentis saem em SQL puro com NTILE porque trazer 20 mil linhas para o
 * JavaScript só para ordenar seria mais lento que deixar o SQLite ordenar uma vez.
 * Cada anúncio conta uma vez, independente da quantidade — o preço é por unidade,
 * então uma loja com 300 unidades não deve dominar a mediana.
 */
export function rollupListings(db: DatabaseSync, snap: OpenSnapshot): number {
  const info = db
    .prepare(
      `WITH ranked AS (
         SELECT item_id, price, cnt,
                ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY price) - 1 AS rn,
                COUNT(*)     OVER (PARTITION BY item_id)                    AS n
         FROM listing WHERE snapshot_id = ?
       )
       INSERT OR REPLACE INTO listing_stats
         (server, item_id, ts, listings, units, min_price, p25, median, p75, max_price)
       SELECT ?, item_id, ?, MAX(n), SUM(cnt), MIN(price),
              MAX(CASE WHEN rn = (n - 1) / 4     THEN price END),
              MAX(CASE WHEN rn = (n - 1) / 2     THEN price END),
              MAX(CASE WHEN rn = (n - 1) * 3 / 4 THEN price END),
              MAX(price)
       FROM ranked GROUP BY item_id`,
    )
    .run(snap.id, snap.server, snap.startedAt);
  return Number(info.changes);
}

/**
 * Consolida `listing_stats` no dia correspondente.
 *
 * O diário guarda o MENOR mínimo do dia e a MÉDIA das medianas horárias: o mínimo
 * responde "qual foi a melhor oferta que passou", e a média das medianas resiste a uma
 * loja isolada que abriu por dez minutos com preço absurdo (ela mal mexe na mediana
 * daquela hora, e essa hora é uma de 24).
 */
export function rollupDaily(db: DatabaseSync, server: Server, day: number): number {
  const dayStart = Math.floor(day / 86400) * 86400;
  const info = db
    .prepare(
      `INSERT OR REPLACE INTO listing_daily
         (server, item_id, day, listings, units, min_price, p25, median, p75, max_price)
       SELECT ?, item_id, ?,
              CAST(AVG(listings) AS INTEGER), CAST(AVG(units) AS INTEGER),
              MIN(min_price),
              CAST(AVG(p25) AS INTEGER), CAST(AVG(median) AS INTEGER), CAST(AVG(p75) AS INTEGER),
              MAX(max_price)
       FROM listing_stats
        WHERE server = ? AND ts >= ? AND ts < ? GROUP BY item_id`,
    )
    .run(server, dayStart, server, dayStart, dayStart + 86400);
  return Number(info.changes);
}
