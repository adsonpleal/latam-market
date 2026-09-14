/**
 * O andaime da suíte de paridade: o serviço inteiro, em processo.
 *
 * `SELF.fetch` entra pelo MESMO `createApp` que o servidor publica, com um SQLite em memória
 * migrado pelos MESMOS arquivos de `migrations/` e o catálogo real gerado no `pretest`.
 * Sem porta aberta: o adaptador HTTP tem teste próprio (`node/__tests__/http.test.ts`), e
 * aqui o que se prova é o comportamento das rotas.
 *
 * A semeadura entra pela ingestão de verdade — a mesma sessão que a coleta usa, item a item.
 * Uma coleta semeada aqui é uma coleta LIMPA: todo item que não veio nela sai do "à venda",
 * que é o que o coletor faz no fim de uma varredura completa.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createApp } from "../app.js";
import type { ItemBatch } from "../collect/port.js";
import { applyEnv } from "../config.js";
import type { Dataset } from "../core/datasets.js";
import { SERVERS, type Server } from "../core/servers.js";
import { CATALOGUE_URL } from "../generated/catalogue.js";
import { openCrawlSession } from "../ingest/session.js";
import { getCache, resetCaches, setCache } from "../store/cache.js";
import { catalogueFromAsset, type CatalogueAsset } from "../store/catalogue.js";
import { openDb } from "../store/db.js";
import type { WritableDb } from "../store/port.js";
import type { Row } from "../store/rows.js";
import { sqliteDb } from "../store/sqlite.js";

const REPO = resolve(import.meta.dirname, "..", "..");

/** O host precisa estar na allowlist — é a mesma defesa contra DNS rebinding de produção. */
export const ORIGIN = "https://mercado.latam-tools.com.br";

let db: WritableDb | null = null;
let app: ((request: Request) => Promise<Response>) | null = null;

/** Um mundo novo: banco vazio migrado, catálogo real, mercado vazio. */
export async function applyMigrations(): Promise<void> {
  applyEnv({});
  db = sqliteDb(openDb({ path: ":memory:", migrationsDir: join(REPO, "migrations") }));
  const asset = JSON.parse(
    readFileSync(join(REPO, "web", "dist", CATALOGUE_URL), "utf8"),
  ) as CatalogueAsset;
  const catalogue = catalogueFromAsset(asset);
  resetCaches();
  for (const server of SERVERS) {
    setCache(server, {
      tradingSnapshotId: null,
      tradingAt: null,
      marketSnapshotId: null,
      marketAt: null,
      items: catalogue.items,
      byNameNorm: catalogue.byNameNorm,
      inMarket: new Set(),
      prices: new Map(),
      listings: new Map(),
    });
  }
  app = createApp({
    db,
    staticFiles: async () => new Response("interface fora do teste", { status: 404 }),
    health: () => ({ catalogueItems: getCache("FREYA").items.size }),
  });
}

/** O `fetch` do serviço, com HEAD sem corpo como o adaptador HTTP entrega. */
export const SELF = {
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    if (!app) throw new Error("applyMigrations() antes de usar o serviço");
    const response = await app(new Request(url, init));
    if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  },
};

export interface SeedCrawl {
  dataset: Dataset;
  server: Server;
  startedAt: number;
  crawlId: string;
  rows: Row[];
}

/**
 * Uma coleta completa pela sessão de ingestão real. Devolve as contagens que a coleta
 * produziria no journal.
 */
export async function ingest(crawl: SeedCrawl): Promise<Record<string, unknown>> {
  if (!db) throw new Error("applyMigrations() antes de semear");
  const session = await openCrawlSession({
    db,
    dataset: crawl.dataset,
    server: crawl.server,
    startedAt: crawl.startedAt,
    crawlId: crawl.crawlId,
    // O relógio da coleta, e não o de hoje: as datas dos cenários são de 2023, e com o
    // relógio real toda oferta semeada já nasceria expirada.
    now: () => crawl.startedAt,
    yieldTo: async () => {},
  });

  const byItem = new Map<number, Row[]>();
  for (const row of crawl.rows) {
    let rows = byItem.get(row.itemId);
    if (!rows) byItem.set(row.itemId, (rows = []));
    rows.push(row);
  }
  const batches: ItemBatch[] = [...byItem].map(([itemId, rows]) => ({ itemId, rows }));
  if (crawl.dataset === "trading") {
    for (const itemId of getCache(crawl.server).listings.keys()) {
      if (!byItem.has(itemId)) batches.push({ itemId, rows: [] });
    }
  }

  await session.applyItems(batches);
  const result = await session.finalize(
    {
      planned: 1,
      failures: 0,
      termsComplete: 1,
      termsFailed: 0,
      itemsPublished: byItem.size,
      itemsRemoved: 0,
      itemsIncomplete: 0,
    },
    false,
  );
  return {
    snapshotId: result.snapshotId,
    rows: crawl.rows.length,
    repetidas: result.repetidas,
    agrupadas: result.agrupadas,
    itens: byItem.size,
  };
}

export const getJson = async (path: string): Promise<unknown> =>
  (await SELF.fetch(`${ORIGIN}${path}`)).json();

export const getResponse = (path: string): Promise<Response> => SELF.fetch(`${ORIGIN}${path}`);

/** Status de uma requisição com outro host — a URL carrega o host, como o adaptador monta. */
export const statusFromHost = async (path: string, host: string): Promise<number> =>
  (await SELF.fetch(`https://${host}${path}`)).status;

async function mcp(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return parseMcpBody(await response.text(), response.headers.get("content-type") ?? "");
}

/** O corpo do MCP, seja JSON ou SSE. */
export function parseMcpBody(text: string, contentType: string): Record<string, unknown> {
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  if (!line) throw new Error(`SSE sem linha de dados: ${text.slice(0, 120)}`);
  return JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>;
}

/** Chama uma ferramenta do MCP e devolve o JSON que ela produziu. */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const body = (await mcp("tools/call", { name, arguments: args })) as {
    result?: { content: Array<{ text: string }> };
  };
  if (!body.result) throw new Error(`chamada a ${name} falhou: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0]!.text);
}

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { description?: string }> };
}

export async function listTools(): Promise<ToolInfo[]> {
  const body = (await mcp("tools/list")) as { result: { tools: ToolInfo[] } };
  return body.result.tools;
}

/** Um fixture `.rrf` como bytes. */
export function replayFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REPO, "src", "replay", "__tests__", "fixtures", name)));
}

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
