/**
 * Percentil por posição sobre uma lista já ordenada.
 *
 * Mora aqui porque dois lugares precisam da MESMA definição de mediana: o resumo de
 * ofertas (`core/prices.ts`) e a ordenação da busca por mediana (`core/items.ts`).
 * Duplicada, uma correção num lado deixaria a coluna e a ordem discordando em silêncio.
 *
 * O índice sai à parte do valor porque quem chama costuma ter uma lista de anúncios, não
 * de números: sem ele, ler a mediana obrigaria a copiar todos os preços para um array
 * novo só para indexar um deles.
 */
export const quantileIndex = (length: number, p: number): number =>
  Math.floor((length - 1) * p);

export function quantile(sorted: number[], p: number): number {
  return sorted[quantileIndex(sorted.length, p)]!;
}
