/**
 * Quais buscas fazer no site para cobrir uma lista de itens com o mínimo de requisições.
 *
 * A busca de lojas do site casa por trecho do nome e devolve até mil anúncios por página, de
 * todos os itens que casaram. Então uma busca por "Zangão" traz "Carta Zangão", "Carta Zangão
 * Gigante" e "Carta Zangão Selvagem" de uma vez — três favoritos por uma requisição da cota. É
 * o mesmo princípio da cobertura de termos que o coletor usava para varrer o catálogo, aplicado
 * à lista de uma pessoa.
 *
 * O limite é a página. Um termo que casa com muitos itens do jogo ("Carta") traz milhares de
 * anúncios, a página corta em mil, e o item que se queria pode ficar de fora. Por isso um termo
 * só serve para agrupar quando casa com poucos itens no **catálogo** — uma estimativa barata e
 * conservadora de quantos anúncios ele traria. E quando mesmo assim a página vier cortada sem o
 * item, o laço replaneja aquele item sozinho (ver `useFavoriteWatch`).
 *
 * Guloso: a cada passo escolhe o termo que cobre mais itens ainda descobertos. Não é a cobertura
 * ótima, mas para listas de dezenas de itens a diferença é de uma ou duas requisições, e a conta
 * é instantânea.
 */

import type { ItemIndex } from "../catalogue/catalogue.js";
import { countMatches } from "../catalogue/search.js";
import { MIN_SEARCH_WORD, safeSegments, searchWordFor } from "./url.js";

/**
 * Um termo só agrupa se casar com no máximo isto de itens no catálogo.
 *
 * Um item bem vendido tem dezenas de anúncios; 25 itens assim ficam longe dos mil da página.
 * Acima disso a chance de corte cresce, e uma busca cortada custa uma segunda requisição —
 * justamente o que o agrupamento queria economizar.
 */
export const MAX_GROUP_CATALOGUE_HITS = 25;

/**
 * Termo de grupo mais curto aceito. Trechos de duas ou três letras ("de", "da", "LT") casam com
 * meio catálogo e nunca passariam no teto acima; cortar aqui poupa a conta.
 */
const MIN_GROUP_TERM = 4;

export interface QueryJob {
  /** O que vai no `searchWord`. */
  term: string;
  itemIds: number[];
}

export interface QueryPlan {
  jobs: QueryJob[];
  /** Itens cujo nome não vira busca que o site aceite — não custam requisição. */
  unsearchable: number[];
}

/** Minúsculo, mantendo acento: é como o site compara, até onde se sabe. */
const fold = (s: string): string => s.toLowerCase();

/**
 * Os termos candidatos de um nome: todo trecho de palavras seguidas dentro das partes que o
 * site aceita. "Carta Zangão Gigante" dá "Carta", "Zangão", "Gigante", "Carta Zangão",
 * "Zangão Gigante" e o nome inteiro.
 */
function candidates(name: string): string[] {
  const out = new Set<string>();
  for (const segment of safeSegments(name)) {
    const words = segment.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j <= words.length; j++) {
        const term = words.slice(i, j).join(" ");
        if (term.length >= MIN_GROUP_TERM) out.add(term);
      }
    }
  }
  return [...out];
}

/**
 * @param solo Itens que vão sozinhos, pelo próprio nome — os que já vieram cortados numa
 *   consulta de grupo. Agrupá-los de novo pagaria a requisição do grupo e depois a deles.
 */
export function planQueries(itemIds: readonly number[], index: ItemIndex, solo: ReadonlySet<number> = new Set()): QueryPlan {
  const plan: QueryPlan = { jobs: [], unsearchable: [] };

  /** Os itens que podem entrar em grupo: nome dobrado e o próprio termo de reserva. */
  const groupable = new Map<number, { folded: string; own: string; name: string }>();
  for (const id of new Set(itemIds)) {
    const entry = index.get(id);
    const own = entry ? searchWordFor(entry.name) : null;
    if (!entry || own === null || own.length < MIN_SEARCH_WORD) {
      plan.unsearchable.push(id);
    } else if (solo.has(id)) {
      plan.jobs.push({ term: own, itemIds: [id] });
    } else {
      groupable.set(id, { folded: fold(entry.name), own, name: entry.name });
    }
  }

  /**
   * Cada termo candidato com os itens da lista que ele cobre, calculado uma vez.
   *
   * A cada rodada só se conta quantos desses ainda estão descobertos — em vez de redescobrir,
   * termo por termo, quem contém quem.
   */
  const coverage = new Map<string, number[]>();
  for (const { name } of groupable.values()) {
    for (const term of candidates(name)) {
      if (coverage.has(term)) continue;
      const needle = fold(term);
      const ids = [...groupable].filter(([, g]) => g.folded.includes(needle)).map(([id]) => id);
      // Termo que só cobre um item não agrupa nada, e o teto do catálogo é o passo caro:
      // nem entra na disputa.
      if (ids.length >= 2 && countMatches(index, term) <= MAX_GROUP_CATALOGUE_HITS) coverage.set(term, ids);
    }
  }

  const uncovered = new Set(groupable.keys());
  for (;;) {
    let best: { term: string; cover: number[]; hits: number } | null = null;
    for (const [term, ids] of coverage) {
      const cover = ids.filter((id) => uncovered.has(id));
      if (cover.length < 2 || (best && cover.length < best.cover.length)) continue;
      const hits = countMatches(index, term);
      const better =
        !best ||
        cover.length > best.cover.length ||
        hits < best.hits ||
        (hits === best.hits && term.length > best.term.length);
      if (better) best = { term, cover, hits };
    }
    if (!best) break;
    plan.jobs.push({ term: best.term, itemIds: best.cover });
    for (const id of best.cover) uncovered.delete(id);
    coverage.delete(best.term);
  }

  // O que não entrou em grupo nenhum vai pelo próprio nome.
  for (const id of uncovered) plan.jobs.push({ term: groupable.get(id)!.own, itemIds: [id] });
  return plan;
}
