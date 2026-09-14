/**
 * Como uma resposta sai daqui: JSON, CORS e cache.
 *
 * O serviço roda numa VM pequena atrás do túnel da Cloudflare, e a borda é o que segura o
 * tráfego: um acerto de cache é servido do POP sem chegar à máquina. Cabeçalho de cache aqui
 * não é só latência — é CPU de uma máquina de um núcleo que não é gasta.
 *
 * `Cloudflare-CDN-Cache-Control` separa o TTL da borda do que o navegador vê — a
 * Cloudflare o consome e não o repassa, então o cliente só enxerga `Cache-Control`. Ele só
 * vale para caminhos que uma Cache Rule marca como cacheáveis (ver `infra/CUTOVER.md`).
 */

import { config } from "../config.js";

export interface CachePolicy {
  /** Segundos que o NAVEGADOR guarda. */
  browser: number;
  /** Segundos que a BORDA guarda. */
  edge: number;
  /** Serve o velho enquanto revalida por baixo. */
  swr?: number;
  /** Serve o velho se a origem cair. Barato e evita página em branco num incidente. */
  staleIfError?: number;
}

/**
 * Teto do TTL de borda para qualquer rota cujo corpo carregue `freshness`.
 *
 * Um minuto. A publicação é por item, conforme a coleta anda, então o mercado muda o tempo
 * todo — e a coleta é a cada 10 minutos. Cinco minutos de borda (o que valia com uma coleta
 * inteira a cada meia hora) esconderia metade de cada ciclo. O `tradingAgeMin` vai assado no
 * corpo; o cabeçalho `Age` dos acertos corrige: idade real = `tradingAgeMin*60 + Age`.
 */
export const FRESHNESS_EDGE_MAX = 60;

export const NO_STORE: CachePolicy = { browser: 0, edge: 0 };

/**
 * As políticas por tipo de rota, num lugar só.
 *
 * Nomeadas em vez de literais espalhados pelo router porque o que decide o TTL é a NATUREZA
 * do dado, não a rota: tudo que descreve "o mercado agora" envelhece junto, na coleta
 * seguinte. Uma rota nova escolhe uma destas e herda a decisão inteira, incluindo o teto de
 * 300 s que o `freshness` impõe.
 */
export const CACHE = {
  /**
   * Retrato do mercado: preço, oferta, busca, avaliação. Carrega `freshness`.
   *
   * `swr` curto de propósito. A aba de alertas acorda quando a coleta pousa e, se a coleta
   * atrasou, tenta de novo um minuto depois com a MESMA URL. Com 300 s de
   * stale-while-revalidate a borda devolvia a cópia de antes da coleta também na
   * retentativa, e o alerta atrasava um ciclo inteiro.
   */
  market: {
    browser: 30,
    edge: FRESHNESS_EDGE_MAX,
    swr: 30,
    staleIfError: 86_400,
  },
  /** Histórico por dia: só muda quando o rollup diário fecha. */
  historyDaily: { browser: 900, edge: 3_600, swr: 7_200, staleIfError: 86_400 },
  /** Histórico por hora: acompanha a coleta. */
  historyHourly: { browser: 30, edge: FRESHNESS_EDGE_MAX, swr: 300, staleIfError: 86_400 },
  /**
   * Agregados sobre `listing_daily` (movers, pechinchas). O memo deles é por hora, e a parte
   * das pechinchas que compara com as ofertas de agora é barata — então a borda pode segurar
   * mais que o mercado, sem passar de alguns minutos.
   */
  aggregate: { browser: 300, edge: 300, swr: 1_800, staleIfError: 86_400 },
  /** Saúde da coleta: é a rota que responde "o dado está fresco?" — cachear muito mente. */
  status: { browser: 15, edge: 15 },
  /** Taxonomia: muda em deploy, não em coleta. */
  taxonomy: { browser: 3_600, edge: 86_400 },
} satisfies Record<string, CachePolicy>;

function cacheControl(policy: CachePolicy): Record<string, string> {
  if (policy.browser === 0 && policy.edge === 0) return { "cache-control": "no-store" };

  const edge = [`public`, `s-maxage=${policy.edge}`];
  if (policy.swr) edge.push(`stale-while-revalidate=${policy.swr}`);
  if (policy.staleIfError) edge.push(`stale-if-error=${policy.staleIfError}`);

  return {
    "cache-control": `public, max-age=${policy.browser}`,
    "cloudflare-cdn-cache-control": edge.join(", "),
  };
}

/**
 * ETag fraco a partir do snapshot e da pergunta.
 *
 * Fraco (`W/`) de propósito: dentro de um mesmo snapshot o corpo ainda muda, porque o
 * `tradingAgeMin` anda com o relógio. Um ETag forte afirmaria byte a byte e seria mentira.
 * O que ele identifica de verdade é "mesma pergunta, mesmos dados", que é exatamente o que
 * um 304 precisa provar.
 */
export function etagFor(parts: ReadonlyArray<string | number | null>): string {
  let hash = 0x811c9dc5;
  for (const chunk of parts.map(String).join("|")) {
    hash ^= chunk.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${hash.toString(16)}"`;
}

export interface JsonOptions {
  cache?: CachePolicy;
  etag?: string;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, opts: JsonOptions = {}): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    ...cacheControl(opts.cache ?? NO_STORE),
    ...opts.headers,
  };
  if (opts.etag) headers["etag"] = opts.etag;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 304 quando o cliente já tem esta versão. Sem corpo, que é o ponto. */
export function notModified(request: Request, etag: string): Response | null {
  const seen = request.headers.get("if-none-match");
  if (seen === null) return null;
  // O cliente pode mandar vários, e um `W/` pode voltar sem o prefixo por proxies antigos.
  const matches = seen.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""));
  return matches ? new Response(null, { status: 304, headers: { etag } }) : null;
}

// --------------------------------------------------------------------------
// CORS
// --------------------------------------------------------------------------

const CORS_METHODS = "GET, POST, OPTIONS";
const CORS_HEADERS = "content-type, accept, mcp-session-id, mcp-protocol-version";

/**
 * Leitura pública é aberta; escrita continua na allowlist.
 *
 * `GET /api/v1/*` passa a responder `Access-Control-Allow-Origin: *`, sem `Vary: Origin`.
 * Dois motivos, nesta ordem:
 *
 *  1. `Vary: Origin` fragmenta o cache de borda por origem — o site de visuais, a SPA e o
 *     claude.ai passariam a manter três cópias da MESMA resposta pública.
 *  2. A allowlist de origem nunca foi um limite de acesso aqui: o dado é público e sem
 *     autenticação, e qualquer `curl` já o obtinha. Ela só decidia se um NAVEGADOR podia
 *     ler — e negar isso não protegia nada.
 *
 * O que continua valendo: a allowlist de HOST (que é defesa real contra DNS rebinding) em
 * todas as rotas, e a allowlist de ORIGEM nos dois POST — `/mcp` e `/api/v1/replay` — onde
 * o cliente manda um corpo e o cache não entra.
 */
export function publicCors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_HEADERS,
  };
}

export function allowlistCors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-methods": CORS_METHODS,
    "access-control-allow-headers": CORS_HEADERS,
  };
  if (origin !== null && config.allowedOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return headers;
}

/** Origem ausente é permitida: cliente de linha de comando não manda o cabeçalho. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin === null || config.allowedOrigins.includes(origin);
}

/**
 * DNS rebinding: um site hostil resolve o domínio para 127.0.0.1 e fala com o serviço.
 *
 * Lê o host da URL, e NÃO do cabeçalho `Host`. No Node o cabeçalho era a única fonte; no
 * runtime dos Workers ele nem sempre é exposto em `request.headers` — a autoridade vai para
 * `request.url`. A versão anterior lia o cabeçalho e recebia `null` sempre, o que
 * transformava a allowlist num 403 universal. Foi o primeiro teste rodando dentro do
 * `workerd` que mostrou isso; contra o servidor Node antigo o mesmo código passava.
 */
export function hostAllowed(url: URL): boolean {
  return config.allowedHosts.includes(url.hostname);
}

export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) out.headers.set(key, value);
  return out;
}
