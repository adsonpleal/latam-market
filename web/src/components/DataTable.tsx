/**
 * A casca das tabelas de dados: seletor de colunas, cabeçalho ordenável e corpo.
 *
 * `ItemsTable` e `FavoritesTable` tinham as mesmas quarenta linhas de marcação, e o
 * contrato `col-<id>` que o CSS usa para alinhar números à direita estava escrito duas
 * vezes. Uma terceira tabela agora é só um `buildColumns`.
 */

import { flexRender, type Table } from "@tanstack/react-table";
import type { ReactNode } from "react";

import { ColumnPicker } from "./ColumnPicker.js";

interface Props<Row> {
  table: Table<Row>;
  /** Mostrado no lugar das linhas quando não há nenhuma. */
  empty?: ReactNode;
}

export function DataTable<Row>({ table, empty }: Props<Row>) {
  const rows = table.getRowModel().rows;

  return (
    <>
      <ColumnPicker columns={table.getAllLeafColumns()} />

      <div className="table-scroll">
        <table className="items">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    className={header.column.getCanSort() ? "sortable" : undefined}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={`col-${cell.column.id}`}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && empty}
      </div>
    </>
  );
}
