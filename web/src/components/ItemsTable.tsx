import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import type { Row } from "../lib/rows.js";
import { ORIGIN_LABEL } from "../lib/rows.js";
import { count, zeny } from "../lib/format.js";
import { TrendArrow, makeNumCol, missingLast, orUndefined } from "../lib/columns.js";
import { useColumnVisibility } from "../state/useColumnVisibility.js";
import { DataTable } from "./DataTable.js";
import { ItemCell } from "./ItemCell.js";
import { ItemHover } from "./ItemHover.js";
import { ItemLinksCell } from "./ItemLinksCell.js";

const helper = createColumnHelper<Row>();
const numCol = makeNumCol(helper);

interface Props {
  rows: Row[];
  descriptions: Record<string, string>;
  /** A MESMA regra que o filtro e o CSV usam — não o conjunto cru. */
  isUnsellable: (row: Row) => boolean;
  onSelect: (itemId: number) => void;
  /** Ids que apareceram em /movers na janela de 7 dias, para marcar tendência. */
  movers: Map<number, number>;
}

export function ItemsTable({ rows, descriptions, isUnsellable, onSelect, movers }: Props) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "total", desc: true }]);
  const [visibility, setVisibility] = useColumnVisibility(STORAGE_KEY, DEFAULT_HIDDEN);

  const columns = useMemo(
    () => buildColumns({ descriptions, isUnsellable, movers, onSelect }),
    [descriptions, isUnsellable, movers, onSelect],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnVisibility: visibility },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.key,
  });

  return (
    <DataTable table={table} empty={<p className="empty">Nenhum item com os filtros atuais.</p>} />
  );
}

const STORAGE_KEY = "latam-market:columns";

const DEFAULT_HIDDEN: VisibilityState = {
  marketMin: false,
  marketMax: false,
  cards: false,
  inMarket: false,
  tradable: false,
};

// `any` no segundo parâmetro é o que a própria TanStack recomenda para uma lista com
// colunas de tipos de valor diferentes: cada `helper.accessor` devolve um tipo distinto,
// e sem isso o array não unifica.
function buildColumns(ctx: {
  descriptions: Record<string, string>;
  isUnsellable: (row: Row) => boolean;
  movers: Map<number, number>;
  onSelect: (itemId: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<Row, any>[] {
  const { descriptions, isUnsellable, movers, onSelect } = ctx;

  return [
    helper.display({
      id: "icon",
      header: "",
      cell: ({ row }) => (
        <ItemCell
          item={row.original.item}
          refine={row.original.refine}
          descriptions={descriptions}
          onSelect={onSelect}
          part="icon"
        />
      ),
    }),
    helper.accessor((row) => row.item.name, {
      id: "name",
      header: "Item",
      cell: ({ row }) => (
        <>
          <ItemCell
            item={row.original.item}
            refine={row.original.refine}
            descriptions={descriptions}
            onSelect={onSelect}
            part="name"
          />
          <TrendArrow pct={movers.get(row.original.item.itemId)} />
        </>
      ),
    }),
    helper.accessor((row) => ORIGIN_LABEL[row.origin], {
      id: "origin",
      header: "Origem",
      cell: (info) => <span className="badge">{info.getValue()}</span>,
    }),
    helper.accessor("qty", { id: "qty", header: "Qtd", cell: (info) => count(info.getValue()) }),

    // --- Agora (lojas abertas) ------------------------------------------
    numCol("unitPrice", "Mais barato", (row) => row.unitPrice, zeny),
    numCol("unitMedian", "Mediana", (row) => row.unitMedian, zeny),
    helper.accessor("stores", { id: "stores", header: "Lojas", cell: (info) => count(info.getValue()) }),
    numCol("units", "Un. à venda", (row) => row.units, count),
    helper.accessor((row) => orUndefined(row.total), {
      id: "total",
      header: "Total",
      ...missingLast,
      cell: (info) => <strong>{zeny(info.getValue())}</strong>,
    }),

    // --- Histórico do site ----------------------------------------------
    // Separado de propósito: `market` é o agregado que o site publica sobre o que JÁ foi
    // vendido; as colunas acima são o que está anunciado AGORA. São medidas diferentes
    // e não se somam (ver o cabeçalho de src/core/prices.ts).
    numCol("marketAvg", "Média vendida", (row) => row.market?.avg, zeny),
    numCol("totalSold", "Já vendidos", (row) => row.market?.totalSold, count),
    numCol("marketMin", "Mín. vendido", (row) => row.market?.min, zeny),
    numCol("marketMax", "Máx. vendido", (row) => row.market?.max, zeny),

    // --- Sinais ----------------------------------------------------------
    helper.accessor((row) => row.cardNames.join(", "), { id: "cards", header: "Cartas/encantes" }),
    helper.accessor((row) => !isUnsellable(row), {
      id: "tradable",
      header: "Vendível",
      cell: (info) => (info.getValue() ? "sim" : "não"),
    }),
    helper.accessor((row) => row.item.inMarket, {
      id: "inMarket",
      header: "Visto no mercado",
      cell: (info) => (info.getValue() ? "sim" : "nunca"),
    }),
    helper.display({
      id: "caveat",
      header: "",
      cell: ({ row }) =>
        row.original.priceCaveat ? (
          <ItemHover title="Atenção ao preço" description={row.original.priceCaveat}>
            <span className="caveat">⚠</span>
          </ItemHover>
        ) : null,
    }),
    helper.display({
      id: "links",
      header: "Links",
      cell: ({ row }) => <ItemLinksCell links={row.original.item.links} />,
    }),
  ];
}
