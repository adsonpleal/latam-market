/**
 * Busca de itens no catálogo, dentro do navegador.
 *
 * Todo item do jogo é buscável. O catálogo é o mesmo para FREYA e NIDHOGG, então nada aqui
 * recebe servidor.
 *
 * A busca parcial varre os ~14 mil nomes com `indexOf`: menos de um milissegundo para um
 * termo específico, dois para um de uma letra. Rápido o bastante para rodar a cada tecla,
 * sem debounce nem índice invertido. A paginação é de quem mostra: a busca devolve a lista
 * inteira, já ordenada, e "mostrar mais" só corta mais dela.
 */

import type { CatalogueEntry, ItemIndex } from "./catalogue.js";
import { normalizeName } from "./normalize.js";
import type { FilterOption } from "./taxonomy.js";

/** Teto de uma lista de ids digitada. */
const MAX_IDS = 200;

/** Um só, e não um `localeCompare` por comparação: cada chamada monta as regras do idioma. */
const COLLATOR = new Intl.Collator("pt-BR");

export interface SearchOptions {
  /** Nome parcial, um id ou uma lista de ids (`502,501` ou `502 501`). Pode vir vazio com filtro. */
  query: string;
  /** Tipo e/ou posição, como o seletor da interface monta. */
  filter?: Pick<FilterOption, "type" | "slot"> | null;
}

/** Um hit antes de ordenar. */
interface Hit {
  entry: CatalogueEntry;
  /** Qualidade do casamento: -1 id exato, 0 nome igual, 1 começa com, 2 contém. */
  rank: number;
  /** Posição na lista de ids digitada. Zero para quem veio da varredura de nome. */
  seq: number;
}

/**
 * O que o item É. Vale até para um id exato: pedir "katar" e receber uma poção seria erro.
 *
 * `type: null` é o filtro dos sem tipo — distinto de `type` ausente, que é "qualquer tipo".
 */
function matchesFilter(entry: CatalogueEntry, filter: SearchOptions["filter"]): boolean {
  if (!filter) return true;
  if (filter.type !== undefined && entry.type !== filter.type) return false;
  if (filter.slot && !entry.equipSlots.includes(filter.slot)) return false;
  return true;
}

/**
 * Busca por substring, sem acento e sem caixa.
 *
 * Com texto, a ordem é por qualidade do casamento: nome exato primeiro, depois começa-com,
 * depois contém, e dentro de cada faixa o nome mais curto ganha. Sem isso, buscar "poção"
 * devolve "Caixa de Poção Talentosa" antes de "Poção Vermelha".
 *
 * Sem texto e com filtro, é navegar ("me mostra todas as katars"): a ordem vira alfabética,
 * porque não há casamento nenhum para medir.
 */
export function searchItems(index: ItemIndex, opts: SearchOptions): CatalogueEntry[] {
  const raw = opts.query.trim();
  const q = normalizeName(raw);
  const { filter } = opts;
  const hasFilter = Boolean(filter && (filter.type !== undefined || filter.slot));

  // Sem termo e sem filtro não há busca: devolver o catálogo inteiro não responde pergunta.
  if (!q && !hasFilter) return [];

  const hits: Hit[] = [];
  const seen = new Set<number>();

  /**
   * Ids exatos vêm primeiro.
   *
   * Quem digita `501` está pedindo AQUELE item, não os que por acaso têm "501" no nome. A
   * lista (`502,501` ou `502 501`) é a forma de achar um punhado de itens de uma vez. O `seq`
   * guarda a ordem digitada, porque o desempate por tamanho de nome reordenaria o que a
   * pessoa escreveu.
   */
  if (/^\d+(?:[,\s]+\d+)*$/.test(raw)) {
    const ids = raw.split(/[,\s]+/).slice(0, MAX_IDS);
    for (const [seq, id] of ids.entries()) {
      const entry = index.get(Number(id));
      if (!entry || seen.has(entry.itemId) || !matchesFilter(entry, filter)) continue;
      hits.push({ entry, rank: -1, seq });
      seen.add(entry.itemId);
    }
  }

  for (const entry of index.values()) {
    if (seen.has(entry.itemId) || !matchesFilter(entry, filter)) continue;
    const idx = q ? entry.nameNorm.indexOf(q) : 0;
    if (idx === -1) continue;
    const rank = !q ? 2 : entry.nameNorm === q ? 0 : idx === 0 ? 1 : 2;
    hits.push({ entry, rank, seq: 0 });
  }

  // O id no fim é o desempate estável: sem ele, nomes iguais trocariam de lugar entre uma
  // página e a seguinte.
  hits.sort((a, b) =>
    q
      ? a.rank - b.rank || a.seq - b.seq || a.entry.nameNorm.length - b.entry.nameNorm.length || a.entry.itemId - b.entry.itemId
      : COLLATOR.compare(a.entry.nameNorm, b.entry.nameNorm) || a.entry.itemId - b.entry.itemId,
  );

  return hits.map((h) => h.entry);
}

/** Quantos itens cada opção de filtro traz — para o seletor esconder as vazias e mostrar o número. */
export function countByFilter(index: ItemIndex, options: readonly FilterOption[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const option of options) {
    let n = 0;
    for (const entry of index.values()) if (matchesFilter(entry, option)) n++;
    counts.set(option.id, n);
  }
  return counts;
}

/** Contagens já feitas, por índice: o catálogo não muda depois de carregado. */
const matchCounts = new WeakMap<ItemIndex, Map<string, number>>();

/**
 * Quantos itens do catálogo têm `term` no nome — a mesma comparação da busca por texto.
 *
 * É o que o planejador de consultas usa para estimar quantos anúncios uma busca no site
 * traria (ver `market/plan.ts`). Guardado por termo, porque o planejador roda de novo a cada
 * mudança na lista de favoritos e os termos se repetem.
 */
export function countMatches(index: ItemIndex, term: string): number {
  let cache = matchCounts.get(index);
  if (!cache) matchCounts.set(index, (cache = new Map()));
  const key = normalizeName(term);
  let n = cache.get(key);
  if (n === undefined) {
    n = 0;
    for (const entry of index.values()) if (entry.nameNorm.includes(key)) n++;
    cache.set(key, n);
  }
  return n;
}
