/**
 * Uma coleta sendo gravada e publicada item a item.
 *
 * O coletor entrega cada item quando ele fica completo (ver `collect/port.ts`), e cada
 * entrega vira, numa transação curta: o catálogo e o "já visto", a estatística do item nesta
 * coleta, o dia do item em `listing_daily`, e as ofertas de agora. Assim que a transação
 * fecha, o item é publicado no cache — antes do fim da coleta.
 *
 * O que substitui o corte de 20% de falhas: não há mais descarte. Um termo que falha segura
 * só os itens que dependiam dele, que continuam com as ofertas que tinham. Dois freios
 * sobram:
 *
 *  - **o relógio** (`tradingAt`) só anda se a coleta cobriu ao menos 80% dos termos. Um
 *    `tradingAgeMin` baixo tem que continuar significando "o mercado inteiro foi olhado
 *    agora", não "alguns itens foram";
 *  - **expiração**: um item cujas ofertas ninguém confirma há `offerMaxAgeMin` (termos dele
 *    falhando coleta após coleta) sai do "à venda". Sem isso ele ficaria anunciado para
 *    sempre com um preço que já não existe.
 *
 * As transações são pequenas de propósito: o SQLite é síncrono e divide a thread com a API.
 * No máximo `CHUNK` itens por transação, com uma volta do laço de eventos entre elas.
 */

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { CrawlReport, ItemBatch } from "../collect/port.js";
import {
  applyPricePoints,
  applyTradingItems,
  getCache,
  publishFreshness,
} from "../store/cache.js";
import type { SqlStatement, WritableDb } from "../store/port.js";
import type { ListingRow, PricePoint } from "../store/read.js";
import type { MarketPriceRow, TradingRow } from "../store/rows.js";
import { statsFor } from "../store/rollup.js";
import { groupOffers, offersFingerprint, pricePoint, seenItem } from "./offers.js";
import {
  confirmOffers,
  finalizeSnapshot,
  openSnapshot,
  replaceItemStats,
  replaceOffers,
  rollupItemDay,
  touchItemMarket,
  upsertItem,
  upsertPricePoint,
} from "./writes.js";

/** Itens por transação. Mantém cada gravação na casa dos milissegundos. */
const CHUNK = 200;

/** Abaixo disto a coleta publica os itens que completou, mas o relógio não anda. */
export const MIN_COVERAGE = 0.8;

export interface SessionStats {
  /** Entregas recebidas (um item pode vir mais de uma vez). */
  deliveries: number;
  /** Itens distintos com oferta publicada nesta coleta. */
  published: number;
  /** Itens confirmados sem oferta nesta coleta. */
  removed: number;
  /** Itens cujas ofertas mudaram e foram regravadas. */
  rewritten: number;
  rows: number;
  repetidas: number;
  agrupadas: number;
}

export interface FinalizeResult extends SessionStats {
  snapshotId: number;
  coverage: number;
  /** O relógio do dataset andou? */
  fresh: boolean;
  /** Itens que saíram por falta de confirmação. */
  expired: number;
  itemsIncomplete: number;
}

export interface CrawlSession {
  readonly snapshotId: number;
  /** Grava e publica os itens entregues. Pode ser chamada sem esperar: as entregas enfileiram. */
  applyItems(batches: readonly ItemBatch[]): Promise<void>;
  /** Fecha a coleta. `report` null = o coletor morreu sem relatório. */
  finalize(report: CrawlReport | null, aborted: boolean): Promise<FinalizeResult>;
}

export interface SessionOptions {
  db: WritableDb;
  dataset: Dataset;
  server: Server;
  startedAt: number;
  crawlId: string;
  offerMaxAgeMin?: number;
  now?: () => number;
  /** Devolve o controle ao laço de eventos entre transações. Injetável para teste. */
  yieldTo?: () => Promise<void>;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function openCrawlSession(opts: SessionOptions): Promise<CrawlSession> {
  const { db, dataset, server, startedAt } = opts;
  const now = opts.now ?? ((): number => Math.floor(Date.now() / 1000));
  const yieldTo = opts.yieldTo ?? defaultYield;
  const offerMaxAgeMin = opts.offerMaxAgeMin ?? 120;

  const snapshotId = await openSnapshot(db, {
    dataset,
    server,
    startedAt,
    crawlId: opts.crawlId,
  });

  const stats: SessionStats = {
    deliveries: 0,
    published: 0,
    removed: 0,
    rewritten: 0,
    rows: 0,
    repetidas: 0,
    agrupadas: 0,
  };
  const publishedIds = new Set<number>();
  const removedIds = new Set<number>();

  // Uma fila só: entregas chegam da worker thread sem esperar a anterior terminar, e a ordem
  // importa — a segunda entrega do mesmo item tem que vencer a primeira.
  let queue: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    queue = queue.then(work).catch((err: unknown) => {
      // Um erro de banco não pode derrubar o resto da coleta: registra, guarda o primeiro,
      // e segue com as próximas entregas.
      failure ??= err;
      console.error(`[ingest] ${dataset}/${server}: falha gravando itens:`, err);
    });
    return queue;
  };

  const applyTrading = async (chunk: readonly ItemBatch[]): Promise<void> => {
    const statements: SqlStatement[] = [];
    const changes = new Map<number, ListingRow[] | null>();
    const cache = getCache(server);

    for (const batch of chunk) {
      const rows = batch.rows as TradingRow[];
      const { itemId } = batch;
      stats.rows += rows.length;

      if (rows.length === 0) {
        statements.push(
          replaceItemStats(server, startedAt, itemId, null),
          ...rollupItemDay(server, itemId, startedAt),
          ...replaceOffers(server, itemId, [], startedAt, snapshotId),
        );
        changes.set(itemId, null);
        removedIds.add(itemId);
        publishedIds.delete(itemId);
        continue;
      }

      const grouped = groupOffers(rows);
      stats.repetidas += grouped.repetidas;
      stats.agrupadas += grouped.agrupadas;

      statements.push(
        upsertItem(seenItem(rows[0]!)),
        touchItemMarket(server, itemId, startedAt),
        replaceItemStats(server, startedAt, itemId, statsFor(itemId, grouped.listings)),
        ...rollupItemDay(server, itemId, startedAt),
      );

      // Ofertas iguais às publicadas não são regravadas: a maioria dos itens não muda em dez
      // minutos, e reescrever 20 mil linhas por coleta para nada seria o grosso do trabalho.
      const previous = cache.listings.get(itemId);
      if (previous && offersFingerprint(previous) === offersFingerprint(grouped.listings)) {
        statements.push(confirmOffers(server, itemId, startedAt, snapshotId));
      } else {
        statements.push(...replaceOffers(server, itemId, grouped.listings, startedAt, snapshotId));
        changes.set(itemId, grouped.listings);
        stats.rewritten++;
      }
      publishedIds.add(itemId);
      removedIds.delete(itemId);
    }

    await db.batch(statements);
    applyTradingItems(server, changes);
  };

  const applyMarket = async (chunk: readonly ItemBatch[]): Promise<void> => {
    const statements: SqlStatement[] = [];
    const points: PricePoint[] = [];
    for (const batch of chunk) {
      const row = batch.rows[0] as MarketPriceRow | undefined;
      if (!row) continue;
      stats.rows += 1;
      const point = pricePoint(row, startedAt);
      points.push(point);
      statements.push(
        upsertItem(seenItem(row)),
        touchItemMarket(server, row.itemId, startedAt),
        upsertPricePoint(server, snapshotId, point),
      );
      publishedIds.add(row.itemId);
    }
    await db.batch(statements);
    applyPricePoints(server, points);
  };

  return {
    snapshotId,

    applyItems(batches) {
      if (batches.length === 0) return queue;
      stats.deliveries += batches.length;
      return enqueue(async () => {
        for (let i = 0; i < batches.length; i += CHUNK) {
          const chunk = batches.slice(i, i + CHUNK);
          if (dataset === "trading") await applyTrading(chunk);
          else await applyMarket(chunk);
          await yieldTo();
        }
      });
    },

    async finalize(report, aborted) {
      await queue;

      const terms = report ? report.termsComplete + report.termsFailed : 0;
      const coverage = report && terms > 0 ? report.termsComplete / terms : 0;
      const fresh = !aborted && failure === null && coverage >= MIN_COVERAGE;

      let expired = 0;
      if (dataset === "trading") {
        // Itens que nenhuma coleta confirma há tempo demais saem do "à venda".
        const cutoff = now() - offerMaxAgeMin * 60;
        const stale = await db.all<{ item_id: number }>(
          `SELECT item_id FROM offer_item WHERE server = ? AND seen_at < ?`,
          server,
          cutoff,
        );
        if (stale.length > 0) {
          await db.batch(stale.flatMap((r) => replaceOffers(server, r.item_id, [], startedAt, snapshotId)));
          applyTradingItems(server, new Map(stale.map((r) => [r.item_id, null])));
          expired = stale.length;
        }
      }

      stats.published = publishedIds.size;
      stats.removed = removedIds.size;
      const itemsIncomplete = report?.itemsIncomplete ?? 0;
      await db.batch([
        finalizeSnapshot(snapshotId, {
          rowCount: stats.rows,
          itemsComplete: publishedIds.size + removedIds.size,
          itemsIncomplete,
          coverage,
          finishedAt: now(),
        }),
      ]);

      if (fresh) {
        publishFreshness(
          server,
          dataset === "trading"
            ? { tradingAt: startedAt, tradingSnapshotId: snapshotId }
            : { marketAt: startedAt, marketSnapshotId: snapshotId },
        );
      }

      return { ...stats, snapshotId, coverage, fresh, expired, itemsIncomplete };
    },
  };
}
