import type { ReplayInventory } from "../lib/replay/inventory.js";
import { count, dateTime } from "../lib/format.js";

interface Props {
  inventory: ReplayInventory;
  /** Linhas visíveis depois dos filtros. */
  filteredCount: number;
  /** Soma das quantidades visíveis. */
  filteredUnits: number;
}

export function SummaryHeader({ inventory, filteredCount, filteredUnits }: Props) {
  const { character, cart, equipped, storage, guildStorage } = inventory;

  return (
    <header className="summary">
      <div className="summary-main">
        <h2>
          {character.name}
          <small>
            {character.map} · base {character.baseLevel} / classe {character.jobLevel}
          </small>
        </h2>
        <p className="summary-recorded">Replay gravado em {dateTime(inventory.recordedAt)}</p>
      </div>

      <div className="summary-figures">
        <Figure label="Selecionado" value={`${count(filteredCount)} itens`} hint={`${count(filteredUnits)} unidades`} strong />
        <Figure label="Mochila" value={count(inventory.inventory.items.length)} hint="itens" />
        <Figure label="Carrinho" value={count(cart.items.length)} hint="itens" />
        <Figure label="Equipado" value={count(equipped.items.length)} hint="itens" />
        {/* Só aparecem quando a janela foi aberta na gravação. Um "0" para quem não passou no
            Kafra leria como "seu armazém está vazio", que é outra coisa — a nota abaixo
            explica a ausência. A capacidade responde "cabe mais?". */}
        {storage && (
          <Figure label="Armazém" value={count(storage.items.length)} hint={`de ${storage.maxSlots} slots`} />
        )}
        {guildStorage && (
          <Figure
            label="Armazém do clã"
            value={count(guildStorage.items.length)}
            hint={`de ${guildStorage.maxSlots} slots`}
          />
        )}
      </div>

      {inventory.notes.map((note) => (
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
