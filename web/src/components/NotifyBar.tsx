/**
 * O canal de notificação.
 *
 * Colapsável porque é configuração que se faz uma vez: aberta por padrão só quando ainda
 * não há canal ligado, que é justamente quando ela precisa ser vista. O estado das consultas
 * mora no `PriceWatchPanel`.
 *
 * A linha sobre "só com a aba aberta" fica sempre visível de propósito. É a limitação real
 * de fazer isto no navegador, e esconder isso significaria alguém contando com um alerta
 * que não vai chegar.
 */

import { useEffect, useState } from "react";

import { plural } from "../lib/format.js";
import { sendNtfyTest, suggestTopic } from "../lib/ntfy.js";
import type { AlertsConfigApi } from "../state/useAlertsConfig.js";
import { NtfyHelp } from "./NtfyHelp.js";

type TestState = "idle" | "sending" | "sent" | "failed";

interface Props {
  notify: AlertsConfigApi;
  /** Quantos alertas estão ligados neste servidor. */
  enabledCount: number;
}

export function NotifyBar({ notify, enabledCount }: Props) {
  const { config, update, ready } = notify;
  const [open, setOpen] = useState(!ready);
  const [helpOpen, setHelpOpen] = useState(false);
  const [test, setTest] = useState<TestState>("idle");

  // A confirmação do teste é transitória: sem isto um "✓ Enviado" de dez minutos atrás
  // continuaria na tela como se fosse do último clique.
  useEffect(() => {
    if (test !== "sent" && test !== "failed") return;
    const id = window.setTimeout(() => setTest("idle"), 6_000);
    return () => window.clearTimeout(id);
  }, [test]);

  const runTest = async (): Promise<void> => {
    setTest("sending");
    setTest((await sendNtfyTest(config.ntfyTopic)) ? "sent" : "failed");
  };

  return (
    <section className="notify-bar">
      <div className="notify-bar-head">
        <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "▾" : "▸"} Notificações
        </button>
        <span className="notify-bar-summary">
          {enabledCount === 0 ? (
            "nenhum alerta configurado"
          ) : (
            <>
              <strong>{plural(enabledCount, "alerta ligado", "alertas ligados")}</strong>
              {!ready && " — falta ligar o canal"}
            </>
          )}
        </span>
      </div>

      {open && (
        <div className="notify-bar-panel">
          <div className="notify-channel">
            <label className="toggle">
              <input
                type="checkbox"
                checked={config.ntfyEnabled}
                onChange={(e) => update({ ntfyEnabled: e.target.checked })}
              />
              <strong>Push (ntfy.sh)</strong> — avisa no celular
            </label>

            <div className="notify-topic">
              <input
                type="text"
                placeholder="ex: latam-market-7f3a91c4"
                value={config.ntfyTopic}
                disabled={!config.ntfyEnabled}
                onChange={(e) => update({ ntfyTopic: e.target.value })}
                aria-label="Tópico do ntfy"
              />
              <button
                className="ghost"
                disabled={!config.ntfyEnabled}
                onClick={() => update({ ntfyTopic: suggestTopic() })}
                title="Sugere um nome difícil de adivinhar"
              >
                Gerar
              </button>
              <button className="ghost" onClick={() => setHelpOpen(true)} title="Como configurar">
                ?
              </button>
              <button
                onClick={() => void runTest()}
                disabled={!ready || test === "sending"}
                title="Manda uma notificação de teste para este tópico"
              >
                {test === "sending" ? "Enviando…" : "Testar"}
              </button>
            </div>

            {test === "sent" && <p className="ok">✓ Enviado. Confira o app ntfy no celular.</p>}
            {test === "failed" && (
              <p className="error">✗ Não chegou. Verifique a conexão e o nome do tópico.</p>
            )}
            <p className="footer-note">
              O nome do tópico é uma senha curta: quem souber pode mandar notificação para o
              seu celular. O push vai direto deste navegador para o ntfy — nosso servidor não
              vê o seu tópico.
            </p>
          </div>

          <p className="footer-note">
            Os alertas só rodam enquanto esta aba e a aba do mercado estiverem abertas. As duas
            podem ficar em segundo plano; se o "último ciclo" envelhecer muito, uma delas foi
            fechada ou descarregada pelo navegador.
          </p>
        </div>
      )}

      {helpOpen && (
        <NtfyHelp topicExample="latam-market-7f3a91c4" onClose={() => setHelpOpen(false)} />
      )}
    </section>
  );
}
