/**
 * O processo do serviço, na VM: API, MCP, interface e coleta.
 *
 * Um processo só, de propósito. A coleta precisa da saída de rede da máquina e o site
 * precisa do banco que a coleta grava; separados, um teria que falar com o outro pela rede
 * a cada item. Aqui a coleta grava e publica no mesmo instante, e a API lê da memória.
 *
 * O que protege a API de dividir o processo com a coleta:
 *  - o coletor roda numa worker thread (`collect/crawl-thread.mjs`);
 *  - as escritas vão em transações curtas com pausas (`ingest/session.ts`);
 *  - o atraso do laço de eventos é medido e aparece no `/healthz` e no journal.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { statSync } from "node:fs";

import { createApp } from "../app.js";
import { config, applyEnv } from "../config.js";
import { freshness } from "../core/prices.js";
import { DEFAULT_SERVER, SERVERS, type Server } from "../core/servers.js";
import type { Dataset } from "../core/datasets.js";
import { CATALOGUE_URL } from "../generated/catalogue.js";
import { getCache } from "../store/cache.js";
import { catalogueFromAsset, type CatalogueAsset } from "../store/catalogue.js";
import { nowSec, openDb } from "../store/db.js";
import { loadMarketFromDb } from "../store/load.js";
import { sqliteDb } from "../store/sqlite.js";
import { runCrawl, type CrawlOutcome } from "./crawl-runner.js";
import { createNodeServer } from "./http.js";
import { startMaintenance } from "./maintenance.js";
import { startScheduler, type Scheduler } from "./scheduler.js";
import { staticHandler } from "./static.js";

applyEnv(process.env);

const bootedAt = Date.now();
const raw = openDb({ path: config.dbPath, migrationsDir: config.migrationsDir });
const db = sqliteDb(raw);

// Uma coleta que o processo anterior não fechou (restart no meio) fica marcada como tal, em
// vez de parecer "em andamento" para sempre no /status.
raw
  .prepare(`UPDATE snapshot SET finished_at = ? WHERE ok = 0 AND finished_at IS NULL`)
  .run(nowSec());

const asset = JSON.parse(readFileSync(join(config.staticDir, CATALOGUE_URL), "utf8")) as CatalogueAsset;
const catalogue = catalogueFromAsset(asset);
for (const server of SERVERS) await loadMarketFromDb(db, catalogue, server);

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
setInterval(() => {
  const p99 = loop.percentile(99) / 1e6;
  if (p99 > 200) console.log(`[loop] atraso p99 ${Math.round(p99)}ms no último minuto`);
  loop.reset();
}, 60_000).unref();

const lastCrawl = new Map<string, Record<string, unknown>>();
let scheduler: Scheduler | null = null;

const app = createApp({
  db,
  staticFiles: staticHandler(config.staticDir),
  // O pouso, não o disparo: a aba de alertas dorme até este número (ver `nextLanding`).
  nextRun: (dataset: Dataset, server: Server) => scheduler?.nextLanding(dataset, server) ?? null,
  health: () => {
    const cache = getCache(DEFAULT_SERVER);
    return {
      uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
      dbMb: Math.round(dbSize() / 1024 / 1024),
      catalogueItems: cache.items.size,
      itensComPreco: cache.prices.size,
      itensComOferta: cache.listings.size,
      freshness: freshness(DEFAULT_SERVER),
      servidores: Object.fromEntries(
        SERVERS.map((s) => [s, { itensComOferta: getCache(s).listings.size, freshness: freshness(s) }]),
      ),
      crawl: { running: scheduler?.running() ?? null, last: Object.fromEntries(lastCrawl) },
    };
  },
});

const server = createNodeServer(app, {
  maxBodyBytes: (pathname) =>
    pathname === "/mcp" ? config.limits.mcpBodyBytes : config.limits.replayBytes,
});
server.listen(config.port, config.host, () => {
  console.log(`[boot] ouvindo em http://${config.host}:${config.port}`);
});

if (config.collectorPath && config.crawl.enabled) {
  scheduler = startScheduler(async (dataset, srv, deadlineMs) => {
    const outcome = await runCrawl({
      db,
      dataset,
      server: srv,
      collectorPath: config.collectorPath,
      deadlineMs,
      offerMaxAgeMin: config.offerMaxAgeMin,
    });
    lastCrawl.set(`${dataset}:${srv}`, summary(outcome));
    console.log(logLine(outcome));
  });
} else {
  console.log("[boot] coleta desligada (sem coletor configurado, ou CRAWL_ENABLED != 1)");
}

const maintenance = startMaintenance(db, raw);

function dbSize(): number {
  try {
    return statSync(config.dbPath).size;
  } catch {
    return 0;
  }
}

function summary(o: CrawlOutcome): Record<string, unknown> {
  return {
    at: Math.round((Date.now() - o.durationMs) / 1000),
    durationS: Math.round(o.durationMs / 1000),
    published: o.result?.published ?? 0,
    removed: o.result?.removed ?? 0,
    incomplete: o.result?.itemsIncomplete ?? 0,
    coverage: o.result ? Math.round(o.result.coverage * 100) / 100 : 0,
    ...(o.error ? { error: o.error } : {}),
  };
}

function logLine(o: CrawlOutcome): string {
  const r = o.result;
  const head = `[crawl] ${o.dataset}/${o.server}`;
  if (!r) return `${head} falhou: ${o.error ?? "sem resultado"}`;
  const secs = Math.round(o.durationMs / 1000);
  const cov = Math.round(r.coverage * 100);
  return (
    `${head}: ${r.published} itens publicados em ${secs}s ` +
    `(${r.rewritten} mudaram, ${r.removed} saíram, ${r.itemsIncomplete} incompletos, ` +
    `${r.expired} expirados, cobertura ${cov}%${r.fresh ? "" : ", relógio parado"}` +
    `${r.repetidas > 0 ? `, ${r.repetidas} repetida(s)` : ""}` +
    `${o.error ? `; ${o.error}` : ""})`
  );
}

/**
 * Encerramento limpo: o systemd manda SIGTERM e espera. A coleta em curso é cancelada (o que
 * ela já publicou está gravado), o servidor para de aceitar conexões, e o WAL é consolidado
 * antes de fechar o banco.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[boot] ${signal} — encerrando`);
    scheduler?.stop();
    maintenance.stop();
    server.close();
    server.closeIdleConnections();
    setTimeout(() => {
      try {
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        raw.close();
      } catch {
        // Fechando de qualquer jeito.
      }
      process.exit(0);
    }, 1_000).unref();
  });
}
