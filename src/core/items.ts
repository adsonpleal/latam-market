/**
 * Busca e resolução de itens.
 *
 * Tudo sai do cache quente, por dois caminhos com custos bem diferentes:
 *
 *  - **nome exato** resolve por mapa, em ~0,001 ms. É o caminho dominante, porque o
 *    agente quase sempre repete um nome que leu numa resposta anterior.
 *  - **busca parcial** varre os 14 mil nomes com `indexOf`: 0,5 ms para um termo
 *    específico, ~2 ms para um de uma letra. Aceitável para uma busca de verdade, e
 *    barato o bastante para não valer FTS5 nem índice invertido.
 */

import type { Server } from "./servers.js";
import type { ItemRow } from "../store/read.js";
import { type MarketCache, getCache } from "../store/cache.js";
import { quantileIndex } from "../util/stats.js";
import { normalizeName } from "../util/text.js";
import { linksFor } from "./links.js";
import { fallbackType } from "./taxonomy.js";
import type { ItemBrief } from "./types.js";

/**
 * Categoria do item, com a queda para o tipo grosseiro que o site publica.
 *
 * A descrição classifica 98% do que já apareceu no mercado; o `db_type` cobre parte do
 * resto. As duas fontes chegam em momentos diferentes, então a junção acontece aqui,
 * na leitura, e não gravada no banco.
 */
const categoryOf = (item: ItemRow): string | null => item.itemType ?? fallbackType(item.dbType);

export function toBrief(server: Server, itemId: number): ItemBrief | null {
  const item = getCache(server).items.get(itemId);
  if (!item) return null;
  return {
    itemId: item.itemId,
    name: item.name,
    slots: item.slots,
    type: categoryOf(item),
    inMarket: item.inMarket,
    links: linksFor(item.itemId, item.name, server),
  };
}

/**
 * Os dois conjuntos de ids que o mercado conhece, crus.
 *
 * Existe para quem tem catálogo próprio e só precisa saber, do lado de lá, quais dos
 * SEUS itens o mercado já viu e quais estão à venda agora. Pela busca isso custaria
 * dezenas de páginas de `limit=100` — e cada linha viria com preço, links e nome que
 * ele não pediu. Aqui é uma passada no cache quente e alguns milhares de inteiros.
 *
 * São duas listas e não uma marca por item porque as perguntas são independentes: um
 * item pode ter passado pelo mercado sem estar à venda, e o contrário também.
 *
 * Memoizado pelo objeto de cache, como o `movers.ts` faz pelo id do snapshot. O resultado
 * só muda quando um crawl reconstrói o cache — de hora em hora — e sem o memo cada
 * carregamento de página do catálogo de fora refaria a varredura dos 14 mil itens e as
 * duas ordenações, síncronas, segurando o laço de eventos da API inteira. Chaveado pelo
 * objeto, e não pelo `tradingSnapshotId`, porque `inMarket` vem do outro dataset: o
 * `refreshCache` monta um objeto novo, então a identidade cobre os dois de uma vez.
 */
const idsMemo = new WeakMap<MarketCache, { inMarket: number[]; forSale: number[] }>();

export function marketedIds(server: Server): { inMarket: number[]; forSale: number[] } {
  const cache = getCache(server);
  const hit = idsMemo.get(cache);
  if (hit) return hit;

  const inMarket: number[] = [];
  for (const item of cache.items.values()) {
    if (item.inMarket) inMarket.push(item.itemId);
  }

  // "Tem bucket de anúncios na coleta mais recente" é exatamente "está à venda agora" —
  // o mesmo critério que o filtro `for_sale` da busca usa.
  const forSale = [...cache.listings.keys()];

  // Crescente nos dois: a ordem de um `Map` é a de inserção, e publicá-la faria a
  // resposta mudar de forma a cada recoleta sem mudar de conteúdo.
  const value = {
    inMarket: inMarket.sort((a, b) => a - b),
    forSale: forSale.sort((a, b) => a - b),
  };
  idsMemo.set(cache, value);
  return value;
}

/**
 * Por que ordenar aqui e não no navegador.
 *
 * A busca pagina de cinquenta em cinquenta sobre um total que pode ser mil. Ordenar a
 * página carregada responderia "o mais barato DESTES cinquenta" com cara de "o mais
 * barato" — e as chaves todas saem de `Map` do cache quente, então o conjunto inteiro
 * custa uma passada em memória.
 */
export const SEARCH_SORTS = [
  "relevance",
  "price",
  "median",
  "stores",
  "units",
  "market_avg",
  "discount",
  "sold",
  "market_min",
  "market_max",
  "name",
  "id",
] as const;

export type SearchSort = (typeof SEARCH_SORTS)[number];

export const isSearchSort = (value: string): value is SearchSort =>
  SEARCH_SORTS.some((s) => s === value);

/**
 * Teto de itens numa resposta — vale tanto para o `limit` quanto para o tamanho da lista
 * de ids: uma lista maior que a página só produziria itens que ninguém veria.
 *
 * Não é o `config.limits.maxResults` (que o router aplica por cima, e é menor): core não
 * enxerga configuração, e este é o limite de sanidade da função.
 */
const MAX_ITEMS = 200;

export interface SearchOptions {
  server: Server;
  /**
   * Nome parcial, um id ou uma lista de ids (`502,501`). Pode vir vazio quando há filtro
   * de tipo ou slot.
   */
  query?: string;
  /** Id de categoria (ver `core/taxonomy.ts`). */
  type?: string;
  /** Id de slot de equipamento. */
  slot?: string;
  /** Só itens que já apareceram no mercado. Ligado por padrão: é o que interessa aqui. */
  onlyInMarket?: boolean;
  /**
   * Só itens com anúncio ativo AGORA.
   *
   * Não é o mesmo que `onlyInMarket`, e é mais estreito: aquele pergunta "já apareceu
   * alguma vez", este pergunta "dá para comprar neste momento". Um item vendido semana
   * passada e esgotado hoje passa no primeiro e não passa neste.
   *
   * Desligado por padrão para não mudar o significado de nenhuma chamada existente da
   * API nem do MCP — quem quer o recorte pede.
   */
  onlyForSale?: boolean;
  /** Por qual coluna ordenar. `relevance` (padrão) é a ordem de casamento do nome. */
  sort?: SearchSort;
  /** Decrescente. Não muda onde a ausência de dado cai: ela fica no fim dos dois jeitos. */
  desc?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  total: number;
  items: ItemBrief[];
}

/** Um hit antes de virar resposta: o que ordena, sem o objeto do item ainda montado. */
interface Hit {
  itemId: number;
  /** Qualidade do casamento: -1 id exato, 0 nome igual, 1 começa com, 2 contém. */
  rank: number;
  /** Posição na lista de ids digitada. Zero para quem veio da varredura de nome. */
  seq: number;
  len: number;
  /**
   * A chave da ordenação pedida, ou `null` quando não se sabe. Fica no próprio hit —
   * calculada uma vez por item, e não a cada comparação, sem um mapa à parte no meio.
   */
  key: number | string | null;
}

/** Chave de ordenação de um item, ou `null` quando não se sabe (sem oferta, nunca vendido). */
type SortKey = (itemId: number) => number | string | null;

/**
 * De onde sai cada chave de ordenação.
 *
 * Lê os `Map` do cache direto em vez de chamar `offerSummary`: aquele monta percentis e
 * soma unidades para devolver o resumo inteiro, e ordenar por "Lojas" não precisa de nada
 * disso — em milhares de hits, a diferença é o que torna a ordenação do conjunto completo
 * barata. `listings` já vem ordenado por preço (ver o cabeçalho de `core/prices.ts`),
 * então o mais barato é o primeiro do balde.
 */
function sortKeyOf(server: Server, sort: SearchSort): SortKey | null {
  if (sort === "relevance") return null;
  const cache = getCache(server);
  const offers = (itemId: number) => cache.listings.get(itemId);
  const sold = (itemId: number) => cache.prices.get(itemId);

  switch (sort) {
    case "price":
      return (id) => offers(id)?.[0]?.price ?? null;
    // Pelo índice, e não copiando os preços para um array: o balde já vem ordenado, e a
    // cópia seria uma alocação por item só para ler uma posição.
    case "median":
      return (id) => {
        const listings = offers(id);
        if (!listings || listings.length === 0) return null;
        return listings[quantileIndex(listings.length, 0.5)]!.price;
      };
    case "stores":
      return (id) => offers(id)?.length ?? null;
    case "units":
      return (id) => offers(id)?.reduce((sum, l) => sum + l.cnt, 0) ?? null;
    case "market_avg":
      return (id) => sold(id)?.avgPrice ?? null;
    case "market_min":
      return (id) => sold(id)?.minPrice ?? null;
    case "market_max":
      return (id) => sold(id)?.maxPrice ?? null;
    case "sold":
      return (id) => sold(id)?.totalCnt ?? null;
    // O mesmo desconto da coluna "vs. média vendida" (`discountVsSold`, em
    // web/src/lib/columns.tsx): quanto o anúncio mais barato de agora está abaixo da média
    // do que o site publica como JÁ vendido. A conta está escrita nos dois lugares porque
    // a fronteira `web/` → `src/` é só de tipo; se um lado mudar de base, mude o outro,
    // ou a ordem passa a discordar do número na tela. Some quando falta qualquer fonte.
    case "discount":
      return (id) => {
        const avg = sold(id)?.avgPrice;
        const now = offers(id)?.[0]?.price;
        if (!avg || now === undefined) return null;
        return ((avg - now) / avg) * 100;
      };
    case "name":
      return (id) => cache.items.get(id)?.nameNorm ?? null;
    case "id":
      return (id) => id;
  }
}

/**
 * Busca por substring, sem acento e sem caixa.
 *
 * A ordenação padrão é por qualidade do casamento, não alfabética: nome exato primeiro,
 * depois começa-com, depois contém, e dentro de cada faixa o nome mais curto ganha.
 * Sem isso, buscar "poção" devolve "Caixa de Poção Talentosa" antes de "Poção Vermelha",
 * que é o oposto do que a pessoa quis. `opts.sort` troca o critério, e o casamento vira
 * o desempate.
 */
export function searchItems(opts: SearchOptions): SearchResult {
  const raw = (opts.query ?? "").trim();
  const q = normalizeName(raw);
  const { type, slot } = opts;

  // Sem nada para filtrar não há busca: devolver o catálogo inteiro seria uma
  // varredura cara para uma pergunta que ninguém fez. Um filtro de tipo ou de slot já
  // basta — é o que permite "me mostra todas as katars" sem digitar nome nenhum.
  if (!q && !type && !slot) return { total: 0, items: [] };

  const cache = getCache(opts.server);
  const onlyInMarket = opts.onlyInMarket ?? true;
  const limit = Math.min(opts.limit ?? 20, MAX_ITEMS);
  const offset = Math.max(opts.offset ?? 0, 0);

  const onlyForSale = opts.onlyForSale ?? false;

  /** O que o item É: contradiz o pedido, então vale até para um id exato. */
  const matchesKind = (item: ItemRow): boolean => {
    if (type && categoryOf(item) !== type) return false;
    if (slot && !item.equipSlots.includes(slot)) return false;
    return true;
  };

  /**
   * Se dá para comprar: recorta a lista, mas não contradiz um pedido nominal.
   *
   * Separado de `matchesKind` porque a busca por id exato ignora estes dois — pedir
   * "katar" e receber uma poção seria erro, mas pedir o item 501 e não recebê-lo porque
   * ninguém o vende hoje é responder outra pergunta.
   */
  const isAvailable = (item: ItemRow): boolean => {
    if (onlyInMarket && !item.inMarket) return false;
    // O cache guarda os anúncios da coleta mais recente, então "tem bucket" é
    // exatamente "está à venda agora" — sem tocar o disco.
    if (onlyForSale && !cache.listings.has(item.itemId)) return false;
    return true;
  };

  const hits: Hit[] = [];
  const seen = new Set<number>();

  /**
   * Ids exatos vêm primeiro, e são o único caso que ignora os filtros de disponibilidade.
   *
   * Quem digita `501` está pedindo AQUELE item, não os que por acaso têm "501" no
   * nome — e devolver vazio porque ele não está à venda hoje seria responder outra
   * pergunta. Sem isto, buscar por id não achava nada: a varredura abaixo só olha o
   * nome, então o id só funcionava nas rotas que passam por `resolveItem`.
   *
   * A lista (`502,501` ou `502 501`) sai daí: é a forma de comparar um punhado de itens
   * lado a lado sem buscar um por vez. O `seq` guarda a ordem digitada, porque o
   * desempate por tamanho de nome reordenaria o que a pessoa escreveu.
   */
  const key = sortKeyOf(opts.server, opts.sort ?? "relevance");

  if (/^\d+(?:[,\s]+\d+)*$/.test(raw)) {
    const ids = raw.split(/[,\s]+/).slice(0, MAX_ITEMS);
    for (const [seq, id] of ids.entries()) {
      const byId = cache.items.get(Number(id));
      if (!byId || seen.has(byId.itemId) || !matchesKind(byId)) continue;
      hits.push({
        itemId: byId.itemId,
        rank: -1,
        seq,
        len: byId.nameNorm.length,
        key: key?.(byId.itemId) ?? null,
      });
      seen.add(byId.itemId);
    }
  }

  for (const item of cache.items.values()) {
    if (seen.has(item.itemId)) continue;
    // Sem texto, o filtro sozinho define o conjunto e todos empatam em relevância.
    const idx = q ? item.nameNorm.indexOf(q) : 0;
    if (idx === -1) continue;
    if (!isAvailable(item)) continue;
    if (!matchesKind(item)) continue;
    const rank = !q ? 2 : item.nameNorm === q ? 0 : idx === 0 ? 1 : 2;
    hits.push({
      itemId: item.itemId,
      rank,
      seq: 0,
      len: item.nameNorm.length,
      key: key?.(item.itemId) ?? null,
    });
  }

  /** A ordem de sempre, que agora também serve de desempate para as outras. */
  const byMatch = (a: Hit, b: Hit): number =>
    a.rank - b.rank || a.seq - b.seq || a.len - b.len || a.itemId - b.itemId;

  if (key === null) {
    hits.sort(byMatch);
  } else {
    hits.sort((a, b) => {
      // A ausência é decidida ANTES da inversão, então item sem preço fica no fim nos
      // dois sentidos — a mesma armadilha que o `sortUndefined` da tabela descreve. Uma
      // página de travessões no topo do decrescente não é o que ninguém pediu.
      if (a.key === null || b.key === null) {
        return a.key === b.key ? byMatch(a, b) : a.key === null ? 1 : -1;
      }
      const cmp =
        typeof a.key === "string" ? a.key.localeCompare(b.key as string) : a.key - (b.key as number);
      // Desempate estável: sem ele, "Lojas" (onde empate é a regra) embaralharia as
      // linhas entre um offset e o seguinte, e "Carregar mais" traria repetidas.
      return cmp === 0 ? byMatch(a, b) : opts.desc ? -cmp : cmp;
    });
  }

  return {
    total: hits.length,
    items: hits.slice(offset, offset + limit).map((h) => toBrief(opts.server, h.itemId)!),
  };
}

/**
 * Resolve uma referência solta a um item: id numérico ou nome.
 *
 * Existe porque um agente recebe "quanto custa um Elixir Dourado?" e não um id. Só
 * devolve item quando não há dúvida — se a busca casar com vários, devolve os
 * candidatos para quem chamou perguntar, em vez de escolher errado em silêncio.
 */
export type Resolution =
  | { kind: "found"; item: ItemBrief }
  | { kind: "ambiguous"; candidates: ItemBrief[] }
  | { kind: "not-found"; query: string };

export function resolveItem(server: Server, ref: string | number): Resolution {
  if (typeof ref === "number" || /^\d+$/.test(ref.trim())) {
    const item = toBrief(server, Number(ref));
    return item ? { kind: "found", item } : { kind: "not-found", query: String(ref) };
  }

  // Nome exato ganha de qualquer parcial, mesmo que existam outros contendo o termo:
  // quem digita "Poção Vermelha" inteiro não está em dúvida. Resolver pelo mapa antes
  // de varrer é o que torna barato o caso mais comum — o agente repetindo um nome que
  // acabou de ler.
  const exactId = getCache(server).byNameNorm.get(normalizeName(ref));
  if (exactId !== undefined) {
    const item = toBrief(server, exactId);
    if (item) return { kind: "found", item };
  }

  const { items } = searchItems({ server, query: ref, limit: 10 });
  if (items.length === 0) {
    const wider = searchItems({ server, query: ref, limit: 10, onlyInMarket: false });
    if (wider.items.length === 0) return { kind: "not-found", query: ref };
    if (wider.items.length === 1) return { kind: "found", item: wider.items[0]! };
    return { kind: "ambiguous", candidates: wider.items };
  }

  const norm = normalizeName(ref);
  const exact = items.filter((i) => normalizeName(i.name) === norm);
  if (exact.length === 1) return { kind: "found", item: exact[0]! };
  if (items.length === 1) return { kind: "found", item: items[0]! };
  return { kind: "ambiguous", candidates: items };
}

/**
 * O mesmo para uma lista, sem que uma referência ruim derrube as outras.
 *
 * `resolveItem` responde por uma pergunta só, e quem chama decide o que fazer com a
 * dúvida — em lote essa decisão é sempre a mesma: separar o que resolveu do que não
 * resolveu e seguir com o resto. Um nome ambíguo entre cem jogaria fora noventa e nove
 * resoluções boas.
 *
 * Fica aqui, e não no canal que chamou, porque a regra é do domínio e não da apresentação:
 * o dia em que `GET /api/v1/prices` aceitar nome, ele herda a mesma separação em vez de
 * redescobri-la. Cada canal formata `unresolved` como quiser — texto para o agente, corpo
 * de erro para o HTTP.
 */
export interface BatchResolution {
  ids: number[];
  unresolved: Array<{ ref: string | number; resolution: Exclude<Resolution, { kind: "found" }> }>;
}

export function resolveItems(server: Server, refs: Array<string | number>): BatchResolution {
  const ids: number[] = [];
  const unresolved: BatchResolution["unresolved"] = [];

  for (const ref of refs) {
    const resolution = resolveItem(server, ref);
    if (resolution.kind === "found") ids.push(resolution.item.itemId);
    else unresolved.push({ ref, resolution });
  }

  // Sem deduplicar: `itemPrices` já lê cada id uma vez só, e é lá que a regra pertence —
  // dois nomes diferentes podem apontar para o mesmo item, e quem descobre isso é quem lê.
  return { ids, unresolved };
}
