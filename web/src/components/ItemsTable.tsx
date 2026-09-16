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

import type { Server } from "../lib/server.js";
import { count } from "../lib/format.js";
import type { Row } from "../lib/rows.js";
import { ORIGIN_LABEL } from "../lib/rows.js";
import { INVENTORY_COLUMNS_KEY } from "../lib/persist.js";
import { useColumnVisibility } from "../state/useColumnVisibility.js";
import { DataTable } from "./DataTable.js";
import { ItemCell } from "./ItemCell.js";
import { ItemLinksCell } from "./ItemLinksCell.js";
import { StarButton } from "./StarButton.js";

const helper = createColumnHelper<Row>();

interface Props {
  rows: Row[];
  server: Server;
  descriptions: Record<string, string>;
  /** A MESMA regra que o filtro e o CSV usam — não o conjunto cru. */
  isUnsellable: (row: Row) => boolean;
  onSelect: (itemId: number) => void;
}

/**
 * O inventário, sem preço.
 *
 * As colunas de mercado (mais barato, mediana, lojas, total, histórico do site) saíram com
 * o fim da coleta do servidor: ficariam congeladas no último dado, com cara de atuais. Para
 * saber quanto um item vale hoje, a estrela manda o item para Favoritos, onde a consulta é
 * feita na hora.
 */
export function ItemsTable({ rows, server, descriptions, isUnsellable, onSelect }: Props) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "qty", desc: true }]);
  const [visibility, setVisibility] = useColumnVisibility(INVENTORY_COLUMNS_KEY, DEFAULT_HIDDEN);

  const columns = useMemo(
    () => buildColumns({ server, descriptions, isUnsellable, onSelect }),
    [server, descriptions, isUnsellable, onSelect],
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

const DEFAULT_HIDDEN: VisibilityState = {
  tradable: false,
};

// `any` no segundo parâmetro é o que a própria TanStack recomenda para uma lista com
// colunas de tipos de valor diferentes: cada `helper.accessor` devolve um tipo distinto,
// e sem isso o array não unifica.
function buildColumns(ctx: {
  server: Server;
  descriptions: Record<string, string>;
  isUnsellable: (row: Row) => boolean;
  onSelect: (itemId: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<Row, any>[] {
  const { server, descriptions, isUnsellable, onSelect } = ctx;

  return [
    helper.display({
      id: "star",
      header: "",
      cell: ({ row }) => <StarButton itemId={row.original.item.itemId} />,
    }),
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
        <ItemCell
          item={row.original.item}
          refine={row.original.refine}
          descriptions={descriptions}
          onSelect={onSelect}
          part="name"
          copiable
        />
      ),
    }),
    helper.accessor((row) => ORIGIN_LABEL[row.origin], {
      id: "origin",
      header: "Origem",
      cell: (info) => <span className="badge">{info.getValue()}</span>,
    }),
    helper.accessor("qty", { id: "qty", header: "Qtd", cell: (info) => count(info.getValue()) }),
    helper.accessor((row) => row.cardNames.join(", "), { id: "cards", header: "Cartas/encantes" }),
    helper.accessor((row) => !isUnsellable(row), {
      id: "tradable",
      header: "Vendível",
      cell: (info) => (info.getValue() ? "sim" : "não"),
    }),
    helper.display({
      id: "links",
      header: "Links",
      cell: ({ row }) => (
        <ItemLinksCell itemId={row.original.item.itemId} name={row.original.item.name} server={server} />
      ),
    }),
  ];
}
