/**
 * Camada HTTP: um `node:http` servindo `/api/v1/*`, `/mcp` e `/healthz`.
 *
 * O mesmo processo serve os dois canais de propósito — é o que faz a API e o MCP
 * lerem exatamente o mesmo cache, sem sincronização entre processos.
 *
 * Padrão herdado do projeto irmão (ro-mcp): allowlist de Host contra DNS rebinding,
 * allowlist de Origin para o navegador, e transporte stateless.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { handleApi, HttpError, json, readBody } from "../api/router.js";
import { freshness } from "../core/prices.js";
import { createMcpServer } from "../mcp/server.js";
import { getCache } from "../store/cache.js";
import { DEFAULT_SERVER, SERVERS, type Server as MarketServer } from "../core/servers.js";
import type { Dataset } from "../core/datasets.js";
import { config } from "./config.js";

const startedAt = Date.now();

/** DNS rebinding: um site hostil resolve seu domínio para 127.0.0.1 e fala com o serviço. */
function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0];
  return host !== undefined && config.allowedHosts.includes(host);
}

/** Origin ausente é permitido: clientes de linha de comando não mandam o cabeçalho. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || config.allowedOrigins.includes(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin !== undefined && config.allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, accept, mcp-session-id, mcp-protocol-version");
}

/**
 * O que o servidor precisa saber e não vem do banco.
 *
 * Hoje é só a hora da próxima coleta, que o agendador conhece e a API conta ao navegador.
 * Entra por parâmetro porque o agendador nasce DEPOIS do servidor (ver `server/index.ts`):
 * a alternativa seria um módulo de estado global só para o repasse, e aí a resposta da API
 * passaria a depender de quem escreveu nele primeiro.
 */
export interface ServerDeps {
  nextRun?: (dataset: Dataset, server: MarketServer) => number | null;
}

export function createHttpServer(db: DatabaseSync, deps: ServerDeps = {}): Server {
  return createServer((req, res) => {
    void handle(db, req, res, deps).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        json(res, err.status, { erro: err.message, ...err.extra });
        return;
      }
      console.error("[http] erro não tratado:", err);
      json(res, 500, { erro: "erro interno" });
    });
  });
}

async function handle(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Health check fica antes das allowlists: o systemd e o workflow de deploy batem
  // nele por IP, sem passar pelo nome de domínio.
  if (url.pathname === "/healthz") {
    const cache = getCache(DEFAULT_SERVER);
    json(res, 200, {
      ok: true,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      itens: cache.items.size,
      itensComPreco: cache.prices.size,
      itensComOferta: cache.listings.size,
      freshness: freshness(DEFAULT_SERVER),
      // Um bloco por servidor: com dois mercados, um pode estar parado sem o outro
      // perceber. Só o que VARIA entre eles — `itens` fica de fora porque o catálogo é
      // do jogo e o LEFT JOIN em item_market devolve o mesmo total para os dois.
      servidores: Object.fromEntries(
        SERVERS.map((s) => [
          s,
          { itensComOferta: getCache(s).listings.size, freshness: freshness(s) },
        ]),
      ),
    });
    return;
  }

  if (!hostAllowed(req)) {
    json(res, 403, { erro: `host "${req.headers.host}" não autorizado` });
    return;
  }
  if (!originAllowed(req)) {
    json(res, 403, { erro: `origem "${req.headers.origin}" não autorizada` });
    return;
  }

  if (url.pathname === "/mcp") {
    await handleMcp(db, req, res);
    return;
  }

  const handled = await handleApi({ db, req, res, url, nextRun: deps.nextRun });
  if (!handled) {
    json(res, 404, { erro: `rota ${req.method} ${url.pathname} não existe` });
  }
}

/**
 * MCP em Streamable HTTP sem sessão.
 *
 * `sessionIdGenerator: undefined` + `enableJsonResponse: true` fazem cada POST ser
 * autocontido. Uma tabela de sessões num processo com `MemoryMax` seria vazamento
 * lento esperando virar OOM — e não há nada de útil para guardar entre chamadas: o
 * estado caro é o cache do mercado, que é global e compartilhado.
 */
async function handleMcp(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    throw new HttpError(405, "o endpoint MCP aceita apenas POST");
  }

  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, config.limits.mcpBodyBytes)).toString("utf8"));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "corpo não é JSON válido");
  }

  const server = createMcpServer(db);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
