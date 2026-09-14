/**
 * A coleta de verdade: uma worker thread carregando um coletor em disco.
 *
 * O coletor falso mora em disco porque é assim que o de verdade é carregado — a thread faz
 * `import()` de um caminho, e um mock de módulo não exercitaria isso. O que se prova:
 *
 *  - os itens chegam da thread e são publicados antes do fim;
 *  - o prazo é duro: uma coleta que nunca resolve é terminada, e o que ela já entregou fica;
 *  - um coletor que quebra não derruba nada — a coleta fecha com erro.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { getCache, resetCaches } from "../../store/cache.js";
import { openDb } from "../../store/db.js";
import type { WritableDb } from "../../store/port.js";
import { sqliteDb } from "../../store/sqlite.js";
import { runCrawl } from "../crawl-runner.js";

const MIGRATIONS = resolve(import.meta.dirname, "..", "..", "..", "migrations");
const THREAD = new URL("../../collect/crawl-thread.mjs", import.meta.url);

let dir: string;
let db: WritableDb;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "latam-crawl-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  db = sqliteDb(openDb({ path: ":memory:", migrationsDir: MIGRATIONS }));
  resetCaches();
});

function collector(body: string): string {
  const file = join(dir, `collector-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, "utf8");
  return file;
}

const LISTING = `{ itemId: 1, itemName: "Poção", databaseImgPath: null, databaseType: null, mapId: 1,
  ssi: "s1", storeName: "Loja", itemPrice: 50, itemCnt: 2, slotMaxCount: "",
  storeTypeName: "BUY", itemSellerCharName: "V" }`;

const REPORT = `{ planned: 1, failures: 0, termsComplete: 1, termsFailed: 0,
  itemsPublished: 1, itemsRemoved: 0, itemsIncomplete: 0 }`;

it("os itens entregues pela thread viram mercado publicado", async () => {
  const path = collector(`
    export async function createCollector() {
      return {
        crawl: async ({ onItems }) => { onItems([{ itemId: 1, rows: [${LISTING}] }]); return ${REPORT}; },
        close: async () => {},
      };
    }`);

  const outcome = await runCrawl({
    db, dataset: "trading", server: "FREYA", collectorPath: path, deadlineMs: 10_000, threadUrl: THREAD,
  });

  expect(outcome.error).toBeUndefined();
  expect(outcome.result).toMatchObject({ published: 1, fresh: true });
  expect(getCache("FREYA").listings.get(1)![0]).toMatchObject({ price: 50, cnt: 2 });
});

it("uma coleta que nunca resolve é cortada no prazo, e o que já entregou fica", async () => {
  const path = collector(`
    export async function createCollector() {
      return {
        crawl: ({ onItems }) => { onItems([{ itemId: 1, rows: [${LISTING}] }]); return new Promise(() => {}); },
        close: async () => {},
      };
    }`);

  const started = Date.now();
  const outcome = await runCrawl({
    db, dataset: "trading", server: "FREYA", collectorPath: path,
    deadlineMs: 300, graceMs: 200, threadUrl: THREAD,
  });

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(outcome.aborted).toBe(true);
  expect(outcome.error).toMatch(/passou de 300ms/);
  expect(outcome.result?.fresh).toBe(false);
  expect(getCache("FREYA").listings.has(1)).toBe(true);
});

it("um coletor que quebra fecha a coleta com erro, sem derrubar o processo", async () => {
  const path = collector(`
    export async function createCollector() {
      return { crawl: async () => { throw new Error("o site mudou"); }, close: async () => {} };
    }`);

  const outcome = await runCrawl({
    db, dataset: "trading", server: "FREYA", collectorPath: path, deadlineMs: 10_000, threadUrl: THREAD,
  });
  expect(outcome.error).toMatch(/o site mudou/);
  expect(outcome.result?.fresh).toBe(false);
});

it("um caminho sem createCollector é erro, não exceção solta", async () => {
  const path = collector(`export const nada = 1;`);
  const outcome = await runCrawl({
    db, dataset: "trading", server: "FREYA", collectorPath: path, deadlineMs: 10_000, threadUrl: THREAD,
  });
  expect(outcome.error).toMatch(/não exporta createCollector/);
});
