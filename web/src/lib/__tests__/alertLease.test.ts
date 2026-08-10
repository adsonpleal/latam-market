/**
 * O lease entre abas.
 *
 * Vale teste porque os dois modos de falhar são invisíveis num teste manual rápido: "às
 * vezes chega push dobrado" (validade longa demais) e "os alertas pararam depois que eu
 * fechei a outra aba" (validade amarrada ao intervalo de checagem, que é o erro que este
 * arquivo passou a cobrir).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { LEASE_HEARTBEAT_MS, LEASE_TTL_MS, claimLease } from "../alertLease.js";
import { ALERTS_LEASE_KEY } from "../persist.js";

/** `localStorage` de mentira, para não depender do jsdom nem de limpeza entre testes. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    raw: data,
  };
}

let store: ReturnType<typeof fakeStore>;
beforeEach(() => {
  store = fakeStore();
});

describe("claimLease", () => {
  it("sem lease, a primeira aba assume e grava", () => {
    expect(claimLease(store, "aba-a", 1_000)).toBe(true);
    expect(JSON.parse(store.raw.get(ALERTS_LEASE_KEY)!)).toEqual({ tabId: "aba-a", at: 1_000 });
  });

  it("a segunda aba é recusada enquanto o lease está fresco", () => {
    claimLease(store, "aba-a", 1_000);
    expect(claimLease(store, "aba-b", 1_000 + LEASE_TTL_MS)).toBe(false);
  });

  it("a dona reafirma sempre, e o instante avança", () => {
    claimLease(store, "aba-a", 1_000);
    expect(claimLease(store, "aba-a", 10_000_000)).toBe(true);
    expect(JSON.parse(store.raw.get(ALERTS_LEASE_KEY)!).at).toBe(10_000_000);
  });

  it("passada a validade, outra aba assume — a dona sumiu", () => {
    claimLease(store, "aba-a", 1_000);
    expect(claimLease(store, "aba-b", 1_000 + LEASE_TTL_MS)).toBe(false);
    expect(claimLease(store, "aba-b", 1_000 + LEASE_TTL_MS + 1)).toBe(true);
  });

  /**
   * A regra que motivou a validade fixa.
   *
   * O ciclo pode dormir meia hora entre coletas. Se a validade acompanhasse esse intervalo,
   * fechar a aba dona travaria os alertas de todas as outras por quase uma hora.
   */
  it("a validade não acompanha o intervalo de checagem", () => {
    claimLease(store, "aba-a", 0);
    const meiaHora = 30 * 60 * 1_000;
    expect(claimLease(store, "aba-b", meiaHora)).toBe(true);
    expect(LEASE_TTL_MS).toBeLessThan(meiaHora);
  });

  /** O batimento tem que caber na validade com folga, inclusive estrangulado a 1/min. */
  it("o batimento é bem menor que a validade", () => {
    expect(LEASE_HEARTBEAT_MS).toBeLessThan(LEASE_TTL_MS);
    // Aba de fundo bate cerca de uma vez por minuto; ainda tem de renovar em tempo.
    expect(60_000).toBeLessThan(LEASE_TTL_MS);
  });

  it("lease no futuro (relógio para trás) é reivindicável, e não trava para sempre", () => {
    claimLease(store, "aba-a", 10_000_000);
    expect(claimLease(store, "aba-b", 1_000)).toBe(true);
  });

  it("conteúdo corrompido conta como lease livre, sem lançar", () => {
    for (const lixo of ["{", "null", "[]", '{"tabId":""}', '{"tabId":"a","at":"agora"}']) {
      const s = fakeStore({ [ALERTS_LEASE_KEY]: lixo });
      expect(claimLease(s, "aba-b", 1_000)).toBe(true);
    }
  });

  it("storage que recusa escrita não impede o ciclo de rodar", () => {
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new Error("cota cheia");
      },
    };
    expect(claimLease(readOnly, "aba-a", 1_000)).toBe(true);
  });
});
