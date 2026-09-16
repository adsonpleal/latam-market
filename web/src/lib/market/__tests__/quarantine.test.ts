import { describe, expect, it } from "vitest";

import {
  BLOCK_BASE_MS,
  BLOCK_CAP_MS,
  EMPTY_QUARANTINE,
  SOFT_FAIL_LIMIT,
  SOFT_PAUSE_MS,
  STRIKES_FORGET_MS,
  activePause,
  clearChallenge,
  parseQuarantine,
  record,
  type Quarantine,
} from "../quarantine.js";

const NOW = 1_800_000_000_000;

describe("429", () => {
  it("pausa 15 min no primeiro, e dobra a cada bloqueio seguido", () => {
    let q = record(EMPTY_QUARANTINE, "blocked", NOW);
    expect(q.pause).toEqual({ kind: "blocked", since: NOW, until: NOW + BLOCK_BASE_MS });

    // A sonda depois da pausa levou outro 429.
    const later = NOW + BLOCK_BASE_MS + 1;
    q = record(q, "blocked", later);
    expect(q.strikes).toBe(2);
    expect(q.pause!.until).toBe(later + 2 * BLOCK_BASE_MS);
  });

  it("não passa de 6 h", () => {
    let q: Quarantine = EMPTY_QUARANTINE;
    for (let i = 0; i < 12; i++) q = record(q, "blocked", NOW + i);
    expect(q.pause!.until! - q.pause!.since).toBe(BLOCK_CAP_MS);
  });

  it("uma resposta boa zera a contagem", () => {
    const q = record(record(EMPTY_QUARANTINE, "blocked", NOW), "ok", NOW + BLOCK_BASE_MS);
    expect(q).toMatchObject({ pause: null, strikes: 0, softFails: 0 });
    expect(record(q, "blocked", NOW + BLOCK_BASE_MS + 1).strikes).toBe(1);
  });

  it("12 h sem bloqueio esquecem os anteriores", () => {
    let q = record(record(EMPTY_QUARANTINE, "blocked", NOW), "blocked", NOW + 1);
    q = record(q, "blocked", NOW + 1 + STRIKES_FORGET_MS + 1);
    expect(q.strikes).toBe(1);
  });

  it("a pausa vale até o fim, e depois deixa de valer sem precisar apagar", () => {
    const q = record(EMPTY_QUARANTINE, "blocked", NOW);
    expect(activePause(q, NOW + BLOCK_BASE_MS - 1)).not.toBeNull();
    expect(activePause(q, NOW + BLOCK_BASE_MS)).toBeNull();
  });

  it("erro de rede não mexe em nada", () => {
    const q = record(EMPTY_QUARANTINE, "blocked", NOW);
    expect(record(q, "error", NOW + 1)).toBe(q);
  });
});

describe("desafio do Cloudflare", () => {
  it("pausa sem prazo, até a pessoa reconectar", () => {
    const q = record(EMPTY_QUARANTINE, "challenge", NOW);
    expect(activePause(q, NOW + 365 * 86_400_000)?.kind).toBe("challenge");
    expect(activePause(clearChallenge(q), NOW)).toBeNull();
  });

  it("reconectar não tira uma pausa de 429", () => {
    const q = record(EMPTY_QUARANTINE, "blocked", NOW);
    expect(clearChallenge(q)).toBe(q);
  });
});

describe("respostas sem a lista", () => {
  it("só pausa depois de algumas seguidas", () => {
    let q: Quarantine = EMPTY_QUARANTINE;
    for (let i = 1; i < SOFT_FAIL_LIMIT; i++) {
      q = record(q, "soft", NOW);
      expect(q.pause).toBeNull();
    }
    q = record(q, "soft", NOW);
    expect(q.pause).toEqual({ kind: "soft", since: NOW, until: NOW + SOFT_PAUSE_MS });
  });

  it("uma resposta boa no meio recomeça a conta", () => {
    let q = record(record(EMPTY_QUARANTINE, "soft", NOW), "soft", NOW);
    q = record(q, "ok", NOW);
    expect(record(q, "soft", NOW).pause).toBeNull();
  });
});

describe("parseQuarantine", () => {
  it("volta ao vazio com lixo", () => {
    expect(parseQuarantine(null)).toEqual(EMPTY_QUARANTINE);
    expect(parseQuarantine("x")).toEqual(EMPTY_QUARANTINE);
    expect(parseQuarantine({ pause: { kind: "nope", since: 1 } })).toEqual(EMPTY_QUARANTINE);
  });

  it("preserva um estado válido", () => {
    const q = record(record(EMPTY_QUARANTINE, "blocked", NOW), "challenge", NOW + 1);
    expect(parseQuarantine(JSON.parse(JSON.stringify(q)))).toEqual(q);
  });
});
