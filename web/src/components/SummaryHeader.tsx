import type { ReplayResponse } from "../api/types.js";
import { dateTime, zeny } from "../lib/format.js";
import { FreshnessBadge } from "./Freshness.js";

interface Props {
  valuation: ReplayResponse;
  /** Valor do que está visível depois dos filtros — pode diferir do total. */
  filteredValue: number;
  filteredCount: number;
  filteredUnpriced: number;
}

export function SummaryHeader({
  valuation,
  filteredValue,
  filteredCount,
  filteredUnpriced,
}: Props) {
  const { character, inventory, cart, equipped } = valuation;

  return (
    <header className="summary">
      <div className="summary-main">
        <h2>
          {character.name}
          <small>
            {character.map} · base {character.baseLevel} / classe {character.jobLevel}
          </small>
        </h2>
        <p className="summary-recorded">Replay gravado em {dateTime(valuation.recordedAt)}</p>
      </div>

      <div className="summary-figures">
        <Figure label="Selecionado" value={zeny(filteredValue)} hint={`${filteredCount} itens`} strong />
        <Figure label="Total do replay" value={zeny(valuation.totalValue)} />
        <Figure label="Mochila" value={zeny(inventory.value)} hint={`${inventory.items.length} itens`} />
        <Figure label="Carrinho" value={zeny(cart.value)} hint={`${cart.items.length} itens`} />
        <Figure label="Equipado" value={zeny(equipped.value)} hint={`${equipped.items.length} itens`} />
      </div>

      <FreshnessBadge freshness={valuation.freshness} />

      {/* O backend também manda uma nota de "sem preço", mas sobre o replay inteiro.
          Esta é sobre o que os filtros deixaram na tela, e o texto precisa dizer isso —
          senão saem dois avisos quase idênticos com números diferentes. */}
      {filteredUnpriced > 0 && (
        <p className="note">
          Nesta seleção, {filteredUnpriced} item(ns) estão sem preço e ficaram fora do
          valor acima.
        </p>
      )}
      {valuation.notes.map((note) => (
        <p key={note} className="note">
          {note}
        </p>
      ))}
    </header>
  );
}

function Figure({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className={`figure${strong ? " figure-strong" : ""}`}>
      <span className="figure-label">{label}</span>
      <span className="figure-value">{value}</span>
      {hint && <span className="figure-hint">{hint}</span>}
    </div>
  );
}
