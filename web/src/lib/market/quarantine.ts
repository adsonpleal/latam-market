/**
 * O que fazer depois que o site recusa.
 *
 * Espelha a quarentena do coletor, que foi desenhada depois de um erro caro: repetir 60 s
 * depois de um 429 rendeu um bloqueio de 12 horas. A regra que saiu dali vale aqui também —
 * **depois de um 429, a próxima requisição só sai quando a pausa acabar, e ela é a sonda**.
 * Nada de tentar de novo no mesmo ciclo, nada de "só mais um item".
 *
 *  - 429: pausa de 15 min × 2^(bloqueios − 1), no máximo 6 h. Uma resposta boa zera a
 *    contagem; 12 h sem bloqueio também.
 *  - desafio do Cloudflare (403 com `cf-mitigated: challenge`): pausa sem prazo. Quem
 *    resolve é a pessoa, na aba do mercado — a pausa acaba quando a conexão é refeita.
 *  - três respostas seguidas sem a lista: pausa de 10 min. É o site mudando de formato, ou
 *    falhando de um jeito novo, e insistir não descobre qual.
 *
 * Um erro de rede não conta para nada: é a conexão da pessoa, não o site recusando.
 *
 * Puro e sem relógio, como `budget.ts`. O estado vive no `localStorage`.
 */

import { finiteNumber, isRecord } from "../persist.js";

export const BLOCK_BASE_MS = 15 * 60_000;
export const BLOCK_CAP_MS = 6 * 60 * 60_000;
export const STRIKES_FORGET_MS = 12 * 60 * 60_000;
export const SOFT_FAIL_LIMIT = 3;
export const SOFT_PAUSE_MS = 10 * 60_000;

export type PauseKind = "blocked" | "challenge" | "soft";

export interface Pause {
  kind: PauseKind;
  /** Epoch em ms. */
  since: number;
  /** Epoch em ms, ou `null` no desafio, que só acaba quando a pessoa age. */
  until: number | null;
}

export interface Quarantine {
  pause: Pause | null;
  /** Bloqueios seguidos, para a pausa dobrar. */
  strikes: number;
  lastBlockAt: number | null;
  /** Respostas seguidas sem a lista. */
  softFails: number;
}

export const EMPTY_QUARANTINE: Quarantine = {
  pause: null,
  strikes: 0,
  lastBlockAt: null,
  softFails: 0,
};

export type Outcome = "ok" | "blocked" | "challenge" | "soft" | "error";

const blockMs = (strikes: number): number =>
  Math.min(BLOCK_BASE_MS * 2 ** Math.max(0, strikes - 1), BLOCK_CAP_MS);

/** Registra o resultado de uma requisição. Devolve a mesma referência quando nada muda. */
export function record(state: Quarantine, outcome: Outcome, now: number): Quarantine {
  switch (outcome) {
    case "ok":
      if (state.pause === null && state.strikes === 0 && state.softFails === 0) return state;
      return { ...state, pause: null, strikes: 0, softFails: 0 };

    case "blocked": {
      const forgotten = state.lastBlockAt !== null && now - state.lastBlockAt > STRIKES_FORGET_MS;
      const strikes = (forgotten ? 0 : state.strikes) + 1;
      return {
        pause: { kind: "blocked", since: now, until: now + blockMs(strikes) },
        strikes,
        lastBlockAt: now,
        softFails: 0,
      };
    }

    case "challenge":
      return { ...state, pause: { kind: "challenge", since: now, until: null }, softFails: 0 };

    case "soft": {
      const softFails = state.softFails + 1;
      if (softFails < SOFT_FAIL_LIMIT) return { ...state, softFails };
      return {
        ...state,
        pause: { kind: "soft", since: now, until: now + SOFT_PAUSE_MS },
        softFails: 0,
      };
    }

    case "error":
      return state;
  }
}

/** A pausa em vigor, ou `null`. Uma pausa vencida não é apagada aqui — só deixa de valer. */
export function activePause(state: Quarantine, now: number): Pause | null {
  const { pause } = state;
  if (pause === null) return null;
  if (pause.until === null || pause.until > now) return pause;
  return null;
}

/**
 * A pessoa resolveu o desafio e refez a conexão.
 *
 * Só tira a pausa de desafio: uma de 429 continua valendo, porque reabrir a aba do mercado
 * não muda nada do lado do limite.
 */
export function clearChallenge(state: Quarantine): Quarantine {
  return state.pause?.kind === "challenge" ? { ...state, pause: null } : state;
}

/** Lê do storage sem confiar. */
export function parseQuarantine(value: unknown): Quarantine {
  if (!isRecord(value)) return EMPTY_QUARANTINE;
  const p = isRecord(value["pause"]) ? value["pause"] : null;
  const kind = p?.["kind"];
  const since = finiteNumber(p?.["since"]);
  const pause: Pause | null =
    p && (kind === "blocked" || kind === "challenge" || kind === "soft") && since !== null
      ? { kind, since, until: finiteNumber(p["until"]) }
      : null;
  return {
    pause,
    strikes: Math.max(0, Math.floor(finiteNumber(value["strikes"]) ?? 0)),
    lastBlockAt: finiteNumber(value["lastBlockAt"]),
    softFails: Math.max(0, Math.floor(finiteNumber(value["softFails"]) ?? 0)),
  };
}
