/**
 * O Worker: um ponto de entrada para os três canais.
 *
 * A ordem aqui é a mesma que o fragmento do Caddy garantia com `handle` mutuamente
 * exclusivos, e pelo mesmo motivo: o que é do serviço vem ANTES do arquivo estático, para
 * que nada em `web/dist` possa sequestrar `/api`, `/mcp` ou `/healthz`. Lá isso era ordem
 * de diretiva; aqui são duas coisas juntas — `run_worker_first` no `wrangler.jsonc`, que
 * decide quem é chamado, e esta função, que decide o que responde.
 */

import { handleApi, HttpError } from "./api/router.js";
import { applyEnv, config } from "./config.js";
import {
  allowlistCors,
  hostAllowed,
  json,
  NO_STORE,
  originAllowed,
  publicCors,
  withHeaders,
} from "./edge/respond.js";
import { snapshotKey, withSnapshotCache } from "./edge/cache.js";
import { runScheduled } from "./edge/cron.js";
import { handleIngest } from "./edge/ingest.js";
import { handleMcp } from "./mcp/handler.js";
import { freshness } from "./core/prices.js";
import { DEFAULT_SERVER, SERVERS, parseServer, type Server } from "./core/servers.js";
import { getCache } from "./store/cache.js";
import { hydrate } from "./store/hydrate.js";
import { d1Db } from "./store/d1.js";

/** Qual mercado a requisição precisa ter em memória antes de ser respondida. */
function serversFor(url: URL): Server[] {
  // O MCP escolhe o servidor DENTRO do corpo, por ferramenta, e o corpo ainda não foi
  // lido aqui. Hidratar os dois custa duas leituras de ponteiro num isolate quente, e é
  // o preço de não ter que espiar o JSON-RPC antes de despachá-lo.
  if (url.pathname === "/mcp" || url.pathname === "/healthz") return [...SERVERS];
  return [parseServer(url.searchParams.get("server")) ?? DEFAULT_SERVER];
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Primeira coisa, sempre: `config` nasce com os padrões e só o ambiente do binding
    // sabe o resto. Qualquer leitura de `config` antes disto veria o padrão.
    applyEnv(env as unknown as Record<string, unknown>);

    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/v1/");

    try {
      // Health check fica antes das allowlists: o smoke do deploy bate nele por IP, sem
      // passar pelo nome de domínio.
      if (url.pathname === "/healthz") return await healthz(env, url.origin);

      if (!hostAllowed(url)) {
        return json(403, { erro: `host "${url.hostname}" não autorizado` });
      }

      if (request.method === "OPTIONS") {
        const cors = isApi ? publicCors() : allowlistCors(request);
        return new Response(null, { status: 204, headers: cors });
      }

      // Antes das allowlists de origem: quem chama é o shipper, não um navegador, e a
      // autorização dele é a assinatura HMAC do corpo — não o cabeçalho `Origin`.
      if (url.pathname.startsWith("/internal/")) {
        if (url.pathname !== "/internal/ingest") return json(404, { erro: "rota não existe" });
        return await handleIngest(request, env);
      }

      if (url.pathname === "/mcp") {
        if (!originAllowed(request)) {
          return json(403, { erro: `origem "${request.headers.get("origin")}" não autorizada` });
        }
        await hydrateAll(env, url, ctx);
        const response = await handleMcp(request, d1Db(env.DB));
        return withHeaders(response, allowlistCors(request));
      }

      if (isApi) {
        // Só o replay manda corpo, e é o único /api que mantém a allowlist de origem.
        if (request.method === "POST" && !originAllowed(request)) {
          return json(403, { erro: `origem "${request.headers.get("origin")}" não autorizada` });
        }
        await hydrateAll(env, url, ctx);
        const route = (): Promise<Response | null> =>
          handleApi({ db: d1Db(env.DB), request, url });

        // A segunda camada de cache só entra no GET, e só quando o cliente NÃO mandou
        // `If-None-Match`: quem mandou está pedindo um 304, que o router responde sem
        // montar o corpo — e um 304 guardado seria servido a quem não tem a versão.
        // Um `?server=` inválido tem que virar 400, e quem decide isso é o router. Sem
        // esta guarda, a chave cairia no servidor padrão e serviria a resposta de FREYA
        // para quem digitou "NIDOGG" — exatamente o erro silencioso que `serverOf` existe
        // para evitar.
        const asked = parseServer(url.searchParams.get("server"));
        const cacheable =
          request.method === "GET" && !request.headers.has("if-none-match") && asked !== null;
        if (!cacheable) {
          const response = await route();
          if (response) return withHeaders(response, publicCors());
          return json(404, { erro: `rota ${request.method} ${url.pathname} não existe` });
        }

        const market = getCache(asked);
        const key = snapshotKey(url, asked, {
          trading: market.tradingSnapshotId,
          market: market.marketSnapshotId,
        });
        const cached = await withSnapshotCache(key, ctx, async () => {
          const response = await route();
          // `null` é "não é rota minha". Como a Cache API precisa de uma `Response`, o 404
          // é montado aqui dentro — e não é guardado, porque o `withSnapshotCache` só
          // guarda 200.
          return response ?? json(404, { erro: `rota GET ${url.pathname} não existe` });
        });
        return withHeaders(cached, publicCors());
      }

      // Nada casou: é a SPA. O `not_found_handling` do wrangler devolve o index para
      // qualquer caminho que não seja arquivo, que é o `try_files` do Caddy com outro nome.
      return await env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) {
        const body = json(err.status, { erro: err.message, ...err.extra });
        return isApi ? withHeaders(body, publicCors()) : body;
      }
      console.error("[worker] erro não tratado:", err);
      return json(500, { erro: "erro interno" });
    }
  },

  /**
   * Retenção e rollup diário.
   *
   * `waitUntil` porque a Cloudflare encerra a invocação quando o handler retorna: sem ele,
   * uma varredura que ainda está gravando seria cortada no meio.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    applyEnv(env as unknown as Record<string, unknown>);
    ctx.waitUntil(
      runScheduled(event.cron, env).catch((err: unknown) =>
        console.error("[cron] falhou:", err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

async function hydrateAll(env: Env, url: URL, ctx: ExecutionContext): Promise<void> {
  const servers = serversFor(url);
  // Um servidor sem coleta não pode derrubar a resposta do outro: `hydrate` só falha
  // quando o ponteiro aponta para um blob que sumiu, e nesse caso servir o retrato
  // anterior é melhor que devolver erro.
  const results = await Promise.allSettled(servers.map((s) => hydrate(env, url.origin, s)));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[hidratação]", result.reason);
      void ctx;
    }
  }
}

async function healthz(env: Env, origin: string): Promise<Response> {
  await Promise.allSettled(SERVERS.map((s) => hydrate(env, origin, s)));
  const cache = getCache(DEFAULT_SERVER);
  return json(
    200,
    {
      ok: true,
      // `uptimeSec` e `rssMb` sumiram junto com o processo longo: um isolate não tem
      // nem uma coisa nem outra, e inventar um número seria pior que não publicá-lo.
      catalogueItems: cache.items.size,
      itensComPreco: cache.prices.size,
      itensComOferta: cache.listings.size,
      freshness: freshness(DEFAULT_SERVER),
      // Um bloco por servidor: com dois mercados, um pode estar parado sem o outro
      // perceber. Só o que VARIA entre eles — o catálogo é do jogo e é o mesmo nos dois.
      servidores: Object.fromEntries(
        SERVERS.map((s) => [
          s,
          { itensComOferta: getCache(s).listings.size, freshness: freshness(s) },
        ]),
      ),
    },
    { cache: NO_STORE },
  );
}
