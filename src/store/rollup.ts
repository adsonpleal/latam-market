/**
 * Percentis de um snapshot de anúncios, em JavaScript.
 *
 * Era SQL puro (`ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY price)` sobre a tabela
 * `listing`), e o comentário de lá dizia o motivo: trazer 20 mil linhas para o JS só para
 * ordenar seria mais lento que deixar o SQLite ordenar uma vez. O motivo caiu junto com a
 * tabela — no D1 os anúncios crus não existem, e quem chama já tem os baldes ordenados por
 * preço para montar o blob do snapshot. Ordenar de novo é que seria o desperdício.
 *
 * A definição de percentil vem de `util/stats.ts`, a mesma que a coluna de mediana da busca
 * e o resumo de ofertas usam. Não é conveniência: o SQL antigo indexava por
 * `(n - 1) / 4`, `(n - 1) / 2` e `(n - 1) * 3 / 4` em divisão inteira, que é exatamente
 * `quantileIndex(n, p)`. Reusar fecha a porta para a coluna e o rollup discordarem.
 *
 * Cada anúncio conta uma vez, independente da quantidade — o preço é por unidade, então
 * uma loja com 300 unidades não deve dominar a mediana.
 */

import { quantileIndex } from "../util/stats.js";

/** O mínimo que um anúncio precisa ter para entrar na conta. */
export interface Priced {
  price: number;
  cnt: number;
}

/** Uma linha de `listing_stats`, sem as colunas que o chamador carimba (`server`, `ts`). */
export interface StatsRow {
  itemId: number;
  listings: number;
  units: number;
  minPrice: number;
  p25: number;
  median: number;
  p75: number;
  maxPrice: number;
}

/**
 * Estatísticas de um item a partir dos seus anúncios JÁ ORDENADOS por preço crescente.
 *
 * Não ordena por dentro de propósito: quem chama vem do balde do snapshot, que já sai
 * ordenado, e uma cópia por item aqui seria uma alocação por item para nada.
 */
export function statsFor(itemId: number, sorted: readonly Priced[]): StatsRow | null {
  const n = sorted.length;
  if (n === 0) return null;

  let units = 0;
  for (const l of sorted) units += l.cnt;

  const at = (p: number): number => sorted[quantileIndex(n, p)]!.price;

  return {
    itemId,
    listings: n,
    units,
    // `MIN`/`MAX` do SQL antigo. Com a lista ordenada são as pontas.
    minPrice: sorted[0]!.price,
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    maxPrice: sorted[n - 1]!.price,
  };
}

/**
 * Agrupa anúncios crus por item, ordenados por preço.
 *
 * Existe para quem tem a lista chapada (o import de NDJSON, os testes) e não o balde
 * pronto. O caminho de ingestão não passa por aqui — ele já montou os baldes para o blob.
 */
export function groupByItem<T extends Priced & { itemId: number }>(
  rows: Iterable<T>,
): Map<number, T[]> {
  const buckets = new Map<number, T[]>();
  for (const row of rows) {
    let bucket = buckets.get(row.itemId);
    if (!bucket) buckets.set(row.itemId, (bucket = []));
    bucket.push(row);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.price - b.price);
  return buckets;
}

/** O rollup inteiro de um snapshot, na ordem de id crescente (a mesma do `GROUP BY`). */
export function rollupStats(buckets: Map<number, readonly Priced[]>): StatsRow[] {
  const out: StatsRow[] = [];
  for (const itemId of [...buckets.keys()].sort((a, b) => a - b)) {
    const row = statsFor(itemId, buckets.get(itemId)!);
    if (row) out.push(row);
  }
  return out;
}
