/**
 * O seletor de colunas de uma tabela.
 *
 * Colunas de exibição sem cabeçalho (ícone, aviso, estrela) caem no `id` — por isso quem
 * as define deve dar um `id` legível, que é o que a pessoa vê aqui.
 */

import type { Column } from "@tanstack/react-table";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ColumnPicker({ columns }: { columns: Column<any, unknown>[] }) {
  return (
    <details className="column-picker">
      <summary>Colunas</summary>
      <div className="column-picker-list">
        {columns.map((column) => (
          <label key={column.id}>
            <input
              type="checkbox"
              checked={column.getIsVisible()}
              onChange={column.getToggleVisibilityHandler()}
            />
            {typeof column.columnDef.header === "string" && column.columnDef.header !== ""
              ? column.columnDef.header
              : column.id}
          </label>
        ))}
      </div>
    </details>
  );
}
