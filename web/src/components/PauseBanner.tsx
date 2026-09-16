/**
 * A faixa de "o site recusou".
 *
 * Grande e vermelha no 429 de propósito: é a única situação em que continuar mexendo piora
 * — cada visita ao mercado nesse período gasta da mesma cota bloqueada. A contagem regressiva
 * responde a pergunta que vem em seguida ("quando volta?") sem a pessoa precisar calcular.
 */

import { duration, time } from "../lib/format.js";
import type { Pause } from "../lib/market/quarantine.js";
import { useNow } from "../state/useNow.js";

interface Props {
  pause: Pause;
  strikes: number;
  onRetryChallenge: () => void;
}

export function PauseBanner({ pause, strikes, onRetryChallenge }: Props) {
  const now = useNow(1_000);
  const left = pause.until === null ? null : Math.max(0, pause.until - now);

  if (pause.kind === "challenge") {
    return (
      <div className="pause-banner is-challenge" role="alert">
        <strong>O site pediu a verificação do Cloudflare ({time(pause.since)}).</strong>
        <p>
          As consultas estão pausadas até você resolver. Vá até a aba do mercado, recarregue a
          página, conclua a verificação se ela aparecer e clique no favorito{" "}
          <strong>Conectar latam-market</strong> de novo — a pausa sai sozinha quando a conexão
          reconectar.
        </p>
        <button className="ghost" onClick={onRetryChallenge}>
          Já resolvi, tentar de novo
        </button>
      </div>
    );
  }

  if (pause.kind === "soft") {
    return (
      <div className="pause-banner is-soft" role="status">
        <strong>O site respondeu sem a lista de anúncios algumas vezes seguidas.</strong>
        <p>
          Pode ser instabilidade ou uma mudança no site. Nova tentativa em{" "}
          <strong>{duration(left ?? 0)}</strong>, às {time(pause.until!)}.
        </p>
      </div>
    );
  }

  return (
    <div className="pause-banner is-blocked" role="alert">
      <strong>
        O site do mercado bloqueou o seu IP (HTTP 429) às {time(pause.since)}
        {strikes > 1 && ` — ${strikes}º bloqueio seguido`}.
      </strong>
      <p>
        Consultas pausadas até <strong>{time(pause.until!)}</strong> (faltam{" "}
        <strong>{duration(left ?? 0)}</strong>). Evite abrir o mercado nesse período: cada visita
        gasta da mesma cota. Depois da pausa, uma consulta só testa se o bloqueio acabou; se não
        acabou, a próxima pausa dobra.
      </p>
    </div>
  );
}
