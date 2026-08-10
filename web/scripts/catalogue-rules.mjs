/**
 * Regras derivadas do catálogo do cliente. Ficam num módulo próprio, e não dentro do
 * script de build, porque são a única parte dele que pode errar em silêncio — e assim
 * têm teste (`src/lib/__tests__/untradable.test.ts`).
 */

/**
 * Códigos de cor do cliente (`^RRGGBB`), que aparecem no meio das frases.
 *
 * `src/lib/description.ts` tem o mesmo padrão com um grupo de captura — lá a cor é o
 * dado, aqui ela só é apagada. São duas linhas de propósito: tentei servi-las de uma
 * fonte comum e montar o grupo em cima dela saiu mais fácil de errar do que manter as
 * duas em dia. Se mexer numa, mexa na outra.
 */
const COLOR_CODE = /\^[0-9a-fA-F]{6}/g;

/**
 * O item não pode ser negociado entre jogadores?
 *
 * O sinal é a própria descrição do cliente. Foi escolhido depois de medir as duas
 * alternativas contra a verdade de campo — os 5.460 itens que o coletor já viu à venda
 * em semanas de coleta:
 *
 *   - coluna `Trade` de `data/itemmoveinfov5.txt` (dentro do data.grf): marca 3.908
 *     itens, e **51,6% deles estão à venda agora**. É pior que chutar (38% do catálogo
 *     já apareceu no mercado). A tabela é herdada do cliente coreano e não descreve as
 *     regras deste servidor.
 *   - esta regra: marca 1.215 itens, e só 1,3% apareceram — 16 casos, todos
 *     inspecionados à mão.
 *
 * Exige "Intransferível" iniciando frase e no singular. As duas restrições existem por
 * causa de falso positivo real: as "Bolsa de Moedas" (12612, 12615-12617) dizem
 * "As moedas são inegociáveis e intransferíveis para o armazém" — falam do conteúdo,
 * não da bolsa, que é negociável e de fato aparece à venda.
 */
export function isUntradable(description) {
  if (!description) return false;
  const plain = description.replace(COLOR_CODE, "");
  return /(?:^|[.:\n])\s*intransfer[íi]vel\b/i.test(plain);
}
