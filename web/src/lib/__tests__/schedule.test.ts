/**
 * A conta que decide de quanto em quanto tempo a aba pergunta.
 *
 * É onde mora a promessa de não sobrecarregar o servidor: se esta função errar para baixo,
 * cada aba aberta passa a bater de minuto em minuto sem nenhum dado novo para ler. Não há
 * mais intervalo configurável — a cadência vem inteira do `nextTradingAt` da API.
 */

import { describe, expect, it } from "vitest";

import { collectionDue, nextWaitMs } from "../schedule.js";

const MIN = 60 * 1_000;
const MAX = 30 * 60 * 1_000;
const RETRY = 3 * 60 * 1_000;
const NOW = 1_700_000_000_000;

const wait = (over: Partial<Parameters<typeof nextWaitMs>[0]> = {}) =>
  nextWaitMs({ nextTradingAt: null, stale: false, nowMs: NOW, jitter: 0, ...over });

describe("nextWaitMs", () => {
  it("com a próxima coleta no futuro, dorme até ela", () => {
    // Coleta em 10 minutos.
    expect(wait({ nextTradingAt: NOW / 1_000 + 600 })).toBe(600_000);
  });

  it("o jitter só atrasa, para as abas não baterem todas no mesmo segundo", () => {
    const at = NOW / 1_000 + 600;
    expect(wait({ nextTradingAt: at, jitter: 1 })).toBe(600_000 + 120_000);
    expect(wait({ nextTradingAt: at, jitter: 0.5 })).toBe(600_000 + 60_000);
  });

  it("sem nunca ter havido coleta, espera um tempo fixo em vez de escolher no escuro", () => {
    expect(wait({ nextTradingAt: null })).toBe(10 * 60_000);
  });

  it("coleta que já deveria ter saído vira retentativa curta, não outra janela inteira", () => {
    expect(wait({ nextTradingAt: NOW / 1_000 - 60 })).toBe(RETRY);
  });

  it("dado repetido encurta a espera em vez de esperar a coleta seguinte", () => {
    // Falta muito para a próxima, mas o retrato ainda é o antigo: a coleta atrasou.
    expect(wait({ nextTradingAt: NOW / 1_000 + 1_500, stale: true })).toBe(RETRY);
  });

  it("dado repetido não estica a espera quando a coleta está logo aí", () => {
    expect(wait({ nextTradingAt: NOW / 1_000 + 90, stale: true })).toBe(90_000);
  });

  it("nunca abaixo do piso do navegador", () => {
    expect(wait({ nextTradingAt: NOW / 1_000 + 5 })).toBe(MIN);
  });

  it("nunca acima do teto — relógio errado não pode parar os alertas por horas", () => {
    expect(wait({ nextTradingAt: NOW / 1_000 + 86_400 })).toBe(MAX);
  });

  it("o resultado está sempre dentro dos limites", () => {
    for (const nextTradingAt of [null, NOW / 1_000 - 1e6, NOW / 1_000, NOW / 1_000 + 1e6]) {
      for (const stale of [true, false]) {
        for (const jitter of [0, 0.5, 1]) {
          const ms = nextWaitMs({ nextTradingAt, stale, nowMs: NOW, jitter });
          expect(ms).toBeGreaterThanOrEqual(MIN);
          expect(ms).toBeLessThanOrEqual(MAX);
        }
      }
    }
  });
});

/**
 * Usado na volta para a aba: só vale pedir de novo se pode haver dado novo do outro lado.
 * Sem isto, alternar de aba dez vezes em cinco minutos daria dez requisições.
 */
describe("collectionDue", () => {
  it("falso enquanto a coleta prevista está no futuro", () => {
    expect(collectionDue(NOW / 1_000 + 60, NOW)).toBe(false);
  });

  it("verdadeiro quando a hora prevista chegou ou passou", () => {
    expect(collectionDue(NOW / 1_000, NOW)).toBe(true);
    expect(collectionDue(NOW / 1_000 - 1, NOW)).toBe(true);
  });

  it("sem previsão, deixa checar", () => {
    expect(collectionDue(null, NOW)).toBe(true);
  });
});
