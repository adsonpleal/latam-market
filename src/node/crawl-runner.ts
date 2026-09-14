/**
 * Uma coleta, do disparo à publicação.
 *
 * Sobe a worker thread do coletor (`collect/crawl-thread.mjs`), abre a sessão de ingestão e
 * encaminha cada lote de itens completos para ela conforme chegam. O prazo é duro: no fim
 * dele a thread recebe o pedido de parar, e se não parar, é terminada — uma coleta
 * pendurada não pode segurar o agendador, que foi exatamente como o serviço já ficou 34
 * minutos vivo sem coletar nada.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { CrawlReport, ItemBatch, KnownItem } from "../collect/port.js";
import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import { openCrawlSession, type FinalizeResult } from "../ingest/session.js";
import { getCache } from "../store/cache.js";
import type { WritableDb } from "../store/port.js";
import type { TradingRow } from "../store/rows.js";
import { stripSlotSuffix } from "../util/text.js";

export interface CrawlOutcome {
  dataset: Dataset;
  server: Server;
  durationMs: number;
  result: FinalizeResult | null;
  report: CrawlReport | null;
  aborted: boolean;
  error?: string;
}

export interface RunOptions {
  db: WritableDb;
  dataset: Dataset;
  server: Server;
  collectorPath: string;
  deadlineMs: number;
  /** Depois do pedido de parar, quanto esperar antes de terminar a thread. */
  graceMs?: number;
  offerMaxAgeMin?: number;
  /** Onde está a thread. Padrão: ver `defaultThreadUrl`. */
  threadUrl?: URL;
}

/**
 * O nome como o site o escreve, por item e servidor.
 *
 * O coletor decide que um item à venda SAIU quando um termo contido no nome dele terminou
 * sem devolvê-lo — e o nome que importa é o do site, não o do catálogo. Guardado a cada
 * coleta, a partir dos anúncios que chegam; antes da primeira, o do catálogo.
 */
const siteNames = new Map<Server, Map<number, string>>();

/**
 * A thread fica ao lado do bundle (`dist/crawl-thread.mjs`) em produção e em
 * `src/collect/` quando roda do código-fonte. Um caminho relativo só não serve os dois.
 */
function defaultThreadUrl(): URL {
  const beside = new URL("./crawl-thread.mjs", import.meta.url);
  return existsSync(fileURLToPath(beside)) ? beside : new URL("../collect/crawl-thread.mjs", import.meta.url);
}

export async function runCrawl(opts: RunOptions): Promise<CrawlOutcome> {
  const started = Date.now();
  const { dataset, server } = opts;
  const session = await openCrawlSession({
    db: opts.db,
    dataset,
    server,
    startedAt: Math.floor(started / 1000),
    crawlId: randomUUID(),
    offerMaxAgeMin: opts.offerMaxAgeMin,
  });

  const names = siteNames.get(server) ?? new Map<number, string>();
  siteNames.set(server, names);

  const cache = getCache(server);
  const known: KnownItem[] =
    dataset === "trading"
      ? [...cache.listings.keys()].flatMap((itemId) => {
          const name = names.get(itemId) ?? cache.items.get(itemId)?.name;
          return name ? [{ itemId, name }] : [];
        })
      : [];

  const threadUrl = opts.threadUrl ?? defaultThreadUrl();
  const worker = new Worker(threadUrl, {
    workerData: { collectorPath: opts.collectorPath, dataset, server, known },
    // O coletor segura páginas de mil linhas em voo; o teto protege a thread principal (e a
    // API) de uma coleta que vaze memória.
    resourceLimits: { maxOldGenerationSizeMb: 160 },
  });

  let report: CrawlReport | null = null;
  let error: string | undefined;
  let aborted = false;

  worker.on("message", (message: { type: string; batches?: ItemBatch[]; report?: CrawlReport; message?: string }) => {
    if (message.type === "items" && message.batches) {
      if (dataset === "trading") {
        for (const batch of message.batches) {
          const row = batch.rows[0] as TradingRow | undefined;
          if (row) names.set(batch.itemId, stripSlotSuffix(row.itemName));
        }
      }
      void session.applyItems(message.batches);
    } else if (message.type === "report" && message.report) {
      report = message.report;
    } else if (message.type === "error") {
      error = message.message;
    }
  });

  const exited = new Promise<number>((resolve) => {
    worker.on("error", (err) => {
      error ??= err.message;
    });
    worker.on("exit", resolve);
  });

  const graceMs = opts.graceMs ?? 60_000;
  let killTimer: NodeJS.Timeout | undefined;
  const deadline = setTimeout(() => {
    aborted = true;
    worker.postMessage({ type: "abort" });
    killTimer = setTimeout(() => void worker.terminate(), graceMs);
  }, opts.deadlineMs);

  await exited;
  clearTimeout(deadline);
  clearTimeout(killTimer);

  if (aborted && !error) error = `passou de ${opts.deadlineMs}ms`;
  const result = await session.finalize(report, aborted || report === null);
  return {
    dataset,
    server,
    durationMs: Date.now() - started,
    result,
    report,
    aborted,
    ...(error ? { error } : {}),
  };
}
