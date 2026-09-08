/**
 * O rollup em JS tem que dar exatamente o que a janela SQL dava.
 *
 * É o ponto de divergência silenciosa da migração para o D1: `listing_stats` alimenta o
 * histórico, o `appraise` e os `movers`, e um percentil deslocado em um índice não quebra
 * nada — só passa a responder outro número, para sempre. Por isso o teste compara contra o
 * SQL ORIGINAL rodando sobre os anúncios de verdade, e não contra valores escritos à mão.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { groupByItem, rollupStats, statsFor } from "../rollup.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/** A consulta que estava em `rollupListings`, como SELECT: as mesmas expressões, sem gravar. */
const LEGACY_SQL = `
  WITH ranked AS (
    SELECT item_id, price, cnt,
           ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY price) - 1 AS rn,
           COUNT(*)     OVER (PARTITION BY item_id)                    AS n
    FROM listing WHERE snapshot_id = ?
  )
  SELECT item_id, MAX(n) AS listings, SUM(cnt) AS units, MIN(price) AS min_price,
         MAX(CASE WHEN rn = (n - 1) / 4     THEN price END) AS p25,
         MAX(CASE WHEN rn = (n - 1) / 2     THEN price END) AS median,
         MAX(CASE WHEN rn = (n - 1) * 3 / 4 THEN price END) AS p75,
         MAX(price) AS max_price
  FROM ranked GROUP BY item_id ORDER BY item_id`;

const DB_PATH = "data/market.db";

describe("rollup em JS contra a janela SQL", () => {
  // O banco é gitignored: no CI não existe, e o teste sintético abaixo é quem segura a
  // definição. Localmente, com os 20 mil anúncios reais, este é o que vale.
  const hasDb = existsSync(DB_PATH);

  it.skipIf(!hasDb)("bate linha a linha sobre os anúncios reais", () => {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const snap = db
        .prepare(`SELECT snapshot_id AS id, COUNT(*) AS n FROM listing GROUP BY snapshot_id
                  ORDER BY n DESC LIMIT 1`)
        .get() as { id: number; n: number };
      expect(snap.n).toBeGreaterThan(1000);

      const legacy = db.prepare(LEGACY_SQL).all(snap.id) as Array<Record<string, number>>;

      const listings = db
        .prepare(`SELECT item_id AS itemId, price, cnt FROM listing WHERE snapshot_id = ?`)
        .all(snap.id) as Array<{ itemId: number; price: number; cnt: number }>;
      const mine = rollupStats(groupByItem(listings));

      expect(mine.length).toBe(legacy.length);
      expect(mine.map((r) => r.itemId)).toEqual(legacy.map((r) => r["item_id"]));

      // Comparação chapada: um `toEqual` no array inteiro aponta o item divergente de
      // primeira, em vez de falhar no primeiro `expect` de um laço.
      expect(
        mine.map((r) => [r.itemId, r.listings, r.units, r.minPrice, r.p25, r.median, r.p75, r.maxPrice]),
      ).toEqual(
        legacy.map((r) => [
          r["item_id"], r["listings"], r["units"], r["min_price"],
          r["p25"], r["median"], r["p75"], r["max_price"],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("conta cada anúncio uma vez, não cada unidade", () => {
    // Se a quantidade pesasse, a mediana de [1, 1000×2] seria 2, não 1.
    const stats = statsFor(7, [
      { price: 1, cnt: 1 },
      { price: 2, cnt: 1000 },
    ]);
    expect(stats).toMatchObject({ listings: 2, units: 1001, median: 1 });
  });

  it("um anúncio só é mínimo, máximo e todos os percentis", () => {
    expect(statsFor(1, [{ price: 42, cnt: 3 }])).toEqual({
      itemId: 1, listings: 1, units: 3,
      minPrice: 42, p25: 42, median: 42, p75: 42, maxPrice: 42,
    });
  });

  it("indexa pelo mesmo lugar que a divisão inteira do SQL", () => {
    // n = 5 -> p25 em (5-1)/4 = 1, mediana em (5-1)/2 = 2, p75 em (5-1)*3/4 = 3.
    const sorted = [10, 20, 30, 40, 50].map((price) => ({ price, cnt: 1 }));
    expect(statsFor(1, sorted)).toMatchObject({ p25: 20, median: 30, p75: 40 });
  });

  it("lista vazia não vira linha", () => {
    expect(statsFor(1, [])).toBeNull();
  });
});
