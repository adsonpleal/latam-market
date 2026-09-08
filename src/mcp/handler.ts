/**
 * O MCP sobre `fetch`.
 *
 * Antes era `StreamableHTTPServerTransport` recebendo `IncomingMessage`/`ServerResponse`
 * do Node — a única peça do MCP que não atravessava para o Worker. A v2 do SDK é
 * web-standard: `createMcpHandler` devolve algo que recebe `Request` e devolve `Response`,
 * e é stateless por construção, que é exatamente o modo em que este servidor já rodava
 * (`sessionIdGenerator: undefined` + `enableJsonResponse: true`).
 *
 * O que NÃO muda: as onze ferramentas, os schemas, o `servidor` injetado em todas e a
 * conversão de erro em `isError`. Só o transporte.
 */

import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";

import type { Db } from "../store/port.js";
import { createMcpServer } from "./server.js";

/**
 * Um handler por isolate, preso ao `db` que o criou.
 *
 * A comparação por identidade importa: o binding do D1 é o mesmo objeto durante a vida do
 * isolate, então na prática isto constrói uma vez. Memoizar sem a comparação capturaria o
 * `db` da PRIMEIRA requisição para sempre — que hoje daria certo por acidente, e deixaria
 * uma armadilha para o dia em que houver mais de uma origem de dados.
 */
let cached: { db: Db; handler: McpHttpHandler } | null = null;

export function handleMcp(request: Request, db: Db): Promise<Response> {
  if (cached?.db !== db) {
    cached = {
      db,
      handler: createMcpHandler(() => createMcpServer(db), {
        // Mantém os clientes de 2025 falando o protocolo antigo. É o que protege o
        // conector do claude.ai na travessia — ele não é reconfigurado no cutover.
        legacy: "stateless",
        // O equivalente exato do `enableJsonResponse: true` que o transporte antigo usava.
        // Sem isto o padrão é `auto`, e um cliente que aceita `text/event-stream` — o que
        // inclui o conector do claude.ai — passa a receber SSE. Não seria errado, mas
        // seria uma mudança de formato no meio de uma migração que promete não mudar
        // nenhum contrato; e o fragmento do Caddy tirava `text/event-stream` da compressão
        // justamente por isso ainda não ser o caso.
        responseMode: "json",
        onerror: (error) => console.error("[mcp]", error),
      }),
    };
  }
  return cached.handler.fetch(request);
}
