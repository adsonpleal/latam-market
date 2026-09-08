/**
 * Cache dentro do Worker, chaveado pelo snapshot.
 *
 * A camada de borda (os cabeçalhos de `respond.ts`) já evita executar este Worker na maior
 * parte das vezes. Esta segunda camada cobre o que sobra, e cobre duas coisas que a
 * primeira não consegue:
 *
 *  1. **Recomputo entre isolates.** Um cache-miss na borda faz o Worker refazer a
 *     ordenação do conjunto inteiro (`searchItems`) ou o agregado sobre `listing_daily`
 *     (`movers`/`deals`, ~630 mil linhas varridas na janela de 90 dias). O memo que já
 *     existe em `core/movers.ts` resolve isso DENTRO de um isolate; entre isolates, não.
 *  2. **Ordem dos parâmetros.** `?q=elixir&limit=5` e `?limit=5&q=elixir` são a mesma
 *     pergunta, e a borda as trata como duas — ela chaveia pela URL crua.
 *
 * **Não há purge, e é de propósito.** A chave carrega o id do snapshot: quando a coleta
 * muda, a chave muda, e a entrada velha nunca mais é procurada. Assim a ingestão não
 * precisa de token da API da Cloudflare nem de uma chamada de purge que pode falhar em
 * silêncio.
 *
 * ## Por que o TTL sai da própria resposta
 *
 * Quase toda rota carrega `freshness` no corpo, e `tradingAgeMin` é calculado com o relógio
 * na hora de montar a resposta. Guardar isso por 24 horas — o que a chave por snapshot
 * permitiria — faria o serviço afirmar "coletado há 2 minutos" sobre um dado de ontem. É
 * exatamente o erro que o teto de 300 s da borda existe para limitar.
 *
 * Então o TTL daqui é lido do `s-maxage` que a própria rota declarou. Duas consequências,
 * as duas desejáveis: esta camada nunca serve nada mais velho do que a borda serviria, e
 * uma rota sem `freshness` no corpo (o histórico diário, a taxonomia) ganha automaticamente
 * o TTL longo que ela já pediu, sem vocabulário novo.
 */

import type { Server } from "../core/servers.js";

/**
 * Host sintético para as chaves.
 *
 * Nunca resolve, e não precisa: a Cache API usa a URL apenas como chave. Um host à parte do
 * real evita que uma entrada interna colida com a resposta pública da mesma rota.
 */
const KEY_HOST = "https://cache.latam-market.internal";

/**
 * A chave de uma resposta de mercado.
 *
 * `server` sai dos parâmetros e entra no caminho: assim ele não depende de ter sido escrito
 * na URL (as rotas tratam a ausência como FREYA) e as duas formas caem na mesma entrada,
 * que é o certo — são a mesma pergunta.
 */
export function snapshotKey(
  url: URL,
  server: Server,
  /**
   * Os DOIS ids de snapshot, e não só o de anúncios.
   *
   * Uma coleta de `market-price` muda o agregado publicado pelo site sem tocar no snapshot
   * de `trading` — o retrato é a união de dois datasets, cada um com a sua sequência. Com
   * só o de anúncios na chave, o preço médio novo ficava invisível até a coleta de lojas
   * seguinte, meia hora depois. Juntos, eles mudam em toda ingestão.
   */
  version: { trading: number | null; market: number | null },
): Request {
  const query = [...url.searchParams]
    .filter(([key]) => key !== "server")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");

  return new Request(
    `${KEY_HOST}/v1/${server}/${version.trading ?? "-"}.${version.market ?? "-"}` +
      `${url.pathname}${query ? `?${query}` : ""}`,
    { method: "GET" },
  );
}

/**
 * Os cabeçalhos públicos que viajam escondidos dentro da cópia guardada.
 *
 * A entrada precisa do PRÓPRIO `cache-control` para a Cache API saber quando expirá-la, e
 * esse valor não é o que o cliente deve ver. Guardar os originais sob outro nome e
 * restaurá-los na leitura é o que mantém as duas camadas independentes.
 */
const PRESERVED: ReadonlyArray<readonly [string, string]> = [
  ["x-cached-cache-control", "cache-control"],
  ["x-cached-edge-cache-control", "cloudflare-cdn-cache-control"],
];

/** O `s-maxage` que a rota declarou para a borda, ou `null` se ela não quis ser cacheada. */
function declaredEdgeTtl(response: Response): number | null {
  const edge = response.headers.get("cloudflare-cdn-cache-control");
  if (!edge) return null;
  const seconds = Number(/s-maxage=(\d+)/.exec(edge)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Responde do cache interno, ou produz e guarda.
 *
 * O que é guardado NÃO é o que é devolvido: a cópia interna leva o TTL declarado pela rota,
 * e a resposta ao cliente mantém os cabeçalhos originais. Devolver a cópia faria o navegador
 * herdar o TTL interno.
 */
export async function withSnapshotCache(
  key: Request,
  ctx: ExecutionContext,
  produce: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;

  const hit = await cache.match(key);
  if (hit) {
    const response = new Response(hit.body, hit);
    // Devolve os cabeçalhos PÚBLICOS, não os internos. A cópia guardada leva o TTL desta
    // camada em `cache-control` — é assim que a Cache API decide quando expirá-la — e sem
    // esta restauração o cliente herdaria esse TTL e a borda perderia a diretiva dela.
    for (const [internal, real] of PRESERVED) {
      const saved = response.headers.get(internal);
      if (saved === null) response.headers.delete(real);
      else response.headers.set(real, saved);
      response.headers.delete(internal);
    }
    // Marcador para dar como depurar um acerto sem abrir o painel.
    response.headers.set("x-snapshot-cache", "hit");
    return response;
  }

  const fresh = await produce();
  const ttl = declaredEdgeTtl(fresh);

  // Só 200 com TTL declarado entra. Um 400 ou 404 é barato de refazer, e guardá-lo faria um
  // erro transitório grudar no snapshot inteiro; um `no-store` disse explicitamente que não.
  if (fresh.status === 200 && ttl !== null) {
    const stored = new Response(fresh.clone().body, fresh);
    for (const [internal, real] of PRESERVED) {
      const value = stored.headers.get(real);
      if (value !== null) stored.headers.set(internal, value);
    }
    stored.headers.set("cache-control", `public, max-age=${ttl}`);
    stored.headers.delete("cloudflare-cdn-cache-control");
    // `waitUntil` para a gravação não segurar a resposta.
    ctx.waitUntil(cache.put(key, stored));
  }

  const response = new Response(fresh.body, fresh);
  response.headers.set("x-snapshot-cache", "miss");
  return response;
}
