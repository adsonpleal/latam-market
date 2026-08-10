/**
 * "O que vender agora".
 *
 * A lista vem pronta na resposta do `/replay` — o backend já filtra por valor mínimo e
 * concorrência e escreve a justificativa em pt-BR (`core/replay.ts:sellCandidates`).
 * Aqui é só apresentação; refazer o critério no cliente criaria duas regras para a
 * mesma pergunta.
 */

import type { SellCandidate } from "../api/types.js";
import { zeny } from "../lib/format.js";
import { ItemCell } from "./ItemCell.js";

interface Props {
  candidates: SellCandidate[];
  descriptions: Record<string, string>;
  onSelect: (itemId: number) => void;
}

export function SellCandidates({ candidates, descriptions, onSelect }: Props) {
  if (candidates.length === 0) return null;

  return (
    <section className="candidates">
      <h3>O que vale a pena vender</h3>
      <p className="lead-small">
        Acima de 10.000z e com no máximo 15 lojas concorrendo. Equipados não entram.
      </p>
      <ul>
        {candidates.map((candidate) => (
          <li key={`${candidate.item.itemId}-${candidate.slot}`}>
            <ItemCell
              item={candidate.item}
              refine={candidate.refine}
              descriptions={descriptions}
              onSelect={onSelect}
            />
            <span className="candidate-value">{zeny(candidate.total)}</span>
            <span className="candidate-reason">{candidate.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
