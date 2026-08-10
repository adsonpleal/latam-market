/**
 * Peças compartilhadas pelas tabelas de dados.
 *
 * Estavam duplicadas entre `ItemsTable` e `FavoritesTable`, incluindo a explicação do
 * `sortUndefined` — que é justamente a armadilha que não pode ser reaprendida em dois
 * lugares.
 */

import type { ColumnHelper, ColumnDef } from "@tanstack/react-table";

/**
 * Item sem preço fica no fim nos DOIS sentidos de ordenação.
 *
 * Não dá para resolver com um `sortingFn` próprio: a TanStack inverte o resultado do
 * comparador quando a coluna está descendente, então "nulo por último" no crescente
 * vira "nulo por primeiro" no decrescente — e a tabela abria com trinta linhas "—"
 * antes do primeiro item que vale alguma coisa.
 *
 * O caminho que a biblioteca oferece é `sortUndefined`, que age fora da inversão. Ele
 * só enxerga `undefined`, daí os acessores converterem `null` (que é o que a API usa
 * para "não sabemos") em `undefined`.
 */
export const missingLast = { sortUndefined: "last" } as const;

export const orUndefined = (value: number | null | undefined): number | undefined =>
  value ?? undefined;

/**
 * Coluna numérica: mesmo formato, mesma ordenação, `—` quando não se sabe.
 *
 * Com a fábrica, esquecer o `...missingLast` numa coluna nova deixa de ser possível. Recebe
 * o `helper` porque `createColumnHelper` é por tipo de linha.
 */
export function makeNumCol<Row>(helper: ColumnHelper<Row>) {
  return (
    id: string,
    header: string,
    accessor: (row: Row) => number | null | undefined,
    format: (value: number | undefined) => string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ColumnDef<Row, any> =>
    helper.accessor((row) => orUndefined(accessor(row)), {
      id,
      header,
      ...missingLast,
      cell: (info) => format(info.getValue()),
    });
}

/**
 * Coluna de porcentagem com a cor do sinal — a irmã de `makeNumCol`.
 *
 * Era local do `FavoritesTable`; subiu quando a busca passou a mostrar o mesmo desconto.
 */
export function makePctCol<Row>(helper: ColumnHelper<Row>) {
  return (
    id: string,
    header: string,
    accessor: (row: Row) => number | null | undefined,
    good: "up" | "down",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): ColumnDef<Row, any> =>
    helper.accessor((row) => orUndefined(accessor(row)), {
      id,
      header,
      ...missingLast,
      cell: (info) => <Trend value={info.getValue()} good={good} />,
    });
}

/**
 * Quanto o anúncio mais barato de agora está abaixo da média do que o site publica como
 * JÁ VENDIDO.
 *
 * NÃO é o mesmo "desconto" da aba Pechinchas: lá a base é a mediana das medianas diárias
 * que este projeto mede, aqui é o agregado do site. Daí o rótulo da coluna dizer contra o
 * que se compara, em vez de repetir a palavra solta e sugerir que são o mesmo número.
 */
export function discountVsSold(
  now: number | null | undefined,
  soldAvg: number | null | undefined,
): number | null {
  if (now === null || now === undefined || !soldAvg) return null;
  return ((soldAvg - now) / soldAvg) * 100;
}

/**
 * Variação em porcentagem, com a cor do sinal.
 *
 * `good` diz qual direção é boa notícia, porque isso muda por coluna: numa variação de
 * preço, subir é verde; num desconto, o número alto é que interessa.
 *
 * Local: desde que `makePctCol` subiu para cá, ele é o único a desenhar isto.
 */
function Trend({
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

/** A setinha ao lado do nome do item, quando ele apareceu em `/movers`. */
export function TrendArrow({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return null;
  return (
    <span
      className={pct > 0 ? "trend up" : "trend down"}
      title={`${pct > 0 ? "+" : ""}${pct.toFixed(0)}% em 7 dias`}
    >
      {pct > 0 ? " ↑" : " ↓"}
    </span>
  );
}
