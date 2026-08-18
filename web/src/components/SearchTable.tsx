/**
 * A tabela da busca.
 *
 * O resultado era uma lista com nome, tipo e links: dava para achar o item, mas não para
 * decidir nada — quem quisesse saber o preço tinha que abrir uma linha de cada vez. Agora
 * é a mesma maquinaria de "Meu inventário" e de Favoritos, com o painel "Colunas" e a
 * escolha guardada no navegador.
 *
 * Nasce enxuta de propósito: preço é o que quase todo mundo veio ver, e as outras dez
 * colunas estão a um clique. A tabela larga por padrão só empurraria os links para fora
 * da tela.
 *
 * A ordenação é do SERVIDOR (`manualSorting`). A busca pagina de cinquenta em cinquenta
 * sobre um total que pode ser mil, então ordenar aqui responderia "o mais barato destes
 * cinquenta" com cara de "o mais barato" — ver `SEARCH_SORTS` em `src/core/items.ts`.
 */

import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useMemo } from "react";

import type { SearchFilters } from "../api/client.js";
import type { ItemPrice, SearchSort } from "../api/types.js";
import { TrendArrow, discountVsSold, makeNumCol, makePctCol } from "../lib/columns.js";
import { count, zeny } from "../lib/format.js";
import { SEARCH_COLUMNS_KEY } from "../lib/persist.js";
import { useColumnVisibility } from "../state/useColumnVisibility.js";
import { CopyButton } from "./CopyButton.js";
import { DataTable } from "./DataTable.js";
import { ItemCell } from "./ItemCell.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { StarButton } from "./StarButton.js";

const helper = createColumnHelper<ItemPrice>();
const numCol = makeNumCol(helper);
const pctCol = makePctCol(helper);

/**
 * Do id da coluna para a chave que o backend ordena.
 *
 * É a lista de colunas ordenáveis: `buildColumns` liga o clique no cabeçalho a partir
 * daqui, então uma coluna sem chave nasce inerte em vez de virar um cabeçalho que parece
 * ordenar e devolve a ordem de relevância.
 */
const SORT_BY_COLUMN: Partial<Record<string, SearchSort>> = {
  name: "name",
  unitPrice: "price",
  unitMedian: "median",
  stores: "stores",
  units: "units",
  marketAvg: "market_avg",
  discount: "discount",
  totalSold: "sold",
  marketMin: "market_min",
  marketMax: "market_max",
  itemId: "id",
};

/**
 * Do estado da tabela para os parâmetros da busca.
 *
 * Mora aqui, junto do mapa, para a página não precisar conhecer id de coluna nenhum. As
 * duas chaves vão sempre, mesmo indefinidas: o terceiro clique no cabeçalho LIMPA a
 * ordenação, e um objeto vazio deixaria a anterior de pé.
 */
export const sortOf = (sorting: SortingState): Pick<SearchFilters, "sort" | "desc"> => {
  const first = sorting[0];
  return { sort: first && SORT_BY_COLUMN[first.id], desc: first?.desc };
};

/**
 * O que fica escondido na primeira visita.
 *
 * Ids iguais aos de `ItemsTable` onde a coluna mede a mesma coisa: o alinhamento à direita
 * do CSS é por `.col-<id>`, então repetir o id é o que faz a coluna nova já nascer alinhada.
 */
const DEFAULT_HIDDEN: VisibilityState = {
  unitMedian: false,
  stores: false,
  units: false,
  seller: false,
  marketAvg: false,
  discount: false,
  totalSold: false,
  marketMin: false,
  marketMax: false,
  inMarket: false,
  itemId: false,
};

interface Props {
  rows: ItemPrice[];
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  /** Rótulo pt-BR de cada id de tipo, vindo da taxonomia que a página carregou. */
  typeLabels: Map<string, string>;
  /** Ids que apareceram em /movers na janela de 7 dias, para marcar tendência. */
  movers: Map<number, number>;
  /** Vazio é a ordem de relevância do backend. */
  sorting: SortingState;
  /** Ordenar refaz a busca — ver `MercadoPage`. */
  onSortingChange: OnChangeFn<SortingState>;
}

export function SearchTable({
  rows,
  descriptions,
  onSelect,
  typeLabels,
  movers,
  sorting,
  onSortingChange,
}: Props) {
  const [visibility, setVisibility] = useColumnVisibility(SEARCH_COLUMNS_KEY, DEFAULT_HIDDEN);

  const columns = useMemo(
    () =>
      // Ordenável é exatamente quem tem chave no servidor — escrito uma vez, aqui, em vez
      // de um `enableSorting: false` por coluna que pode discordar do mapa.
      buildColumns({ descriptions, onSelect, typeLabels, movers }).map((column) => ({
        ...column,
        enableSorting: column.id !== undefined && column.id in SORT_BY_COLUMN,
      })),
    [descriptions, onSelect, typeLabels, movers],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange,
    onColumnVisibilityChange: setVisibility,
    // Sem `getSortedRowModel`: reordenar aqui embaralharia a página por cima da ordem que
    // o servidor calculou sobre o conjunto inteiro.
    manualSorting: true,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.itemId),
  });

  return <DataTable table={table} empty={<p className="empty">Nada encontrado.</p>} />;
}

// `any` no segundo parâmetro é o que a própria TanStack recomenda para uma lista com
// colunas de tipos de valor diferentes.
function buildColumns(ctx: {
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
  typeLabels: Map<string, string>;
  movers: Map<number, number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<ItemPrice, any>[] {
  const { descriptions, onSelect, typeLabels, movers } = ctx;

  return [
    helper.display({
      id: "estrela",
      header: "",
      cell: ({ row }) => <StarButton itemId={row.original.itemId} />,
    }),
    helper.display({
      id: "ícone",
      header: "",
      cell: ({ row }) => (
        <ItemCell
          item={row.original}
          descriptions={descriptions}
          onSelect={onSelect}
          part="icon"
        />
      ),
    }),
    helper.accessor((row) => row.name, {
      id: "name",
      header: "Item",
      cell: ({ row }) => (
        <>
          {/* `copiable`: o nome vai para a área de transferência com slots e tudo — é o que
              se cola na busca do jogo ou num anúncio, e digitar "[4]" à mão erra com
              frequência. */}
          <ItemCell
            item={row.original}
            descriptions={descriptions}
            onSelect={onSelect}
            part="name"
            copiable
          />
          <TrendArrow pct={movers.get(row.original.itemId)} />
          {/* O selo continua ao lado do nome, e não só na coluna "Visto no mercado":
              escondido por padrão, ele sumiria justo para quem marca "incluir itens nunca
              vistos" e precisa saber quais são. */}
          {!row.original.inMarket && <span className="badge badge-muted">nunca visto à venda</span>}
        </>
      ),
    }),
    helper.accessor((row) => (row.type ? (typeLabels.get(row.type) ?? row.type) : ""), {
      id: "tipo",
      header: "Tipo",
      cell: (info) => (info.getValue() ? <span className="badge">{info.getValue()}</span> : null),
    }),

    // --- Agora (lojas abertas) ------------------------------------------
    numCol("unitPrice", "Mais barato", (row) => row.offers?.min, zeny),
    numCol("unitMedian", "Mediana", (row) => row.offers?.median, zeny),
    numCol("stores", "Lojas", (row) => row.offers?.stores, count),
    numCol("units", "Un. à venda", (row) => row.offers?.units, count),
    helper.accessor((row) => row.cheapest[0]?.seller ?? "", {
      id: "seller",
      header: "Vendedor",
      cell: (info) => {
        const seller = info.getValue();
        if (!seller) return "—";
        return (
          <span className="copyable">
            {seller}
            <CopyButton value={seller} label="o nome do vendedor" />
          </span>
        );
      },
    }),

    // --- Histórico do site ----------------------------------------------
    // Separado de propósito: `market` é o agregado que o site publica sobre o que JÁ foi
    // vendido; as colunas acima são o que está anunciado AGORA. São medidas diferentes e
    // não se somam (ver o cabeçalho de src/core/prices.ts).
    numCol("marketAvg", "Média vendida", (row) => row.market?.avg, zeny),
    pctCol(
      "discount",
      "vs. média vendida",
      (row) => discountVsSold(row.offers?.min, row.market?.avg),
      "up",
    ),
    numCol("totalSold", "Já vendidos", (row) => row.market?.totalSold, count),
    numCol("marketMin", "Mín. vendido", (row) => row.market?.min, zeny),
    numCol("marketMax", "Máx. vendido", (row) => row.market?.max, zeny),

    // --- Sinais ----------------------------------------------------------
    helper.accessor((row) => row.inMarket, {
      id: "inMarket",
      header: "Visto no mercado",
      cell: (info) => (info.getValue() ? "sim" : "nunca"),
    }),
    // Para quem vai colar o id em outro lugar — nos favoritos, por exemplo. Sem `numCol`:
    // o id nunca falta, e agrupar milhar num número que se copia atrapalharia.
    helper.accessor("itemId", { id: "itemId", header: "id" }),
    helper.display({
      id: "links",
      header: "Links",
      cell: ({ row }) => <ItemLinksCell links={row.original.links} />,
    }),
  ];
}
