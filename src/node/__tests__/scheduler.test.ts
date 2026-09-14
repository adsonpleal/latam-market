/**
 * O agendador: uma coleta por vez, e quem vence durante outra ESPERA em vez de ser pulado.
 *
 * Com os dois servidores a cada 10 minutos, pular a coleta que venceu enquanto a outra
 * rodava perdia metade das coletas de um servidor sempre que o outro atrasava.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyEnv } from "../../config.js";
import { deadlineFor, startScheduler } from "../scheduler.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  applyEnv({ CRAWL_TRADING_MIN: "10", CRAWL_MARKET_MIN: "360" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("a coleta que vence durante outra entra na fila e começa quando a outra termina", async () => {
  const started: string[] = [];
  const finish = new Map<string, () => void>();
  const scheduler = startScheduler(
    (dataset, server) =>
      new Promise<void>((resolve) => {
        started.push(`${dataset}:${server}`);
        finish.set(`${dataset}:${server}`, resolve);
      }),
  );

  // FREYA trading em 2 min; NIDHOGG trading 5 min depois (meia janela).
  await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
  expect(started).toEqual(["trading:FREYA"]);

  await vi.advanceTimersByTimeAsync(6 * 60_000);
  // NIDHOGG venceu, mas FREYA ainda roda: esperou, não foi pulado.
  expect(started).toEqual(["trading:FREYA"]);

  finish.get("trading:FREYA")!();
  await vi.advanceTimersByTimeAsync(1);
  expect(started).toEqual(["trading:FREYA", "trading:NIDHOGG"]);
  scheduler.stop();
});

it("o mesmo dataset/servidor não entra duas vezes na fila", async () => {
  let runs = 0;
  let release: () => void = () => {};
  const scheduler = startScheduler(
    () =>
      new Promise<void>((resolve) => {
        runs++;
        release = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(2 * 60_000 + 1); // FREYA começa e trava
  await vi.advanceTimersByTimeAsync(60 * 60_000); // vários ciclos vencem enquanto isso
  release();
  await vi.advanceTimersByTimeAsync(1);
  // Uma rodando + uma de cada que venceu (NIDHOGG, FREYA de novo, market-price) — nunca N de FREYA.
  expect(runs).toBeLessThanOrEqual(4);
  scheduler.stop();
});

it("prazo: trading é o próprio período com teto de 9 min; market-price, 30 min", () => {
  expect(deadlineFor("trading", "FREYA")).toBe(9 * 60_000);
  applyEnv({ CRAWL_TRADING_MIN: "5" });
  expect(deadlineFor("trading", "FREYA")).toBe(5 * 60_000);
  expect(deadlineFor("market-price", "FREYA")).toBe(30 * 60_000);
});
