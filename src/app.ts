/**
 * O serviço inteiro como uma função: `Request` → `Response`.
 *
 * A ordem é a mesma de sempre, e pelo mesmo motivo: o que é do serviço vem ANTES do
 * arquivo estático, para que nada em `web/dist` possa sequestrar `/api`, `/mcp` ou
 * `/healthz`. Era ordem de diretiva no Caddy, depois `run_worker_first` no Worker; aqui é a
 * ordem dos `if`.
 *
 * Não conhece Node: recebe e devolve objetos da Web, e o que é de runtime (arquivos, saúde
 * do processo, agendador) chega por parâmetro. É o que deixa os testes chamarem o serviço
 * inteiro sem abrir porta, e o adaptador HTTP (`node/http.ts`) ser só tradução.
 */

import { handleApi, HttpError } from "./api/router.js";
import type { Dataset } from "./core/datasets.js";
import type { Server } from "./core/servers.js";
import {
  allowlistCors,
  hostAllowed,
  json,
  NO_STORE,
  originAllowed,
  publicCors,
  withHeaders,
} from "./edge/respond.js";
import { handleMcp } from "./mcp/handler.js";
import type { Db } from "./store/port.js";

export interface AppDeps {
  db: Db;
  /** Arquivos da interface. `null` quando o caminho não é um arquivo (e não é da SPA). */
  staticFiles: (request: Request, url: URL) => Promise<Response>;
  /** O corpo do `/healthz`. */
  health: () => Record<string, unknown>;
  nextRun?: (dataset: Dataset, server: Server) => number | null;
}

export function createApp(deps: AppDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/v1/");

    try {
      // Antes das allowlists: o monitor e o deploy batem aqui pelo endereço local.
      if (url.pathname === "/healthz") {
        return json(200, { ok: true, ...deps.health() }, { cache: NO_STORE });
      }

      if (!hostAllowed(url)) {
        return json(403, { erro: `host "${url.hostname}" não autorizado` });
      }

      if (request.method === "OPTIONS") {
        const cors = isApi ? publicCors() : allowlistCors(request);
        return new Response(null, { status: 204, headers: cors });
      }

      if (url.pathname === "/mcp") {
        if (!originAllowed(request)) {
          return json(403, { erro: `origem "${request.headers.get("origin")}" não autorizada` });
        }
        const response = await handleMcp(request, deps.db);
        return withHeaders(response, allowlistCors(request));
      }

      if (isApi) {
        // Só o replay manda corpo, e é o único /api que mantém a allowlist de origem.
        if (request.method === "POST" && !originAllowed(request)) {
          return json(403, { erro: `origem "${request.headers.get("origin")}" não autorizada` });
        }
        const response = await handleApi({ db: deps.db, request, url, nextRun: deps.nextRun });
        if (response) return withHeaders(response, publicCors());
        return withHeaders(
          json(404, { erro: `rota ${request.method} ${url.pathname} não existe` }),
          publicCors(),
        );
      }

      return await deps.staticFiles(request, url);
    } catch (err) {
      if (err instanceof HttpError) {
        const body = json(err.status, { erro: err.message, ...err.extra });
        return isApi ? withHeaders(body, publicCors()) : body;
      }
      console.error("[http] erro não tratado:", err);
      return json(500, { erro: "erro interno" });
    }
  };
}
