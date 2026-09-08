/**
 * Roteador REST minúsculo sobre `node:http`.
 *
 * Sem framework porque não há o que um framework resolveria aqui: são doze rotas,
 * todas GET menos duas, e a resposta é sempre JSON. O projeto irmão (ro-mcp) segue o
 * mesmo caminho, e manter os dois iguais facilita mexer nos dois.
 *
 * Toda rota chama `core/` e devolve o objeto sem remodelar — é a mesma função que o
 * MCP chama, e é isso que faz os dois canais concordarem por construção.
 */

import type { Db } from "../store/port.js";

import { appraise } from "../core/appraise.js";
import type { Dataset } from "../core/datasets.js";
import {
  SEARCH_SORTS,
  isSearchSort,
  marketedIds,
  resolveItem,
} from "../core/items.js";
import { findDeals, topMovers } from "../core/movers.js";
import {
  DEFAULT_CHEAPEST,
  cheapestOffers,
  freshness,
  history,
  itemPrice,
  itemPrices,
  searchPrices,
} from "../core/prices.js";
import { sellCandidates, valueReplay } from "../core/replay.js";
import { nextTradingRun } from "../core/schedule.js";
import {
  EQUIP_SLOTS,
  FILTER_OPTIONS,
  ITEM_CATEGORIES,
  isCategory,
  isSlot,
} from "../core/taxonomy.js";
import { serviceStatus } from "../core/status.js";
import { SERVERS, parseServer, type Server } from "../core/servers.js";
import { config, tradingEveryMinFor } from "../config.js";
import { CACHE, etagFor, json, notModified, NO_STORE } from "../edge/respond.js";

export interface RouteContext {
  db: Db;
  request: Request;
  url: URL;
  /**
   * Quando o agendador vai coletar de novo, se houver agendador neste processo.
   *
   * Dependência explícita em vez de estado de módulo: assim a rota diz o que precisa, e
   * um teste consegue montar o servidor com ou sem agendador sem depender de ordem.
   */
  nextRun?: (dataset: Dataset, server: Server) => number | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const int = (url: URL, key: string, fallback: number): number => {
  const raw = url.searchParams.get(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Lê o corpo com teto.
 *
 * Sem streams do Node: `arrayBuffer()` já entrega tudo. O `content-length` é conferido
 * ANTES de ler, para um upload grande demais ser recusado sem ocupar memória — era o que o
 * `req.destroy()` fazia na versão anterior.
 */
export async function readBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `corpo maior que o limite de ${maxBytes} bytes`);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes) {
    throw new HttpError(413, `corpo maior que o limite de ${maxBytes} bytes`);
  }
  return bytes;
}

/**
 * Resolve uma referência de item vinda da URL (id ou nome).
 *
 * Ambiguidade vira 300 com os candidatos, não um chute: responder o preço do item
 * errado é pior que pedir para a pessoa escolher.
 */
function requireItem(server: Server, ref: string): number {
  const resolved = resolveItem(server, decodeURIComponent(ref));
  if (resolved.kind === "found") return resolved.item.itemId;
  if (resolved.kind === "ambiguous") {
    throw new HttpError(
      300,
      `"${ref}" casa com ${resolved.candidates.length} itens`,
      {
        candidates: resolved.candidates,
      },
    );
  }
  throw new HttpError(404, `item "${ref}" não encontrado`);
}

/**
 * Qual servidor a requisição está perguntando.
 *
 * Ausente vira FREYA para não quebrar quem já usa a API — e porque é o servidor com
 * histórico. Um valor desconhecido é 400 em vez de cair no padrão em silêncio: pedir
 * NIDOGG (com erro de digitação) e receber FREYA sem aviso seria pior.
 */
function serverOf(url: URL): Server {
  const raw = url.searchParams.get("server");
  const parsed = parseServer(raw);
  if (parsed === null) {
    throw new HttpError(400, `servidor '${raw}' não existe`, {
      servidores: SERVERS,
    });
  }
  return parsed;
}

/**
 * ETag de uma resposta de mercado.
 *
 * Identifica "mesma pergunta, mesmos dados": o par de snapshots do servidor mais a consulta
 * canônica. `tradingAgeMin` fica DE FORA de propósito — ele anda com o relógio dentro de um
 * mesmo snapshot, e incluí-lo faria o ETag mudar a cada segundo, que é o oposto do que ele
 * serve. É por isso também que ele é fraco (`W/`): o corpo muda, o dado não.
 *
 * Vale para as duas rotas que um cliente relê o tempo todo — `/ids`, que o site de visuais
 * busca a cada carregamento, e `/prices`, que a aba de favoritos consulta em laço. Nas duas
 * o corpo é grande e quase sempre idêntico ao anterior, que é exatamente o caso de um 304.
 */
function marketEtag(server: Server, url: URL): string {
  const { marketAt, tradingAt } = freshness(server);
  const query = [...url.searchParams]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return etagFor([server, marketAt, tradingAt, url.pathname, query]);
}

/**
 * Quando a próxima coleta de anúncios pousa.
 *
 * Numa função só porque duas rotas publicam o mesmo número — `/prices` e `/ids`. Com a
 * conta escrita duas vezes, mudar a cadência acertaria uma e deixaria a outra mentindo.
 */
function nextTradingAt(
  ctx: RouteContext,
  server: Server,
  tradingAt: number | null,
): number | null {
  return nextTradingRun(
    ctx.nextRun?.("trading", server) ?? null,
    tradingAt,
    // Por servidor: a cadência de `trading` pode diferir entre eles, e este número vira o
    // `max-age` que faz a aba dormir até a próxima coleta. Usar o do outro servidor faria
    // o navegador acordar cedo demais (desperdício) ou tarde demais (dado velho na tela).
    tradingEveryMinFor(server),
  );
}

/**
 * Devolve a `Response` da rota, ou `null` quando o caminho não é da API.
 *
 * `null` em vez de 404 aqui de propósito: quem decide o que fazer com "não é minha rota" é
 * o `worker.ts`, que ainda tem o asset estático para tentar depois.
 */
export async function handleApi(ctx: RouteContext): Promise<Response | null> {
  const { url, db } = ctx;
  const path = url.pathname;
  if (!path.startsWith("/api/v1/")) return null;

  const server = serverOf(url);

  const rest = path.slice("/api/v1/".length).replace(/\/+$/, "");
  const segments = rest.split("/");
  // HEAD é GET sem corpo, e o runtime já descarta o corpo na saída. Tratá-lo como método
  // desconhecido devolvia 404 para uma URL perfeitamente válida — o que quebra monitor de
  // uptime, `curl -I` e qualquer cliente que confira uma rota antes de baixá-la.
  const method = ctx.request.method === "HEAD" ? "GET" : ctx.request.method;

  // --- /items ---------------------------------------------------------
  if (segments[0] === "items" && segments.length === 1 && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const type = url.searchParams.get("type") ?? undefined;
    const slot = url.searchParams.get("slot") ?? undefined;

    // `q` deixou de ser obrigatório: filtrar só por tipo ou slot é uma pergunta
    // legítima ("todas as katars"). O que não dá é pedir tudo sem critério nenhum.
    if (!query && !type && !slot) {
      throw new HttpError(400, "informe 'q', 'type' ou 'slot'");
    }
    if (type !== undefined && !isCategory(type)) {
      throw new HttpError(400, `tipo '${type}' não existe`, {
        tipos: ITEM_CATEGORIES.map((c) => c.id),
      });
    }
    if (slot !== undefined && !isSlot(slot)) {
      throw new HttpError(400, `slot '${slot}' não existe`, {
        slots: EQUIP_SLOTS.map((s) => s.id),
      });
    }

    const sort = url.searchParams.get("sort") ?? "relevance";
    if (!isSearchSort(sort)) {
      throw new HttpError(400, `ordenação '${sort}' não existe`, {
        ordenacoes: SEARCH_SORTS,
      });
    }

    // Com preço em cada linha, e não só o `ItemBrief`: os campos são aditivos, então
    // ninguém que já consome esta rota quebra, e a tabela do site deixa de precisar de
    // uma segunda requisição por página. O MCP continua com a resposta enxuta —
    // `searchItems` não mudou.
    const result = searchPrices({
      server,
      query,
      type,
      slot,
      sort,
      desc: url.searchParams.get("dir") === "desc",
      limit: Math.min(int(url, "limit", 20), config.limits.maxResults),
      offset: int(url, "offset", 0),
      onlyInMarket: url.searchParams.get("all") !== "1",
      onlyForSale: url.searchParams.get("for_sale") === "1",
    });
    return json(
      200,
      { ...result, freshness: freshness(server) },
      { cache: CACHE.market },
    );
  }

  // As opções de filtro, para a interface não manter uma cópia da taxonomia. Uma lista
  // só: cada opção já carrega o `type` e/ou o `slot` que a busca aceita, então publicar
  // também os dois eixos crus seria mandar a mesma informação duas vezes.
  if (rest === "taxonomy" && method === "GET") {
    return json(200, { options: FILTER_OPTIONS }, { cache: CACHE.taxonomy });
  }

  if (segments[0] === "items" && segments.length >= 2 && method === "GET") {
    const itemId = requireItem(server, segments[1]!);

    if (segments.length === 2) {
      return json(
        200,
        {
          ...itemPrice(server, itemId, int(url, "offers", 5)),
          freshness: freshness(server),
        },
        { cache: CACHE.market },
      );
    }

    if (segments[2] === "history") {
      const bucket = url.searchParams.get("bucket");
      const days = int(url, "days", 30);
      // O agrupamento decide o TTL: a série diária só muda quando o rollup do dia fecha,
      // a horária acompanha a coleta. `core/prices.ts` escolhe `hour` sozinho quando a
      // janela é curta, então a conta é repetida aqui — mudar uma sem a outra faria a
      // resposta horária ser cacheada por uma hora.
      const hourly = bucket === "hour" || (bucket !== "day" && days <= 3);
      return json(
        200,
        {
          itemId,
          points: await history(db, server, {
            itemId,
            days,
            bucket: bucket === "hour" || bucket === "day" ? bucket : undefined,
          }),
        },
        { cache: hourly ? CACHE.historyHourly : CACHE.historyDaily },
      );
    }

    if (segments[2] === "offers") {
      return json(
        200,
        {
          itemId,
          offers: cheapestOffers(
            server,
            itemId,
            Math.min(int(url, "limit", 20), config.limits.maxResults),
          ),
          freshness: freshness(server),
        },
        { cache: CACHE.market },
      );
    }

    if (segments[2] === "appraise") {
      const price = int(url, "price", NaN);
      if (!Number.isFinite(price) || price <= 0) {
        throw new HttpError(
          400,
          "parâmetro 'price' é obrigatório e deve ser positivo",
        );
      }
      return json(
        200,
        {
          ...(await appraise(db, server, itemId, price)),
          freshness: freshness(server),
        },
        { cache: CACHE.market },
      );
    }
  }

  // --- listas globais --------------------------------------------------
  /**
   * Preço de vários itens numa chamada.
   *
   * Fora do bloco `segments[0] === "items"` de propósito: `/items/:item` já casa
   * `segments.length >= 2`, e `/items` sem `q` já é 400. Enfiar o lote num dos dois
   * obrigaria a adivinhar a intenção pelos parâmetros.
   */
  if (rest === "prices" && method === "GET") {
    const ids = [
      ...new Set(
        (url.searchParams.get("items") ?? "")
          .split(",")
          .map((raw) => Number(raw.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ];
    if (ids.length === 0) {
      throw new HttpError(
        400,
        "informe 'items' com uma lista de ids separados por vírgula",
      );
    }
    // 400 em vez do `Math.min` que as outras rotas usam. Cortar `limit` em silêncio só
    // devolve menos resultados; cortar uma lista de ids PEDIDOS deixaria o alerta do
    // 101º favorito sem avaliação, e ninguém saberia — é o mesmo raciocínio do
    // `serverOf` sobre não cair no padrão calado.
    if (ids.length > config.limits.maxBatchItems) {
      // O corpo carrega o teto para o cliente não precisar manter uma cópia da constante
      // — que ele não pode importar (a fronteira de tipo entre `web/` e `src/`).
      throw new HttpError(
        400,
        `no máximo ${config.limits.maxBatchItems} itens por chamada`,
        {
          pedidos: ids.length,
          maximo: config.limits.maxBatchItems,
        },
      );
    }

    const etag = marketEtag(server, url);
    const unchanged = notModified(ctx.request, etag);
    // A aba de favoritos relê esta rota em laço com a MESMA lista de ids: entre duas
    // coletas a resposta é byte a byte a anterior.
    if (unchanged) return unchanged;

    const atual = freshness(server);
    return json(
      200,
      {
        ...itemPrices(
          server,
          ids,
          Math.min(int(url, "offers", 0), DEFAULT_CHEAPEST),
        ),
        freshness: atual,
        // Deixa o cliente dormir até a coleta pousar em vez de perguntar em intervalo fixo.
        // Sem isto ele teria de escolher uma cadência no escuro — e qualquer escolha ou
        // desperdiça requisição ou atrasa o aviso.
        nextTradingAt: nextTradingAt(ctx, server, atual.tradingAt),
      },
      { cache: CACHE.market, etag },
    );
  }

  /**
   * Só os ids: o que já passou pelo mercado e o que está à venda agora.
   *
   * Para quem tem catálogo próprio e quer filtrá-lo — o simulador de visuais mostra
   * 1.494 visuais e precisa saber quais dá para comprar. Pela busca seriam dezenas de
   * páginas de `limit=100`, cada linha com preço e links que ele não usaria; aqui são
   * dois vetores de inteiros que o cliente guarda até `nextTradingAt`.
   *
   * Sem paginação de propósito: o corpo inteiro tem alguns milhares de números, e
   * paginar um conjunto que só faz sentido completo obrigaria o cliente a remontá-lo.
   */
  if (rest === "ids" && method === "GET") {
    const etag = marketEtag(server, url);
    const unchanged = notModified(ctx.request, etag);
    // Milhares de inteiros que quase nunca mudam entre duas coletas — o caso em que um
    // 304 economiza o corpo inteiro.
    if (unchanged) return unchanged;

    const atual = freshness(server);
    return json(
      200,
      {
        ...marketedIds(server),
        freshness: atual,
        nextTradingAt: nextTradingAt(ctx, server, atual.tradingAt),
      },
      { cache: CACHE.market, etag },
    );
  }

  if (rest === "movers" && method === "GET") {
    const dir = url.searchParams.get("dir");
    return json(
      200,
      {
        movers: await topMovers(db, server, {
          days: int(url, "days", 7),
          direction: dir === "up" || dir === "down" ? dir : "both",
          minStores: int(url, "min_stores", 3),
          minPrice: int(url, "min_price", 1000),
          limit: Math.min(int(url, "limit", 20), config.limits.maxResults),
        }),
        freshness: freshness(server),
      },
      { cache: CACHE.aggregate },
    );
  }

  if (rest === "deals" && method === "GET") {
    return json(
      200,
      {
        deals: await findDeals(db, server, {
          days: int(url, "days", 14),
          minDiscountPct: int(url, "min_discount", 25),
          minPrice: int(url, "min_price", 5000),
          limit: Math.min(int(url, "limit", 20), config.limits.maxResults),
        }),
        freshness: freshness(server),
      },
      { cache: CACHE.aggregate },
    );
  }

  if (rest === "snapshots" && method === "GET") {
    return json(200, await serviceStatus(db, server, int(url, "limit", 20)), {
      cache: CACHE.status,
    });
  }

  if (rest === "status" && method === "GET") {
    return json(200, await serviceStatus(db, server, 5), {
      cache: CACHE.status,
    });
  }

  // --- replay ----------------------------------------------------------
  if (rest === "replay" && method === "POST") {
    const body = await readBody(ctx.request, config.limits.replayBytes);
    if (body.length === 0)
      throw new HttpError(400, "envie o arquivo .rrf no corpo");
    const buf = body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    );

    let valuation;
    try {
      valuation = valueReplay(server, buf as ArrayBuffer);
    } catch (err) {
      throw new HttpError(
        422,
        `não foi possível ler o replay: ${(err as Error).message}`,
      );
    }

    return json(
      200,
      {
        ...valuation,
        // As mesmas opções que a ferramenta MCP expõe. Passar só `minValue` deixava
        // `includeEquipped` inalcançável pelo REST — a mesma função de core com duas
        // superfícies diferentes, que é exatamente o que a camada existe para evitar.
        sellCandidates: sellCandidates(valuation, {
          minValue: int(url, "min_value", 10_000),
          maxCompetition: int(url, "max_competition", 15),
          includeEquipped: url.searchParams.get("include_equipped") === "1",
        }),
      },
      { cache: NO_STORE },
    );
  }

  throw new HttpError(404, `rota ${method} ${path} não existe`);
}

export { json };
