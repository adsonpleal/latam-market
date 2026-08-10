import type { Filters, Origin } from "../lib/rows.js";
import { ORIGIN_LABEL } from "../lib/rows.js";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  availableOrigins: Origin[];
  unsellableCount: number;
  untradableFailed: boolean;
  onExport: () => void;
  onClear: () => void;
}

export function FilterBar({
  filters,
  onChange,
  availableOrigins,
  unsellableCount,
  untradableFailed,
  onExport,
  onClear,
}: Props) {
  const toggleOrigin = (origin: Origin): void => {
    const origins = new Set(filters.origins);
    if (origins.has(origin)) origins.delete(origin);
    else origins.add(origin);
    onChange({ ...filters, origins });
  };

  return (
    <div className="filters">
      <div className="filter-group">
        {availableOrigins.map((origin) => (
          <button
            key={origin}
            className={`chip${filters.origins.has(origin) ? " chip-on" : ""}`}
            onClick={() => toggleOrigin(origin)}
          >
            {ORIGIN_LABEL[origin]}
          </button>
        ))}
      </div>

      <label className="toggle">
        <input
          type="checkbox"
          checked={filters.hideUntradable}
          disabled={untradableFailed}
          onChange={(e) => onChange({ ...filters, hideUntradable: e.target.checked })}
        />
        Esconder o que não dá para vender
        {!untradableFailed && unsellableCount > 0 && <small> ({unsellableCount})</small>}
      </label>

      <input
        className="search"
        type="search"
        placeholder="Filtrar por nome…"
        value={filters.search}
        onChange={(e) => onChange({ ...filters, search: e.target.value })}
      />

      <div className="filter-actions">
        <button onClick={onExport}>Exportar CSV</button>
        <button className="ghost" onClick={onClear}>
          Limpar
        </button>
      </div>

      {untradableFailed && (
        <p className="note note-warn">
          A lista de itens intransferíveis não carregou, então o filtro está desligado e
          a tabela mostra tudo.
        </p>
      )}
    </div>
  );
}
