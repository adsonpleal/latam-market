/**
 * A consulta dos movers: mesmo resultado, outro custo.
 *
 * Em produção (D1, 2026-09-14) a versão com `JOIN` comum leu 2,42 bilhões de linhas em 24h —
 * 219 execuções de ~11 milhões cada. O plano varria `listing_daily l` inteira por fora e
 * percorria o histórico do item em `f` para cada linha dela. Estes testes prendem as duas
 * coisas que importam: o resultado não mudou, e o plano não volta a varrer `l`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MOVERS_SQL, USUAL_PRICES_SQL } from "../../core/movers.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const MIGRATIONS = resolve(import.meta.dirname, "../../../migrations");

/** A consulta como era antes da correção, para comparar resultados. */
const OLD_MOVERS_SQL = `WITH bounds AS (
     SELECT item_id, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS pts
       FROM listing_daily WHERE server = ? AND day >= ? GROUP BY item_id HAVING pts >= 2
   )
   SELECT b.item_id,
          f.median AS before, f.listings AS before_stores,
          l.median AS now,    l.listings AS now_stores
     FROM bounds b
     JOIN listing_daily f ON f.server = ? AND f.item_id = b.item_id AND f.day = b.first_day
     JOIN listing_daily l ON l.server = ? AND l.item_id = b.item_id AND l.day = b.last_day
    WHERE l.listings >= ? AND f.median >= ? AND l.median >= ?`;

const DAY = 86_400;

function seeded(): DatabaseSyncType {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));
  }

  // Determinístico: um gerador linear em vez de Math.random, para uma falha ser reproduzível.
  let seed = 7;
  const rand = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;

  const insert = db.prepare(
    `INSERT INTO listing_daily
       (server, item_id, day, listings, units, min_price, p25, median, p75, max_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const server of ["FREYA", "NIDHOGG"]) {
    for (let item = 1; item <= 120; item++) {
      // Itens com históricos de tamanhos diferentes, alguns com um ponto só na janela.
      const days = 1 + rand(40);
      for (let d = 0; d < days; d++) {
        const median = 500 + rand(20_000);
        insert.run(server, item, (100 + d) * DAY, 1 + rand(8), 1 + rand(20), median, median,
          median, median, median);
      }
    }
  }
  return db;
}

const byItem = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => Number(a["item_id"]) - Number(b["item_id"]));

describe("MOVERS_SQL", () => {
  it("devolve exatamente o que a consulta antiga devolvia", () => {
    const db = seeded();
    let total = 0;
    for (const [from, minStores, minPrice] of [
      [110 * DAY, 3, 1000],
      [100 * DAY, 1, 0],
      [130 * DAY, 5, 8000],
    ] as const) {
      const expected = db.prepare(OLD_MOVERS_SQL)
        .all("FREYA", from, "FREYA", "FREYA", minStores, minPrice, minPrice);
      const actual = db.prepare(MOVERS_SQL)
        .all("FREYA", from, "FREYA", "FREYA", minStores, minPrice, minPrice);
      expect(byItem(actual as never)).toEqual(byItem(expected as never));
      total += actual.length;
    }
    // Sem isto, duas consultas que não devolvem nada passariam por iguais.
    expect(total).toBeGreaterThan(0);
    db.close();
  });

  it("não varre listing_daily por fora: bounds primeiro, f e l por chave primária", () => {
    const db = seeded();
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${MOVERS_SQL}`)
        .all("FREYA", 0, "FREYA", "FREYA", 3, 1000, 1000) as { detail: string }[]
    ).map((r) => r.detail);

    expect(plan.join("\n")).not.toMatch(/SCAN (f|l)\b/);
    expect(plan).toContainEqual(expect.stringMatching(/^SCAN b/));
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH f USING PRIMARY KEY \(server=\? AND item_id=\? AND day=\?\)/),
    );
    expect(plan).toContainEqual(
      expect.stringMatching(/^SEARCH l USING PRIMARY KEY \(server=\? AND item_id=\? AND day=\?\)/),
    );
    db.close();
  });
});

describe("USUAL_PRICES_SQL", () => {
  it("usa o índice da janela em vez de varrer o histórico do servidor", () => {
    const db = seeded();
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${USUAL_PRICES_SQL}`).all("FREYA", 0) as {
      detail: string;
    }[]).map((r) => r.detail);
    expect(plan.join("\n")).toMatch(/listing_daily_window/);
    db.close();
  });
});
