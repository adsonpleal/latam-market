/**
 * Configuração do alerta de um item.
 *
 * Duas direções porque este app serve os dois lados: quem compra quer saber que baixou,
 * quem vende quer saber que subiu — e a tela de detalhe já pergunta "por quanto devo
 * vender?". A terceira opção, "à venda", é para o item raro, que se compra a qualquer preço
 * e cuja pergunta é só "apareceu?"; ela esconde o campo de alvo, que ali não significa nada.
 *
 * O servidor aparece escrito porque o alvo pertence a ele. FREYA e NIDHOGG cotam o mesmo
 * item por preços muito diferentes, e um alvo herdado do outro mercado dispararia na hora
 * ou nunca.
 */

import { useState } from "react";

import type { Server } from "../api/client.js";
import { usesTarget } from "../lib/alerts.js";
import { zeny } from "../lib/format.js";
import type { Alert, Direction } from "../lib/persist.js";
import { Modal } from "./Modal.js";

interface Props {
  itemId: number;
  itemName: string;
  server: Server;
  /** Menor preço nas lojas abertas agora, para a pessoa ter referência. */
  currentMin: number | null;
  alert: Alert | undefined;
  onSave: (patch: Partial<Alert>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function AlertModal({
  itemId,
  itemName,
  server,
  currentMin,
  alert,
  onSave,
  onRemove,
  onClose,
}: Props) {
  const [enabled, setEnabled] = useState(alert?.enabled ?? true);
  const [direction, setDirection] = useState<Direction>(alert?.direction ?? "down");
  const [target, setTarget] = useState(alert && alert.targetPrice > 0 ? String(alert.targetPrice) : "");
  const [error, setError] = useState<string | null>(null);

  const withTarget = usesTarget(direction);

  const save = (): void => {
    // Sem `targetPrice` no patch do modo sem alvo: o alvo de antes fica guardado para quem
    // voltar a um alerta de preço.
    const patch: Partial<Alert> = { enabled, direction };
    if (withTarget) {
      const value = Number(target.replace(/\D/g, ""));
      if (!Number.isFinite(value) || value <= 0) {
        setError("Informe um valor maior que zero.");
        return;
      }
      patch.targetPrice = value;
    }
    onSave(patch);
    onClose();
  };

  return (
    <Modal label={`Alerta de ${itemName}`} onClose={onClose}>
      <h3>Alerta — {itemName}</h3>
      <p className="lead">
        #{itemId} · vale para <strong>{server}</strong> · menor preço agora: {zeny(currentMin)}
      </p>

      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Alerta ligado
      </label>

      <fieldset className="alert-direction">
        <legend>Quando avisar</legend>
        <label className="toggle">
          <input
            type="radio"
            name="direction"
            checked={direction === "down"}
            onChange={() => setDirection("down")}
          />
          Quando o menor preço <strong>cair</strong> para este valor ou menos
        </label>
        <label className="toggle">
          <input
            type="radio"
            name="direction"
            checked={direction === "up"}
            onChange={() => setDirection("up")}
          />
          Quando o menor preço <strong>subir</strong> para este valor ou mais
        </label>
        <label className="toggle">
          <input
            type="radio"
            name="direction"
            checked={direction === "available"}
            onChange={() => setDirection("available")}
          />
          Quando aparecer <strong>à venda</strong>, a qualquer preço
        </label>
      </fieldset>

      {withTarget && (
        <>
          <label className="toggle">
            Preço alvo
            <input
              type="text"
              inputMode="numeric"
              placeholder="Ex.: 1200000"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </label>
          {/* Dentro do bloco: o único erro possível é o do alvo, e trocar para o modo sem
              alvo o esconde junto com o campo. */}
          {error && <p className="error">{error}</p>}
        </>
      )}

      <p className="footer-note">
        {!withTarget
          ? "Avisa uma vez quando alguma loja puser o item à venda — se já estiver à venda, " +
            "no próximo ciclo. Não reavisa enquanto houver loja vendendo: rearma sozinho " +
            "quando o item some de todas as lojas."
          : "Para não encher o celular, o aviso não se repete no mesmo preço: só sai de novo se " +
            "o preço andar mais na direção escolhida. Ele rearma sozinho quando o preço volta " +
            "para o outro lado do alvo — e mudar o alvo rearma na hora."}
      </p>

      <div className="modal-actions">
        {alert && (
          <button
            className="ghost"
            onClick={() => {
              onRemove();
              onClose();
            }}
          >
            Remover alerta
          </button>
        )}
        <button className="ghost" onClick={onClose}>
          Cancelar
        </button>
        <button onClick={save}>Salvar</button>
      </div>
    </Modal>
  );
}
