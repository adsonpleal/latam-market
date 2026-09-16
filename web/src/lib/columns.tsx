/**
 * Peças compartilhadas pelas tabelas de dados.
 *
 * A explicação do `sortUndefined` mora aqui porque é justamente a armadilha que não pode
 * ser reaprendida a cada tabela nova.
 */

/**
 * Item sem preço fica no fim nos DOIS sentidos de ordenação.
 *
 * Não dá para resolver com um `sortingFn` próprio: a TanStack inverte o resultado do
 * comparador quando a coluna está descendente, então "nulo por último" no crescente
 * vira "nulo por primeiro" no decrescente — e a tabela abria com trinta linhas "—"
 * antes do primeiro item que vale alguma coisa.
 *
 * O caminho que a biblioteca oferece é `sortUndefined`, que age fora da inversão. Ele
 * só enxerga `undefined`, daí os acessores converterem `null` (que é o que o app usa
 * para "não sabemos") em `undefined`.
 */
export const missingLast = { sortUndefined: "last" } as const;

export const orUndefined = (value: number | null | undefined): number | undefined =>
  value ?? undefined;

/**
 * Variação em porcentagem, com a cor do sinal.
 *
 * `good` diz qual direção é boa notícia, porque isso muda por coluna: na distância até o
 * alvo, o número negativo (já passou) é a boa notícia.
 */
export function Trend({
  value,
  title,
  good = "up",
}: {
  value: number | null | undefined;
  title?: string;
  good?: "up" | "down";
}) {
  if (value === null || value === undefined) return <>—</>;
  const positivo = value > 0;
  const bom = good === "up" ? positivo : !positivo;
  return (
    <span className={bom ? "trend up" : "trend down"} title={title}>
      {positivo ? "+" : ""}
      {value.toFixed(0)}%
    </span>
  );
}
