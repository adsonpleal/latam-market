/**
 * As escritas da ingestão, como statements para `WritableDb.batch`.
 *
 * Herdeiro de `store/d1-write.ts`, com duas mudanças que a VM permite e a publicação por item
 * exige:
 *
 *  - **Por item.** Cada função escreve UM item, e a sessão junta dezenas deles numa
 *    transação curta. As ofertas de agora entram aqui também, na mesma transação que as
 *    estatísticas: crash no meio não deixa uma coisa sem a outra.
 *  - **Parâmetros `?` anônimos**, nunca `?1`: o `node:sqlite` recusa parâmetro numerado
 *    ligado por posição. E nada de valor embutido no SQL — aquilo existia pelo limite de 100
 *    parâmetros do D1, e aqui só atrapalharia o cache de statements.
 */

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { SqlStatement, WritableDb } from "../store/port.js";
import type { ListingRow, PricePoint } from "../store/read.js";
import type { StatsRow } from "../store/rollup.js";
import type { SeenItem } from "./offers.js";

const DAY = 86_400;

/**
 * Abre (ou reencontra) o snapshot de uma coleta.
 *
 * `crawl_id` é `UNIQUE`: abrir de novo a mesma coleta devolve o mesmo id.
 */
export async function openSnapshot(
  db: WritableDb,
  input: { dataset: Dataset; server: Server; startedAt: number; crawlId: string },
): Promise<number> {
  const existing = await db.first<{ id: number }>(
    `SELECT id FROM snapshot WHERE crawl_id = ?`,
    input.crawlId,
  );
  if (existing) return existing.id;

  await db.run(
    `INSERT INTO snapshot (id, server, dataset, started_at, ok, source, crawl_id)
     VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM snapshot), ?, ?, ?, 0, 'crawl', ?)`,
    input.server,
    input.dataset,
    input.startedAt,
    input.crawlId,
  );
  const row = await db.first<{ id: number }>(
    `SELECT id FROM snapshot WHERE crawl_id = ?`,
    input.crawlId,
  );
  if (!row) throw new Error("snapshot não foi criado");
  return row.id;
}

export function finalizeSnapshot(
  id: number,
  input: {
    rowCount: number;
    itemsComplete: number;
    itemsIncomplete: number;
    coverage: number;
    finishedAt: number;
  },
): SqlStatement {
  return {
    sql: `UPDATE snapshot
             SET ok = 1, row_count = ?, finished_at = ?,
                 items_complete = ?, items_incomplete = ?, coverage = ?
           WHERE id = ?`,
    params: [
      input.rowCount,
      input.finishedAt,
      input.itemsComplete,
      input.itemsIncomplete,
      input.coverage,
      id,
    ],
  };
}

export function upsertItem(item: SeenItem): SqlStatement {
  return {
    // Não sobrescreve o nome: o do catálogo é o canônico, e o do mercado só preenche o que
    // o catálogo não tem.
    sql: `INSERT INTO item (item_id, name, name_norm, img_path, db_type)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (item_id) DO UPDATE SET
            img_path = COALESCE(excluded.img_path, item.img_path),
            db_type  = COALESCE(excluded.db_type, item.db_type)
           WHERE item.img_path IS NOT excluded.img_path
              OR item.db_type  IS NOT excluded.db_type`,
    params: [item.itemId, item.name, item.nameNorm, item.imgPath, item.dbType],
  };
}

export function touchItemMarket(server: Server, itemId: number, ts: number): SqlStatement {
  return {
    sql: `INSERT INTO item_market (item_id, server, in_market, first_seen, last_seen)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT (item_id, server) DO UPDATE SET in_market = 1, last_seen = excluded.last_seen`,
    params: [itemId, server, ts, ts],
  };
}

/**
 * A linha de `listing_stats` do item nesta coleta: grava, substitui ou apaga.
 *
 * Substitui porque o mesmo item pode ser entregue mais de uma vez na mesma coleta (um
 * anúncio novo apareceu no meio); apaga porque um item confirmado sem anúncio não tem
 * estatística nesta coleta, mesmo que uma entrega anterior tenha gravado uma.
 */
export function replaceItemStats(
  server: Server,
  ts: number,
  itemId: number,
  stats: StatsRow | null,
): SqlStatement {
  if (!stats) {
    return {
      sql: `DELETE FROM listing_stats WHERE server = ? AND item_id = ? AND ts = ?`,
      params: [server, itemId, ts],
    };
  }
  return {
    sql: `INSERT INTO listing_stats
            (server, item_id, ts, listings, units, min_price, p25, median, p75, max_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server, item_id, ts) DO UPDATE SET
            listings = excluded.listings, units = excluded.units,
            min_price = excluded.min_price, p25 = excluded.p25, median = excluded.median,
            p75 = excluded.p75, max_price = excluded.max_price`,
    params: [
      server, itemId, ts,
      stats.listings, stats.units, stats.minPrice, stats.p25, stats.median, stats.p75, stats.maxPrice,
    ],
  };
}

/**
 * Recalcula o dia do item em `listing_daily` a partir das coletas do dia.
 *
 * Por item, na hora da ingestão, e não num rollup de hora em hora sobre a tabela inteira:
 * a chave de `listing_stats` é `(server, item_id, ts)`, então o dia de UM item é uma faixa
 * da chave (no máximo uma linha por coleta), enquanto "o dia de todos" varria a tabela —
 * que a 10 minutos de cadência passa de 20 milhões de linhas.
 *
 * O diário guarda o MENOR mínimo do dia e a MÉDIA das medianas: o mínimo responde "qual foi
 * a melhor oferta que passou", e a média resiste a uma loja que abriu por dez minutos com
 * preço absurdo.
 */
export function rollupItemDay(server: Server, itemId: number, ts: number): SqlStatement[] {
  const day = Math.floor(ts / DAY) * DAY;
  return [
    {
      sql: `INSERT INTO listing_daily
              (server, item_id, day, listings, units, min_price, p25, median, p75, max_price)
            SELECT server, item_id, ?,
                   CAST(AVG(listings) AS INTEGER), CAST(AVG(units) AS INTEGER),
                   MIN(min_price),
                   CAST(AVG(p25) AS INTEGER), CAST(AVG(median) AS INTEGER),
                   CAST(AVG(p75) AS INTEGER), MAX(max_price)
              FROM listing_stats
             WHERE server = ? AND item_id = ? AND ts >= ? AND ts < ?
             GROUP BY server, item_id
            ON CONFLICT (server, item_id, day) DO UPDATE SET
              listings = excluded.listings, units = excluded.units,
              min_price = excluded.min_price, p25 = excluded.p25,
              median = excluded.median, p75 = excluded.p75, max_price = excluded.max_price`,
      params: [day, server, itemId, day, day + DAY],
    },
    {
      // O item ficou sem coleta com anúncio no dia (a única entrega de hoje foi um "sem
      // anúncio"): o dia some, em vez de guardar números de uma estatística apagada.
      sql: `DELETE FROM listing_daily
             WHERE server = ? AND item_id = ? AND day = ?
               AND NOT EXISTS (SELECT 1 FROM listing_stats
                                WHERE server = ? AND item_id = ? AND ts >= ? AND ts < ?)`,
      params: [server, itemId, day, server, itemId, day, day + DAY],
    },
  ];
}

/** Troca as ofertas de um item. Lista vazia remove o item do "à venda". */
export function replaceOffers(
  server: Server,
  itemId: number,
  listings: readonly ListingRow[],
  seenAt: number,
  snapshotId: number,
): SqlStatement[] {
  const out: SqlStatement[] = [
    { sql: `DELETE FROM offer WHERE server = ? AND item_id = ?`, params: [server, itemId] },
  ];
  if (listings.length === 0) {
    out.push({
      sql: `DELETE FROM offer_item WHERE server = ? AND item_id = ?`,
      params: [server, itemId],
    });
    return out;
  }
  for (const l of listings) {
    out.push({
      sql: `INSERT INTO offer (server, item_id, price, ssi, cnt, slot_max, store_name, seller, map_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [server, itemId, l.price, l.ssi, l.cnt, l.slotMax, l.storeName, l.seller, l.mapId],
    });
  }
  out.push(confirmOffers(server, itemId, seenAt, snapshotId));
  return out;
}

/** Só renova a confirmação: as ofertas não mudaram, não há o que regravar. */
export function confirmOffers(
  server: Server,
  itemId: number,
  seenAt: number,
  snapshotId: number,
): SqlStatement {
  return {
    sql: `INSERT INTO offer_item (server, item_id, seen_at, snapshot_id) VALUES (?, ?, ?, ?)
          ON CONFLICT (server, item_id) DO UPDATE SET
            seen_at = excluded.seen_at, snapshot_id = excluded.snapshot_id`,
    params: [server, itemId, seenAt, snapshotId],
  };
}

export function upsertPricePoint(server: Server, snapshotId: number, p: PricePoint): SqlStatement {
  return {
    sql: `INSERT INTO price_point
            (server, item_id, ts, snapshot_id, total_cnt, min_price, max_price, avg_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server, item_id, ts) DO UPDATE SET
            snapshot_id = excluded.snapshot_id,
            total_cnt = excluded.total_cnt, min_price = excluded.min_price,
            max_price = excluded.max_price, avg_price = excluded.avg_price`,
    params: [server, p.itemId, p.ts, snapshotId, p.totalCnt, p.minPrice, p.maxPrice, p.avgPrice],
  };
}

/** Quanto tempo cada coisa fica. */
export const RETENTION = {
  /** Estatística por coleta. É a maior tabela: uma linha por item por coleta. */
  statsDays: 30,
  /** Agregado do site. `history()` já limita a janela a 730 dias; nada lê além disso. */
  pricePointDays: 730,
};

/** A retenção de um item, como faixas de chave — nunca uma varredura da tabela inteira. */
export function sweepItem(server: Server, itemId: number, now: number): SqlStatement[] {
  return [
    {
      sql: `DELETE FROM listing_stats WHERE server = ? AND item_id = ? AND ts < ?`,
      params: [server, itemId, now - RETENTION.statsDays * DAY],
    },
    {
      sql: `DELETE FROM price_point WHERE server = ? AND item_id = ? AND ts < ?`,
      params: [server, itemId, now - RETENTION.pricePointDays * DAY],
    },
  ];
}
