/**
 * A sessão de ingestão: cada entrega de item vira banco e cache, na hora.
 *
 * O que se protege: uma entrega nova do mesmo item substitui a anterior (não soma), uma
 * entrega vazia tira o item de venda, um item não decidido fica com o que tinha, o relógio só
 * anda com cobertura, e o que foi gravado reconstrói o MESMO cache no boot.
 */

import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { CrawlReport } from "../../collect/port.js";
import { getCache, resetCaches, setCache } from "../../store/cache.js";
import { openDb } from "../../store/db.js";
import { loadMarketFromDb } from "../../store/load.js";
import type { WritableDb } from "../../store/port.js";
import type { MarketPriceRow, TradingRow } from "../../store/rows.js";
import { sqliteDb } from "../../store/sqlite.js";
import { openCrawlSession } from "../session.js";

const MIGRATIONS = resolve(import.meta.dirname, "..", "..", "..", "migrations");
const T0 = 1_800_000_000;

let db: WritableDb;

const emptyCatalogue = { items: new Map(), byNameNorm: new Map() };

beforeEach(() => {
  db = sqliteDb(openDb({ path: ":memory:", migrationsDir: MIGRATIONS }));
  resetCaches();
  setCache("FREYA", {
    tradingSnapshotId: null, tradingAt: null, marketSnapshotId: null, marketAt: null,
    ...emptyCatalogue, inMarket: new Set(), prices: new Map(), listings: new Map(),
  });
});

const listing = (itemId: number, ssi: string, price: number, cnt = 1, seller = `V${ssi}`): TradingRow => ({
  itemId, itemName: `Item ${itemId}`, databaseImgPath: null, databaseType: null, mapId: 1, ssi,
  storeName: `Loja ${seller}`, itemPrice: price, itemCnt: cnt, slotMaxCount: "",
  storeTypeName: "BUY", itemSellerCharName: seller,
});

const report = (complete: number, failed: number): CrawlReport => ({
  planned: complete + failed, failures: failed, termsComplete: complete, termsFailed: failed,
  itemsPublished: 0, itemsRemoved: 0, itemsIncomplete: 0,
});

const session = (startedAt = T0, crawlId = `c${startedAt}`) =>
  openCrawlSession({
    db, dataset: "trading", server: "FREYA", startedAt, crawlId,
    now: () => startedAt, yieldTo: async () => {},
  });

describe("openCrawlSession (trading)", () => {
  it("publica o item assim que é entregue, antes do fim da coleta", async () => {
    const s = await session();
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 50), listing(1, "b", 40)] }]);

    // Sem finalize: o item já está no cache, ordenado por preço.
    expect(getCache("FREYA").listings.get(1)!.map((l) => l.price)).toEqual([40, 50]);
    const stats = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM listing_stats WHERE item_id = 1`);
    expect(stats!.n).toBe(1);
  });

  it("uma segunda entrega do mesmo item SUBSTITUI a primeira", async () => {
    const s = await session();
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 50, 5)] }]);
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 50, 4), listing(1, "b", 60)] }]);

    const offers = getCache("FREYA").listings.get(1)!;
    expect(offers.map((l) => [l.price, l.cnt])).toEqual([[50, 4], [60, 1]]);
    const row = await db.first<{ listings: number; units: number }>(
      `SELECT listings, units FROM listing_stats WHERE item_id = 1`,
    );
    expect(row).toEqual({ listings: 2, units: 5 });
  });

  it("entrega vazia tira o item de venda e apaga a estatística da coleta", async () => {
    const s = await session();
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 50)] }]);
    await s.applyItems([{ itemId: 1, rows: [] }]);

    expect(getCache("FREYA").listings.has(1)).toBe(false);
    expect((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM offer`))!.n).toBe(0);
    expect((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM listing_stats`))!.n).toBe(0);
    expect((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM listing_daily`))!.n).toBe(0);
  });

  it("item não decidido nesta coleta fica com as ofertas que tinha", async () => {
    const first = await session(T0);
    await first.applyItems([{ itemId: 1, rows: [listing(1, "a", 50)] }, { itemId: 2, rows: [listing(2, "x", 9)] }]);
    await first.finalize(report(10, 0), false);

    const second = await session(T0 + 600);
    await second.applyItems([{ itemId: 1, rows: [listing(1, "a", 55)] }]);
    await second.finalize(report(9, 1), false);

    expect(getCache("FREYA").listings.get(2)!.map((l) => l.price)).toEqual([9]);
    expect(getCache("FREYA").listings.get(1)!.map((l) => l.price)).toEqual([55]);
  });

  it("o relógio só anda com cobertura suficiente", async () => {
    const good = await session(T0);
    await good.applyItems([{ itemId: 1, rows: [listing(1, "a", 50)] }]);
    expect((await good.finalize(report(9, 1), false)).fresh).toBe(true);
    expect(getCache("FREYA").tradingAt).toBe(T0);

    const bad = await session(T0 + 600);
    await bad.applyItems([{ itemId: 1, rows: [listing(1, "a", 51)] }]);
    const result = await bad.finalize(report(5, 5), false);
    expect(result.fresh).toBe(false);
    // O item foi publicado mesmo assim; só o relógio não andou.
    expect(getCache("FREYA").listings.get(1)![0]!.price).toBe(51);
    expect(getCache("FREYA").tradingAt).toBe(T0);
  });

  it("oferta que ninguém confirma há tempo demais expira", async () => {
    const old = await session(T0);
    await old.applyItems([{ itemId: 7, rows: [listing(7, "a", 50)] }]);
    await old.finalize(report(1, 0), false);

    const later = await openCrawlSession({
      db, dataset: "trading", server: "FREYA", startedAt: T0 + 3 * 3600, crawlId: "tarde",
      now: () => T0 + 3 * 3600, yieldTo: async () => {}, offerMaxAgeMin: 120,
    });
    const result = await later.finalize(report(1, 0), false);
    expect(result.expired).toBe(1);
    expect(getCache("FREYA").listings.has(7)).toBe(false);
  });

  it("agrupa vagas da mesma loja e conta repetições", async () => {
    const s = await session();
    const vaga = (ssi: string) => listing(1, ssi, 900, 10, "Vendedor0");
    await s.applyItems([{ itemId: 1, rows: [vaga("v1"), vaga("v2"), vaga("v3"), vaga("v1")] }]);
    const result = await s.finalize(report(1, 0), false);
    expect(getCache("FREYA").listings.get(1)).toEqual([expect.objectContaining({ price: 900, cnt: 30 })]);
    expect(result).toMatchObject({ repetidas: 1, agrupadas: 2 });
  });

  it("o boot reconstrói do banco o mesmo mercado que a ingestão publicou", async () => {
    const s = await session();
    await s.applyItems([
      { itemId: 1, rows: [listing(1, "a", 50), listing(1, "b", 40)] },
      { itemId: 2, rows: [listing(2, "c", 7, 3)] },
    ]);
    await s.finalize(report(10, 0), false);
    const live = getCache("FREYA");

    resetCaches();
    await loadMarketFromDb(db, emptyCatalogue, "FREYA");
    const booted = getCache("FREYA");

    expect([...booted.listings]).toEqual([...live.listings]);
    expect(booted.tradingAt).toBe(live.tradingAt);
    expect([...booted.inMarket].sort()).toEqual([...live.inMarket].sort());
  });

  it("cada publicação muda a revisão", async () => {
    const s = await session();
    const r0 = getCache("FREYA").revision;
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 50)] }]);
    const r1 = getCache("FREYA").revision;
    await s.applyItems([{ itemId: 1, rows: [listing(1, "a", 52)] }]);
    expect(new Set([r0, r1, getCache("FREYA").revision]).size).toBe(3);
  });
});

describe("openCrawlSession (market-price)", () => {
  it("grava o ponto e publica o agregado, sem mexer nas ofertas", async () => {
    const trading = await session();
    await trading.applyItems([{ itemId: 1, rows: [listing(1, "a", 50)] }]);
    await trading.finalize(report(1, 0), false);

    const market = await openCrawlSession({
      db, dataset: "market-price", server: "FREYA", startedAt: T0 + 100, crawlId: "m",
      now: () => T0 + 100, yieldTo: async () => {},
    });
    const agg: MarketPriceRow = {
      itemId: 1, itemName: "Item 1", databaseImgPath: null, databaseType: null,
      totalItemCnt: 10, minItemPrice: 1, maxItemPrice: 9, avgItemPrice: 5,
    };
    await market.applyItems([{ itemId: 1, rows: [agg] }]);
    await market.finalize(report(7, 0), false);

    expect(getCache("FREYA").prices.get(1)).toMatchObject({ avgPrice: 5, ts: T0 + 100 });
    expect(getCache("FREYA").listings.get(1)![0]!.price).toBe(50);
    expect(getCache("FREYA").marketAt).toBe(T0 + 100);
  });
});
