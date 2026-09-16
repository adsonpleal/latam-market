/**
 * De onde vêm os preços, e quanto se está pedindo ao site.
 *
 * Tudo que esta aba consulta sai do computador da pessoa, com o IP dela. O painel existe
 * para isso nunca ser surpresa: mostra a cota gasta, sugere até quantos itens vigiar para o
 * intervalo escolhido e lista as últimas consultas. O aviso de onde saem as requisições mora
 * em "Como conectar" (`BridgeInstall`), que abre sozinho enquanto não há conexão
 * — ou seja, é lido antes da primeira consulta.
 */

import { useMemo, useState } from "react";

import type { BridgeState } from "../bridge/client.js";
import { agoMs, duration, plural } from "../lib/format.js";
import {
  INTERVAL_OPTIONS,
  WINDOW_CAP,
  estimateCycleMs,
  suggestedMaxRequests,
  usedInWindow,
} from "../lib/market/budget.js";
import type { RequestLogEntry } from "../lib/market/checks.js";
import { activePause } from "../lib/market/quarantine.js";
import { bridgeLandingUrl } from "../lib/market/url.js";
import type { FavoriteWatch } from "../state/useFavoriteWatch.js";
import { useNow } from "../state/useNow.js";
import type { Server } from "../lib/server.js";
import { BridgeInstall } from "./BridgeInstall.js";

const BRIDGE_LABEL: Record<BridgeState, { text: string; className: string }> = {
  connected: { text: "Conectado ao mercado", className: "is-on" },
  stale: { text: "Conexão sem resposta", className: "is-warn" },
  outdated: { text: "Conexão desatualizada — arraste o favorito de novo", className: "is-warn" },
  disconnected: { text: "Desconectado do mercado", className: "is-off" },
};

interface Props {
  watch: FavoriteWatch;
  server: Server;
}

export function PriceWatchPanel({ watch, server }: Props) {
  const { bridge, notify, targets, queue, current, favorites } = watch;
  const [installOpen, setInstallOpen] = useState(bridge.state === "disconnected");
  // O relógio é assinado aqui, e não no laço: assim o minuto que passa re-renderiza esta
  // barra, e não a árvore inteira (a tabela do inventário inclusive).
  const now = useNow(30_000);
  const used = usedInWindow(watch.starts, now);
  const pause = activePause(watch.quarantine, now);
  const intervalMin = notify.config.intervalMin;
  const suggested = suggestedMaxRequests(intervalMin);
  // A recomendação é em requisições, e não em itens: agrupados, vinte favoritos podem custar
  // oito (ver `planQueries`).
  const { cycleRequests, allRequests } = watch;
  const over = cycleRequests > suggested;
  const label = BRIDGE_LABEL[bridge.state];
  const busy = current.length > 0 || queue.length > 0;
  const cycle = useMemo(() => duration(estimateCycleMs(cycleRequests)), [cycleRequests]);
  const canQuery = bridge.state === "connected" && pause === null;

  return (
    <section className="notify-bar price-watch">
      <div className="notify-bar-head">
        <span className={`bridge-state ${label.className}`}>
          <span className="dot" /> {label.text}
        </span>
        {/* Conectada, a aba já existe: o botão só abriria (ou traria para a frente) a mesma. */}
        {bridge.state !== "connected" && (
          <button onClick={() => bridge.open(bridgeLandingUrl(server))}>Abrir aba do mercado</button>
        )}
        <button className="ghost" onClick={() => setInstallOpen(!installOpen)} aria-expanded={installOpen}>
          {installOpen ? "▾" : "▸"} Como conectar
        </button>

        <span className="notify-bar-summary">
          {busy
            ? `consultando… ${plural(queue.length + current.length, "item restante", "itens restantes")} em ${plural(
                watch.queuedRequests + (current.length > 0 ? 1 : 0),
                "consulta",
                "consultas",
              )}`
            : watch.lastCycleAt === null
              ? "ainda não consultou"
              : `último ciclo ${agoMs(watch.lastCycleAt)}`}
          {" · "}
          <span className={used >= WINDOW_CAP ? "warn" : undefined}>
            {used}/{WINDOW_CAP} consultas nos últimos 15 min
          </span>
        </span>

        {busy ? (
          <button className="ghost" onClick={watch.cancel}>
            Parar
          </button>
        ) : (
          <>
            <button
              className="ghost"
              onClick={watch.checkNow}
              disabled={!canQuery || targets.length === 0}
              title={
                targets.length === 0
                  ? "Nenhum favorito com alerta ligado neste servidor"
                  : `Consulta agora os itens com alerta: ${plural(cycleRequests, "consulta", "consultas")}`
              }
            >
              Verificar alertas
            </button>
            <button
              onClick={watch.checkAll}
              disabled={!canQuery || favorites.ids.length === 0}
              title="Consulta o preço de todos os favoritos, com ou sem alerta, respeitando o espaçamento"
            >
              Atualizar todos os preços
              {favorites.ids.length > 0 && <small> ({plural(allRequests, "consulta", "consultas")})</small>}
            </button>
          </>
        )}
      </div>

      {installOpen && <BridgeInstall />}

      {/* Recolhido: é configuração que se ajusta uma vez e explicação que se lê uma vez. A
          linha do resumo diz o essencial — e fica amarela sozinha quando passa do recomendado,
          que é o único caso em que vale abrir sem ter pensado nisso. */}
      <details className="watch-details">
        <summary className={over ? "warn" : undefined}>
          Checagem a cada {intervalMin} min · {plural(cycleRequests, "consulta", "consultas")} por ciclo
          {over && ` · acima das ${suggested} recomendadas`}
        </summary>

        <div className="watch-settings">
          <label className="toggle">
            Checar os itens com alerta a cada
            <select
              value={intervalMin}
              onChange={(e) => notify.update({ intervalMin: Number(e.target.value) })}
            >
              {INTERVAL_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>

          <span className={over ? "budget-hint warn" : "budget-hint"}>
            {plural(targets.length, "item com alerta", "itens com alerta")} em {server} ={" "}
            {plural(cycleRequests, "consulta", "consultas")} por ciclo · recomendado até{" "}
            <strong>{suggested}</strong> para {intervalMin} min
            {/* Com uma consulta só não há espera, e "~0 s" não diz nada. */}
            {cycleRequests > 1 && <> · cada ciclo leva ~{cycle}</>}
          </span>
        </div>

        {over && (
          <p className="note note-warn">
            Acima da recomendação nada quebra — as consultas só esperam a cota abrir e o ciclo demora
            mais. Mas a cota fica sem folga para a sua própria navegação no mercado, e o risco de
            bloqueio sobe. Aumente o intervalo ou desligue o alerta de alguns itens.
          </p>
        )}

        <p className="note">
          Favoritos de nome parecido saem numa consulta só — uma busca por "Zangão" traz as três
          cartas de Zangão de uma vez.
        </p>

        <RequestLog log={watch.log} />
      </details>
    </section>
  );
}

function RequestLog({ log }: { log: RequestLogEntry[] }) {
  if (log.length === 0) return null;
  return (
    <div className="request-log">
      <strong>Últimas consultas feitas deste computador</strong>
      <div className="table-scroll">
        <table className="offers">
          <thead>
            <tr>
              <th>Hora</th>
              <th>Busca</th>
              <th>Itens</th>
              <th>HTTP</th>
              <th>Resultado</th>
              <th>Tempo</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e) => (
              <tr key={`${e.at}-${e.term}`} className={e.outcome === "ok" ? undefined : "is-bad"}>
                <td>{new Date(e.at).toLocaleTimeString("pt-BR")}</td>
                <td>{e.term}</td>
                <td>{e.items}</td>
                <td>{e.status === 0 ? "—" : e.status}</td>
                <td>{OUTCOME_LABEL[e.outcome]}</td>
                <td>{(e.ms / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const OUTCOME_LABEL: Record<RequestLogEntry["outcome"], string> = {
  ok: "ok",
  blocked: "bloqueado (429)",
  challenge: "verificação do Cloudflare",
  soft: "página sem a lista",
  error: "erro",
};
