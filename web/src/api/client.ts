/**
 * Cliente da API.
 *
 * Caminhos relativos de propósito: em produção o Caddy serve esta SPA e a API na mesma
 * origem, então não há URL base para configurar, não há CORS e não há preflight — o
 * `content-type: application/octet-stream` do upload exigiria um, se fosse cruzado.
 */

import type {
  AppraiseResponse,
  DealsResponse,
  HistoryResponse,
  ItemBrief,
  ItemPriceResponse,
  MoversResponse,
  OffersResponse,
  PricesResponse,
  ReplayResponse,
  SearchResponse,
  SearchSort,
  ServiceStatus,
  TaxonomyResponse,
} from "./types.js";

/**
 * Teto do corpo, igual nos três lugares que precisam concordar: aqui,
 * `config.limits.replayBytes` no servidor e o `request_body max_size` do Caddy. A
 * fronteira de tipo entre `web/` e `src/` impede importar a constante do backend, e
 * buscá-la em runtime seria pior que repeti-la.
 */
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Preenchido no 300: o nome casou com mais de um item. */
    readonly candidates?: ItemBrief[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Mensagem para o usuário a partir de um erro qualquer.
 *
 * Existe para o `catch` não ser reescrito em cada tela: o backend já responde `{erro}`
 * em pt-BR, e o que sobra é o caso de nem ter chegado lá.
 */
export const messageOf = (err: unknown, fallback = "Não foi possível carregar."): string =>
  err instanceof ApiError ? err.message : fallback;

/**
 * Mensagem para os casos em que não vem `{erro}`.
 *
 * O 413 é o principal: quem recusa é o Caddy, pelo `request_body max_size`, antes de o
 * Node ver o corpo — e ele responde HTML. Por isso o `unwrap` não pode assumir JSON.
 */
function fallbackFor(status: number): string {
  switch (status) {
    case 413:
      return "O arquivo passa de 8 MB, que é o limite do serviço.";
    case 429:
    case 503:
      return "O serviço está ocupado agora. Tente de novo em alguns segundos.";
    case 502:
    case 504:
      return "O serviço não respondeu. Ele pode estar reiniciando — tente de novo.";
    case 403:
      return "Origem não autorizada. Rodando local, aponte o proxy para o backend local.";
    default:
      return `A API respondeu ${status}.`;
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;

  // 300 (nome ambíguo) não é `ok`. Só as rotas de item o produzem hoje, mas tratar aqui
  // faz a busca herdar o comportamento de graça.
  interface ErrorBody {
    erro?: string;
    candidates?: ItemBrief[];
  }
  let body: ErrorBody | null = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    // Corpo não-JSON (o HTML do Caddy no 413, por exemplo).
  }
  throw new ApiError(res.status, body?.erro ?? fallbackFor(res.status), body?.candidates);
}

/**
 * Servidor ativo, guardado entre sessões.
 *
 * Vive aqui, e não só no React, porque TODA requisição precisa dele — pendurar o
 * parâmetro em cada chamada deixaria uma esquecida para trás, e uma chamada sem
 * servidor devolve FREYA em silêncio: o pior tipo de erro, porque parece funcionar.
 */
const SERVER_KEY = "latam-market:server";
export const SERVERS = ["FREYA", "NIDHOGG"] as const;
export type Server = (typeof SERVERS)[number];

let activeServer: Server = (() => {
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    return SERVERS.find((s) => s === saved) ?? "FREYA";
  } catch {
    return "FREYA";
  }
})();

export const getServer = (): Server => activeServer;

export function setServer(server: Server): void {
  activeServer = server;
  try {
    localStorage.setItem(SERVER_KEY, server);
  } catch {
    // Modo privado sem storage: a escolha vale só para esta aba.
  }
}

async function get<T>(
  path: string,
  params?: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams(
    Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]),
  );
  search.set("server", activeServer);
  return unwrap<T>(await fetch(`/api/v1${path}?${search}`, signal ? { signal } : undefined));
}

export interface ReplayOptions {
  minValue?: number;
  maxCompetition?: number;
  includeEquipped?: boolean;
}

export async function postReplay(file: File, opts: ReplayOptions = {}): Promise<ReplayResponse> {
  // Checagem no cliente antes de gastar o upload: o Caddy cortaria a conexão no meio,
  // e a mensagem que sobra ("failed to fetch") não explica nada.
  if (file.size > MAX_REPLAY_BYTES) {
    throw new ApiError(413, fallbackFor(413));
  }

  const params = new URLSearchParams({
    server: activeServer,
    min_value: String(opts.minValue ?? 10_000),
    max_competition: String(opts.maxCompetition ?? 15),
    include_equipped: opts.includeEquipped ? "1" : "0",
  });

  const res = await fetch(`/api/v1/replay?${params}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  return unwrap<ReplayResponse>(res);
}

export interface SearchFilters {
  type?: string;
  slot?: string;
  all?: boolean;
  /** Só o que tem anúncio ativo na coleta mais recente. */
  forSale?: boolean;
  /**
   * Por qual coluna ordenar, no servidor.
   *
   * A busca pagina, então ordenar aqui no navegador ordenaria só o que já desceu — e a
   * resposta seria "o mais barato destes cinquenta" com cara de "o mais barato".
   */
  sort?: SearchSort;
  desc?: boolean;
}

export const SEARCH_PAGE = 50;

export const searchItems = (
  q: string,
  { type, slot, all, forSale, sort, desc }: SearchFilters = {},
  offset = 0,
  limit = SEARCH_PAGE,
): Promise<SearchResponse> =>
  get("/items", {
    q,
    limit,
    offset,
    all: all ? 1 : 0,
    for_sale: forSale ? 1 : 0,
    // Omitidos quando vazios: o backend recusa um tipo que não existe, e "" não existe.
    ...(type ? { type } : {}),
    ...(slot ? { slot } : {}),
    // `dir` só quando é decrescente: o backend testa `=== "desc"`, então mandar `asc`
    // seria repetir o padrão dele na URL.
    ...(sort ? { sort } : {}),
    ...(sort && desc ? { dir: "desc" } : {}),
  });

export const taxonomy = (): Promise<TaxonomyResponse> => get("/taxonomy");

export const itemPrice = (item: number | string, offers = 5): Promise<ItemPriceResponse> =>
  get(`/items/${encodeURIComponent(String(item))}`, { offers });

export const itemHistory = (item: number | string, days = 30): Promise<HistoryResponse> =>
  get(`/items/${encodeURIComponent(String(item))}/history`, { days });

export const itemOffers = (item: number | string, limit = 20): Promise<OffersResponse> =>
  get(`/items/${encodeURIComponent(String(item))}/offers`, { limit });

export const appraise = (item: number | string, price: number): Promise<AppraiseResponse> =>
  get(`/items/${encodeURIComponent(String(item))}/appraise`, { price });

export const topMovers = (days = 7, limit = 50): Promise<MoversResponse> =>
  get("/movers", { days, limit });

export const findDeals = (days = 14, limit = 50): Promise<DealsResponse> =>
  get("/deals", { days, limit });

export const serviceStatus = (): Promise<ServiceStatus> => get("/status");

/**
 * Teto de ids por chamada. Tem que bater com `config.limits.maxResults` no servidor, que
 * responde 400 — e não uma lista cortada — quando o pedido passa.
 */
const MAX_BATCH_ITEMS = 100;

/** Um ciclo do laço de alertas não pode ficar pendurado segurando o lease da aba. */
const BATCH_TIMEOUT_MS = 20_000;

/**
 * Preço de vários itens numa chamada.
 *
 * Existe para a aba Favoritos, que consulta em laço: com uma rota por item, trinta
 * favoritos custariam trinta requisições por ciclo contra um servidor pequeno.
 *
 * Acima de cem ids divide em blocos em vez de deixar o servidor recusar. Ninguém vigia
 * cem itens, mas quem chegar lá merece uma lista completa e mais lenta, não um erro.
 */
export async function batchPrices(itemIds: number[], offers = 1): Promise<PricesResponse> {
  const chunks: number[][] = [];
  for (let i = 0; i < itemIds.length; i += MAX_BATCH_ITEMS) {
    chunks.push(itemIds.slice(i, i + MAX_BATCH_ITEMS));
  }
  if (chunks.length === 0) throw new ApiError(400, "nenhum item para consultar");

  const parts = await Promise.all(
    chunks.map((ids) =>
      get<PricesResponse>(
        "/prices",
        { items: ids.join(","), offers },
        AbortSignal.timeout(BATCH_TIMEOUT_MS),
      ),
    ),
  );

  // `freshness` e `nextTradingAt` do primeiro bloco: é o mesmo servidor e a mesma coleta,
  // então repetir a leitura não traria informação nova.
  const first = parts[0]!;
  return {
    prices: parts.flatMap((p) => p.prices),
    missing: parts.flatMap((p) => p.missing),
    freshness: first.freshness,
    nextTradingAt: first.nextTradingAt,
  };
}
