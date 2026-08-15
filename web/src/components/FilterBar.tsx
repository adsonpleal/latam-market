import type { Filters, Origin } from "../lib/rows.js";
import { ORIGIN_LABEL } from "../lib/rows.js";

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  availableOrigins: Origin[];
  unsellableCount: number;
  unpricedCount: number;
  untradableFailed: boolean;
  onExport: () => void;
  onClear: () => void;
}

/**
 * Um limite numérico opcional.
 *
 * O campo vazio é `null` — "sem limite" — e não `0`; ver o comentário em `Filters`. Como
 * o `<input type="number">` também devolve string vazia para um valor intermediário
 * inválido ("1e", "--"), a regra vale para os dois casos: enquanto não houver número, o
 * filtro está desligado, em vez de saltar para um piso de zero que esconderia linhas.
 *
 * A ressalva vem junto (`hint`) em vez de solta na linha: ela fala de UM campo, e ao lado
 * dele só por vizinhança se separaria dele na primeira quebra de linha.
 */
function Limit({
  label,
  value,
  placeholder,
  hint,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder: string;
  hint?: string;
  onChange: (next: number | null) => void;
}) {
  return (
    <label className="toggle limit">
      {label}
      <input
        type="number"
        min={0}
        inputMode="numeric"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const parsed = Number(raw);
          onChange(raw === "" || !Number.isFinite(parsed) ? null : parsed);
        }}
      />
      {hint && <small className="note">{hint}</small>}
    </label>
  );
}

export function FilterBar({
  filters,
  onChange,
  availableOrigins,
  unsellableCount,
  unpricedCount,
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

      {/* Segunda linha: em cima fica O QUE entra (origem, nome) e as ações; aqui, o quanto.
          `flex-basis: 100%` no CSS força a quebra, sem um segundo container que teria de
          repetir o espaçamento e a nota de erro abaixo. Com os dois "esconder" na linha de
          cima, a barra passava de 1265px e jogava o "Exportar CSV" sozinho no meio. */}
      <div className="filter-refine">
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

        <label className="toggle">
          <input
            type="checkbox"
            checked={filters.hideUnpriced}
            onChange={(e) => onChange({ ...filters, hideUnpriced: e.target.checked })}
          />
          Esconder sem preço
          {unpricedCount > 0 && <small> ({unpricedCount})</small>}
        </label>

        <Limit
          label="Total ≥"
          value={filters.minTotal}
          placeholder="zeny"
          onChange={(minTotal) => onChange({ ...filters, minTotal })}
        />
        <Limit
          label="Lojas ≤"
          value={filters.maxStores}
          placeholder="concorrentes"
          onChange={(maxStores) => onChange({ ...filters, maxStores })}
        />
        <Limit
          label="Já vendidos ≥"
          value={filters.minSold}
          placeholder="unidades"
          hint="acumulado do site, não a velocidade de venda de hoje"
          onChange={(minSold) => onChange({ ...filters, minSold })}
        />
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
