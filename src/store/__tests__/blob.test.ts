/**
 * O retrato no R2 tem que reconstruir o MESMO mercado que o SQLite reconstruía.
 *
 * É a troca central da migração: o caminho quente deixa de montar o `MarketCache` a partir
 * de consultas e passa a montá-lo a partir de um blob. Se os dois divergirem, nada quebra
 * de forma visível — a busca simplesmente passa a ordenar por outro número, ou um item
 * some do filtro "à venda agora". Por isso o teste monta os dois lados dos MESMOS dados e
 * compara campo a campo, em vez de conferir o blob contra valores escritos à mão.
 */

import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

import type { TradingRow, MarketPriceRow } from "../rows.js";
import { beginSnapshot, finishSnapshot, rollupListings, writeRows } from "../write.js";
import { allItems, latestPricePoints, listingsOfSnapshot, latestSnapshotId } from "../read.js";
import { indexCatalogue, refreshCache, type MarketCache } from "../cache.js";
import { cacheFromBlob } from "../hydrate.js";
import { decodeBlob, encodeBlob, toBlob } from "../blob.js";
import { SCHEMA_SQL } from "../schema.js";
import { sqliteDb } from "../sqlite.js";
import type { WritableDb } from "../port.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const anuncio = (itemId: number, name: string, price: number, i: number): TradingRow => ({
  itemId, itemName: name, databaseImgPath: null, databaseType: "usable",
  mapId: 1, ssi: `${itemId}-${i}`, storeName: `loja ${i}`, itemPrice: price,
  itemCnt: i + 1, slotMaxCount: "", storeTypeName: "V", itemSellerCharName: `vendedor ${i}`,
});

const agregado = (itemId: number, name: string, min: number): MarketPriceRow => ({
  itemId, itemName: name, databaseImgPath: null, databaseType: "usable",
  totalItemCnt: 10, minItemPrice: min, maxItemPrice: min * 3, avgItemPrice: min * 2,
});

let db: InstanceType<typeof DatabaseSync>;
let port: WritableDb;
let fromSql: MarketCache;
let blobJson: Awaited<ReturnType<typeof toBlob>>;

beforeAll(async () => {
  db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  port = sqliteDb(db);

  const market = beginSnapshot(db, "market-price", "FREYA");
  writeRows(db, market, [agregado(501, "Poção Vermelha", 40), agregado(909, "Jellopy", 5)]);
  finishSnapshot(db, market.id, "market-price");

  const trading = beginSnapshot(db, "trading", "FREYA");
  writeRows(db, trading, [
    // Fora de ordem de propósito: a ordenação por preço é contrato do blob.
    ...[90, 50, 70, 55].map((price, i) => anuncio(501, "Poção Vermelha", price, i)),
    ...[7, 3].map((price, i) => anuncio(909, "Jellopy", price, i + 10)),
  ]);
  rollupListings(db, trading);
  finishSnapshot(db, trading.id, "trading");

  fromSql = await refreshCache(port, "FREYA");

  const tradingId = (await latestSnapshotId(port, "trading", "FREYA"))!;
  const marketId = await latestSnapshotId(port, "market-price", "FREYA");
  blobJson = toBlob({
    server: "FREYA",
    snapshotId: tradingId,
    startedAt: fromSql.tradingAt!,
    marketSnapshotId: marketId,
    marketAt: fromSql.marketAt,
    inMarket: fromSql.inMarket,
    prices: marketId === null ? [] : await latestPricePoints(port, marketId),
    listings: await listingsOfSnapshot(port, tradingId),
  });
});

const rebuilt = async (): Promise<MarketCache> =>
  cacheFromBlob(indexCatalogue(await allItems(port)), blobJson);

describe("cache do blob contra cache do SQLite", () => {
  it("os anúncios saem iguais, item a item e na mesma ordem", async () => {
    const blob = await rebuilt();
    expect([...blob.listings.keys()].sort()).toEqual([...fromSql.listings.keys()].sort());
    for (const [itemId, listings] of fromSql.listings) {
      expect(blob.listings.get(itemId)).toEqual(listings);
    }
  });

  it("o balde de cada item vem ordenado por preço", async () => {
    const blob = await rebuilt();
    // É o contrato de que `core/prices.ts` depende para ler a posição zero como "o mais
    // barato" sem conferir nada.
    expect(blob.listings.get(501)!.map((l) => l.price)).toEqual([50, 55, 70, 90]);
    expect(blob.listings.get(909)!.map((l) => l.price)).toEqual([3, 7]);
  });

  it("os agregados de mercado saem iguais", async () => {
    const blob = await rebuilt();
    expect(blob.prices).toEqual(fromSql.prices);
  });

  it("o frescor e os ids de snapshot batem", async () => {
    const blob = await rebuilt();
    expect(blob.tradingSnapshotId).toBe(fromSql.tradingSnapshotId);
    expect(blob.marketSnapshotId).toBe(fromSql.marketSnapshotId);
    expect(blob.tradingAt).toBe(fromSql.tradingAt);
    expect(blob.marketAt).toBe(fromSql.marketAt);
  });

  it("o conjunto de 'já visto no mercado' bate", async () => {
    const blob = await rebuilt();
    expect([...blob.inMarket].sort()).toEqual([...fromSql.inMarket].sort());
  });

  it("o catálogo indexado é o mesmo objeto entre servidores", async () => {
    const catalogue = indexCatalogue(await allItems(port));
    const a = cacheFromBlob(catalogue, blobJson);
    const b = cacheFromBlob(catalogue, blobJson);
    // Identidade, não igualdade: é o que faz o catálogo ocupar memória uma vez só.
    expect(a.items).toBe(b.items);
    expect(a.byNameNorm).toBe(b.byNameNorm);
  });
});

describe("serialização", () => {
  it("sobrevive à ida e volta comprimida", async () => {
    const bytes = await encodeBlob(blobJson);
    expect(await decodeBlob(bytes)).toEqual(blobJson);
  });

  it("comprime de verdade", async () => {
    const raw = new TextEncoder().encode(JSON.stringify(blobJson)).length;
    expect((await encodeBlob(blobJson)).length).toBeLessThan(raw);
  });

  it("recusa um blob de outra versão em vez de servir campo faltando", async () => {
    const bytes = await encodeBlob({ ...blobJson, v: 99 });
    await expect(decodeBlob(bytes)).rejects.toThrow(/versão 99/);
  });
});
