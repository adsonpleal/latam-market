/**
 * O caminho de escrita no D1.
 *
 * Separado de `store/write.ts` (que é `node:sqlite` síncrono, com statements preparados e
 * uma transação por lote) porque as restrições são outras: aqui não há statement
 * preparado que sobreviva ao isolate, o `batch` já é a transação, e **linha escrita é
 * cobrada** — inclusive `DELETE`, e inclusive a linha extra que cada índice grava.
 *
 * Três decisões saem daí, e as três valem dinheiro:
 *
 *  1. **Anúncios crus não entram.** Tinham um leitor só, sempre no snapshot mais recente;
 *     os 24 que a retenção guardava nunca eram lidos. Eles viram o blob no R2, e com isso
 *     saem ~120 M linhas/mês entre inserção, índice e o DELETE da retenção.
 *  2. **`item`/`item_market` são gravados por item DISTINTO**, não por anúncio. A versão
 *     do SQLite disparava dois upserts para cada uma das ~986 mil linhas diárias porque
 *     lá isso era de graça; aqui seriam ~90 M linhas/mês para gravar ~5 mil fatos.
 *  3. **Upsert com `WHERE`**: uma linha que não mudou não é reescrita. `INSERT OR REPLACE`
 *     não serve — é apagar-e-inserir, então cobra nos dois sentidos mesmo sem mudança.
 */

import type { SqlParam, SqlStatement, WritableDb } from "./port.js";
import type { Dataset } from "../core/datasets.js";
import { SERVERS, type Server } from "../core/servers.js";
import type { StatsRow } from "./rollup.js";
import type { PricePoint } from "./read.js";

export interface OpenedSnapshot {
  id: number;
  /** Verdadeiro quando este crawl já tinha sido ingerido — o chamador não repete nada. */
  duplicate: boolean;
}

/**
 * Abre (ou reencontra) o snapshot de um crawl.
 *
 * `crawl_id` é `UNIQUE`, então um reenvio depois de timeout devolve o mesmo id em vez de
 * abrir um segundo snapshot. É o que substitui o `abortSnapshot`: como nada é publicado
 * antes do ponteiro virar, não existe mais "metade gravada" para abortar.
 */
export async function openSnapshot(
  db: WritableDb,
  input: { dataset: Dataset; server: Server; startedAt: number; crawlId: string },
): Promise<OpenedSnapshot> {
  const existing = await db.first<{ id: number }>(
    `SELECT id FROM snapshot WHERE crawl_id = ?`,
    input.crawlId,
  );
  if (existing) return { id: existing.id, duplicate: true };

  // Id explícito em vez de AUTOINCREMENT: a retenção só apaga id baixo, nunca o maior,
  // então `max+1` não reusa nada. De quebra, sai o `sqlite_sequence` do import inicial.
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
  return { id: row.id, duplicate: false };
}

/** Fecha o snapshot. Só aqui ele ganha `ok = 1` e passa a ser visível para os leitores. */
export function closeSnapshot(id: number, rowCount: number, finishedAt: number): SqlStatement {
  return {
    sql: `UPDATE snapshot SET ok = 1, row_count = ?, finished_at = ? WHERE id = ?`,
    params: [rowCount, finishedAt, id],
  };
}

/** Um item visto no mercado, para o catálogo e para o "já apareceu aqui". */
export interface SeenItem {
  itemId: number;
  name: string;
  nameNorm: string;
  imgPath: string | null;
  dbType: string | null;
}

export function upsertItems(items: readonly SeenItem[]): SqlStatement[] {
  return items.flatMap((item) => [
    {
      // Não sobrescreve o nome: o do catálogo é o canônico, e o do mercado só preenche
      // o que o catálogo não tem.
      sql: `INSERT INTO item (item_id, name, name_norm, img_path, db_type)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (item_id) DO UPDATE SET
              img_path = COALESCE(excluded.img_path, item.img_path),
              db_type  = COALESCE(excluded.db_type, item.db_type)
             WHERE item.img_path IS NOT excluded.img_path
                OR item.db_type  IS NOT excluded.db_type`,
      params: [item.itemId, item.name, item.nameNorm, item.imgPath, item.dbType],
    },
  ]);
}

export function upsertItemMarket(
  server: Server,
  itemIds: readonly number[],
  ts: number,
): SqlStatement[] {
  return itemIds.map((itemId) => ({
    sql: `INSERT INTO item_market (item_id, server, in_market, first_seen, last_seen)
          VALUES (?, ?, 1, ?, ?)
          ON CONFLICT (item_id, server) DO UPDATE SET last_seen = excluded.last_seen`,
    params: [itemId, server, ts, ts] as SqlParam[],
  }));
}

/**
 * `listing_stats` do snapshot, com os valores embutidos no SQL.
 *
 * O D1 limita a **100 parâmetros vinculados por consulta**, e são dez colunas por linha —
 * dez linhas por statement, ~500 statements por coleta. Embutindo, cabem ~1000 linhas num
 * statement e a coleta inteira vira meia dúzia deles.
 *
 * Isso só é seguro porque TODO valor embutido é conferido: os nove numéricos por
 * `Number.isInteger` e o `server` contra o enum. Não é comentário de intenção — é a
 * asserção abaixo, e ela é a fronteira de injeção deste arquivo.
 */
export function insertStats(
  server: Server,
  ts: number,
  rows: readonly StatsRow[],
  perStatement = 1000,
): SqlStatement[] {
  if (!SERVERS.includes(server)) throw new Error(`servidor inesperado: ${String(server)}`);
  if (!Number.isInteger(ts)) throw new Error(`ts não é inteiro: ${String(ts)}`);

  const statements: SqlStatement[] = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const values = rows.slice(i, i + perStatement).map((r) => {
      const nums = [r.itemId, r.listings, r.units, r.minPrice, r.p25, r.median, r.p75, r.maxPrice];
      for (const n of nums) {
        if (!Number.isInteger(n)) throw new Error(`valor não inteiro em listing_stats: ${String(n)}`);
      }
      const [itemId, listings, units, minPrice, p25, median, p75, maxPrice] = nums;
      return `('${server}',${itemId},${ts},${listings},${units},${minPrice},${p25},${median},${p75},${maxPrice})`;
    });
    statements.push({
      sql:
        `INSERT INTO listing_stats
           (server, item_id, ts, listings, units, min_price, p25, median, p75, max_price)
         VALUES ${values.join(",")}
         ON CONFLICT (server, item_id, ts) DO NOTHING`,
    });
  }
  return statements;
}

/** `price_point`, com guarda: um agregado que não mudou não é reescrito. */
export function upsertPricePoints(
  server: Server,
  snapshotId: number,
  ts: number,
  points: readonly PricePoint[],
): SqlStatement[] {
  return points.map((p) => ({
    sql: `INSERT INTO price_point
            (server, item_id, ts, snapshot_id, total_cnt, min_price, max_price, avg_price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (server, item_id, ts) DO UPDATE SET
            snapshot_id = excluded.snapshot_id,
            total_cnt = excluded.total_cnt, min_price = excluded.min_price,
            max_price = excluded.max_price, avg_price = excluded.avg_price
           WHERE price_point.total_cnt IS NOT excluded.total_cnt
              OR price_point.min_price IS NOT excluded.min_price
              OR price_point.max_price IS NOT excluded.max_price
              OR price_point.avg_price IS NOT excluded.avg_price`,
    params: [
      server, p.itemId, ts, snapshotId,
      p.totalCnt, p.minPrice, p.maxPrice, p.avgPrice,
    ] as SqlParam[],
  }));
}

// --------------------------------------------------------------------------
// Trabalho agendado
// --------------------------------------------------------------------------

/**
 * Consolida `listing_stats` no dia correspondente.
 *
 * O diário guarda o MENOR mínimo do dia e a MÉDIA das medianas horárias: o mínimo responde
 * "qual foi a melhor oferta que passou", e a média das medianas resiste a uma loja isolada
 * que abriu por dez minutos com preço absurdo (ela mal mexe na mediana daquela hora, e essa
 * hora é uma de 24).
 *
 * Rodava a CADA coleta — 48 vezes por dia, por servidor, reescrevendo ~7 mil linhas todas
 * as vezes. No D1 isso seriam ~10 M linhas cobradas por mês para recalcular o mesmo dia
 * dezenas de vezes. Agora roda de hora em hora pelo Cron Trigger, e o `WHERE` do upsert faz
 * a linha que não mudou não ser reescrita.
 *
 * O efeito colateral é o dia CORRENTE ficar até uma hora atrasado. `movers` e `deals`
 * comparam medianas entre dias numa janela de 7 a 14 dias, então uma hora de atraso no
 * último ponto é invisível.
 */
export function rollupDaily(server: Server, day: number): SqlStatement {
  const dayStart = Math.floor(day / 86400) * 86400;
  return {
    sql: `INSERT INTO listing_daily
            (server, item_id, day, listings, units, min_price, p25, median, p75, max_price)
          SELECT ?1, item_id, ?2,
                 CAST(AVG(listings) AS INTEGER), CAST(AVG(units) AS INTEGER),
                 MIN(min_price),
                 CAST(AVG(p25) AS INTEGER), CAST(AVG(median) AS INTEGER),
                 CAST(AVG(p75) AS INTEGER), MAX(max_price)
            FROM listing_stats
           WHERE server = ?1 AND ts >= ?2 AND ts < ?3
           GROUP BY item_id
          ON CONFLICT (server, item_id, day) DO UPDATE SET
            listings = excluded.listings, units = excluded.units,
            min_price = excluded.min_price, p25 = excluded.p25,
            median = excluded.median, p75 = excluded.p75, max_price = excluded.max_price
           WHERE listing_daily.listings  IS NOT excluded.listings
              OR listing_daily.units     IS NOT excluded.units
              OR listing_daily.min_price IS NOT excluded.min_price
              OR listing_daily.p25       IS NOT excluded.p25
              OR listing_daily.median    IS NOT excluded.median
              OR listing_daily.p75       IS NOT excluded.p75
              OR listing_daily.max_price IS NOT excluded.max_price`,
    params: [server, dayStart, dayStart + 86400],
  };
}

/**
 * Quanto tempo cada coisa fica.
 *
 * O `listing` cru sumiu do banco — ele vive como blob no R2 e a retenção dele é por
 * contagem de snapshots, ali. Aqui sobrou o que é histórico de verdade.
 */
export const RETENTION = {
  /** Percentis por coleta. É a maior tabela e a que mais cresce. */
  statsDays: 30,
  /**
   * Agregado publicado pelo site.
   *
   * Dois anos porque `history()` já limita a janela a 730 dias — nada lê além disso, e a
   * tabela é a que mais cresce em disco depois de `listing_stats`. Sem teto, ela cresceria
   * para sempre guardando o que ninguém consulta.
   */
  pricePointDays: 730,
  /** Blobs de retrato no R2, por servidor. */
  snapshotBlobs: 24,
};

/**
 * Varre o histórico vencido.
 *
 * `DELETE` é cobrado como linha escrita no D1, então isto não é de graça — mas em regime é
 * proporcional ao que entrou, e o alternativa é a base crescer sem limite.
 *
 * Não há `PRAGMA incremental_vacuum` para chamar depois: o D1 administra as próprias
 * páginas. Se um dia a base fragmentar de verdade, a saída é exportar, criar um banco novo
 * e importar — uma janela de manutenção de uns dez minutos.
 */
export function sweepStatements(now: number): SqlStatement[] {
  return [
    {
      sql: `DELETE FROM listing_stats WHERE ts < ?`,
      params: [now - RETENTION.statsDays * 86400],
    },
    {
      sql: `DELETE FROM price_point WHERE ts < ?`,
      params: [now - RETENTION.pricePointDays * 86400],
    },
    {
      // O snapshot em si é uma linha por coleta: some junto com os percentis que ele
      // gerou, senão `/api/v1/snapshots` continuaria listando coletas sem dado nenhum.
      sql: `DELETE FROM snapshot WHERE dataset = 'trading' AND started_at < ?`,
      params: [now - RETENTION.statsDays * 86400],
    },
  ];
}
