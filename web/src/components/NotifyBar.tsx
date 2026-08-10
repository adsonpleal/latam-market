/**
 * O canal de notificação e o estado do laço.
 *
 * Colapsável porque é configuração que se faz uma vez: aberta por padrão só quando ainda
 * não há canal ligado, que é justamente quando ela precisa ser vista.
 *
 * A linha sobre "só com a aba aberta" fica sempre visível de propósito. É a limitação real
 * de fazer isto no navegador, e esconder isso significaria alguém contando com um alerta
 * que não vai chegar.
 */

import { useEffect, useState } from "react";

import { ago, plural, upcoming } from "../lib/format.js";
import { sendNtfyTest, suggestTopic } from "../lib/ntfy.js";
import type { AlertsConfigApi } from "../state/useAlertsConfig.js";
import { NtfyHelp } from "./NtfyHelp.js";

type TestState = "idle" | "sending" | "sent" | "failed";

interface Props {
  notify: AlertsConfigApi;
  /** Quantos alertas estão ligados neste servidor. */
  enabledCount: number;
  lastRun: number | null;
  running: boolean;
  /** Epoch em segundos da próxima coleta, quando o servidor sabe. */
  nextTradingAt: number | null;
  onCheckNow: () => void;
}

export function NotifyBar({
  notify,
  enabledCount,
  lastRun,
  running,
  nextTradingAt,
  onCheckNow,
}: Props) {
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
          {" · "}
          {running
            ? "checando…"
            : lastRun === null
              ? "ainda não checou"
              : `última checagem ${ago(lastRun / 1000)}`}
        </span>
        <button
          onClick={onCheckNow}
          disabled={running}
          title="Lê os preços agora, sem esperar a próxima coleta"
        >
          Verificar agora
        </button>
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

          <div className="notify-channel">
            <strong>Quando checa</strong>
            <p className="footer-note">
              Não há o que configurar: os preços só mudam quando a coleta do projeto roda, a
              cada 30 minutos, então a checagem acontece{" "}
              <strong>uma vez por coleta</strong> — logo depois de o dado novo chegar, cerca
              de duas vezes por hora. Perguntar com mais frequência devolveria exatamente os
              mesmos números.
              {nextTradingAt !== null && (
                <>
                  {" "}
                  Próxima coleta prevista <strong>{upcoming(nextTradingAt)}</strong>.
                </>
              )}
            </p>
          </div>

          <p className="footer-note">
            Os alertas só rodam enquanto esta aba estiver aberta, e o navegador pode espaçar
            as checagens quando ela fica no fundo. Fixar a aba ajuda. Se "última checagem"
            envelhecer muito, é isso que aconteceu.
          </p>
        </div>
      )}

      {helpOpen && (
        <NtfyHelp topicExample="latam-market-7f3a91c4" onClose={() => setHelpOpen(false)} />
      )}
    </section>
  );
}
