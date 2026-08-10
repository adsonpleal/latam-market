/** Seletor de janela em dias, compartilhado por Pechinchas e Variações. */
export function WindowSelect({
  days,
  onChange,
  options,
}: {
  days: number;
  onChange: (days: number) => void;
  options: number[];
}) {
  return (
    <label className="toggle">
      Janela
      <select value={days} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((n) => (
          <option key={n} value={n}>
            {n} dias
          </option>
        ))}
      </select>
    </label>
  );
}
