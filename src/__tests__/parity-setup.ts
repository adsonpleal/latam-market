/**
 * O andaime da suíte de paridade, agora dentro do `workerd`.
 *
 * Antes isto subia um `createHttpServer` do Node em porta zero e falava com ele por
 * `fetch`. Provava o comportamento de um servidor que não existe mais em produção. Agora
 * `SELF.fetch` entra pelo MESMO `worker.ts` que é publicado, com D1 e R2 locais de verdade.
 *
 * A semeadura mudou junto, e para melhor: em vez de escrever direto no SQLite com
 * `beginSnapshot`/`writeRows`/`rollupListings`, cada cenário entra pela rota real de
 * ingestão. Com isso, montar o mundo do teste passa a exercitar as quatro peças mais
 * novas e menos provadas da migração — a assinatura HMAC, o rollup de percentis em JS, o
 * codificador do blob e a virada do ponteiro no R2 — em vez de contorná-las.
 */

import { env, SELF } from "cloudflare:test";
import { inject } from "vitest";

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { Row } from "../store/rows.js";
import { resetHydration } from "../store/hydrate.js";

/** Tem que bater com o binding declarado em `vitest.config.ts`. */
const INGEST_SECRET = "segredo-de-teste";

/** O host precisa estar na allowlist — é a mesma defesa contra DNS rebinding de produção. */
export const ORIGIN = "https://mercado.latam-tools.com.br";

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(INGEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export interface SeedCrawl {
  dataset: Dataset;
  server: Server;
  startedAt: number;
  /** Um por crawl. Repetir o mesmo é o teste de idempotência. */
  crawlId: string;
  rows: Row[];
}

/** Manda um crawl pela rota real de ingestão e devolve o que ela respondeu. */
export async function ingest(crawl: SeedCrawl): Promise<Record<string, unknown>> {
  const { rows, ...header } = crawl;
  const body = new TextEncoder().encode(
    [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join("\n"),
  );

  const timestamp = Math.floor(Date.now() / 1000);
  const digest = hex(await crypto.subtle.digest("SHA-256", body));
  const signature = await sign(`${timestamp}\n${crawl.crawlId}\n${digest}`);

  const response = await SELF.fetch(`${ORIGIN}/internal/ingest`, {
    method: "POST",
    headers: {
      "x-ingest-timestamp": String(timestamp),
      "x-ingest-crawl-id": crawl.crawlId,
      "x-ingest-signature": `sha256=${signature}`,
    },
    body,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`ingestão falhou (${response.status}): ${JSON.stringify(payload)}`);
  }
  // O isolate só reconfere o ponteiro do R2 a cada `POINTER_TTL_MS`. Em produção isso é
  // o que evita uma leitura por requisição; aqui esconderia do teste o snapshot que ele
  // mesmo acabou de publicar. Esquecer o que foi hidratado é o equivalente a "passou o
  // tempo" — e mantém a suíte determinística em vez de dependente de relógio.
  resetHydration();
  return payload;
}

/** Uma assinatura deliberadamente errada, para provar que a rota recusa. */
export async function ingestUnsigned(): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/internal/ingest`, { method: "POST", body: "{}" });
}

export const getJson = async (path: string): Promise<unknown> =>
  (await SELF.fetch(`${ORIGIN}${path}`)).json();

export const getResponse = (path: string): Promise<Response> => SELF.fetch(`${ORIGIN}${path}`);

/**
 * Status de uma requisição com outro `Host`.
 *
 * O helper anterior usava `node:http` cru porque `fetch` trata `host` como cabeçalho
 * proibido e o sobrescrevia em silêncio — o teste de DNS rebinding dava verde sem testar
 * nada. Com `SELF.fetch` o host vem da URL, então a defesa é exercitada de verdade e o
 * helper vira uma linha.
 */
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

/**
 * O corpo do MCP, seja JSON ou SSE.
 *
 * A v2 do SDK responde `text/event-stream` para cliente de 2025 — que é o que o
 * `legacy: "stateless"` serve, e o que o conector do claude.ai é. O transporte antigo
 * respondia JSON puro (`enableJsonResponse: true`). Os dois são Streamable HTTP válido e
 * todo cliente conforme aceita ambos, mas o teste tem que ler os dois para provar que a
 * paridade continua valendo independentemente do enquadramento.
 */
export function parseMcpBody(text: string, contentType: string): Record<string, unknown> {
  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  // Uma resposta por requisição: pega o primeiro `data:` e ignora o resto do enquadramento.
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

/** O catálogo de ferramentas que o MCP publica — nomes, descrições e schemas. */
export async function listTools(): Promise<ToolInfo[]> {
  const body = (await mcp("tools/list")) as { result: { tools: ToolInfo[] } };
  return body.result.tools;
}

/** Cria o schema no D1 local a partir do MESMO `migrations/` que o deploy aplica. */
export async function applyMigrations(): Promise<void> {
  const { applyD1Migrations } = await import("cloudflare:test");
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/**
 * Um fixture `.rrf` como bytes.
 *
 * Vem por `provide` do `vitest.config.ts` porque aqui dentro não existe `node:fs`. É a
 * mesma restrição do Worker publicado — o replay chega pelo corpo da requisição, nunca do
 * disco —, então o teste passa a exercitar o caminho de verdade.
 */
export function replayFixture(name: string): Uint8Array {
  const replays = inject("replays");
  const base64 = replays[name];
  if (!base64) throw new Error(`fixture ${name} não foi provido pelo vitest.config.ts`);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** Base64 de bytes. `Buffer` não existe aqui — é o mesmo motivo do fixture vir injetado. */
export const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));
