/**
 * A cota de requisições.
 *
 * É o teste que segura a promessa feita na tela: "as consultas saem do seu IP, e o app é
 * razoável com elas". Se `nextSlot` errar para baixo, o bloqueio cai na pessoa, e não em nós.
 */

import { describe, expect, it } from "vitest";

import {
  INTERVAL_OPTIONS,
  SPACING_MS,
  WINDOW_CAP,
  WINDOW_MS,
  estimateCycleMs,
  nextSlot,
  suggestedMaxRequests,
  usedInWindow,
} from "../budget.js";

const NOW = 1_800_000_000_000;

describe("nextSlot", () => {
  it("sem nada gasto, pode agora", () => {
    expect(nextSlot([], NOW)).toBe(NOW);
  });

  it("espaça os inícios", () => {
    expect(nextSlot([NOW - 1_000], NOW)).toBe(NOW - 1_000 + SPACING_MS);
    expect(nextSlot([NOW - 60_000], NOW)).toBe(NOW);
  });

  it("com a janela cheia, espera a mais antiga sair — nunca manda por cima", () => {
    // 30 requisições, uma por minuto... não: uma a cada 20 s, a primeira há 10 min.
    const starts = Array.from({ length: WINDOW_CAP }, (_, i) => NOW - 600_000 + i * 20_000);
    const at = nextSlot(starts, NOW);
    expect(at).toBe(starts[0]! + WINDOW_MS);
    // E no instante liberado, a janela tem de fato uma vaga.
    expect(usedInWindow(starts, at)).toBe(WINDOW_CAP - 1);
  });

  it("não depende da ordem em que os inícios foram gravados", () => {
    const starts = Array.from({ length: WINDOW_CAP }, (_, i) => NOW - i * 10_000);
    expect(nextSlot(starts, NOW)).toBe(nextSlot([...starts].reverse(), NOW));
  });

  it("inícios fora da janela não contam", () => {
    const old = Array.from({ length: 100 }, (_, i) => NOW - WINDOW_MS - i);
    expect(nextSlot(old, NOW)).toBe(NOW);
  });
});

describe("suggestedMaxRequests", () => {
  it("divide a cota pelos ciclos que cabem numa janela", () => {
    expect(suggestedMaxRequests(5)).toBe(7);
    expect(suggestedMaxRequests(10)).toBe(15);
    expect(suggestedMaxRequests(15)).toBe(15);
    expect(suggestedMaxRequests(30)).toBe(30);
    expect(suggestedMaxRequests(60)).toBe(30);
  });

  it("com a sugestão, a cota nunca precisa segurar uma requisição", () => {
    for (const interval of INTERVAL_OPTIONS) {
      const items = suggestedMaxRequests(interval);
      const starts: number[] = [];
      // Duas horas de ciclos, cada item só com o espaçamento — sem a janela interferir.
      for (let cycle = 0; cycle * interval < 120; cycle++) {
        const begin = NOW + cycle * interval * 60_000;
        for (let i = 0; i < items; i++) {
          const at = begin + i * SPACING_MS;
          expect(nextSlot(starts, at), `intervalo ${interval}, ciclo ${cycle}, item ${i}`).toBe(at);
          starts.push(at);
        }
      }
    }
  });
});

describe("estimateCycleMs", () => {
  it("dentro da cota, é o espaçamento", () => {
    expect(estimateCycleMs(1)).toBe(0);
    expect(estimateCycleMs(20)).toBe(19 * SPACING_MS);
  });

  it("acima da cota, inclui a espera pela janela", () => {
    expect(estimateCycleMs(WINDOW_CAP + 1)).toBe(WINDOW_MS);
  });
});
