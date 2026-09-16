import { describe, expect, it } from "vitest";

import type { ReplayInventory } from "../replay/inventory.js";
import { ALL_ORIGINS, applyFilters, flatten, type Filters, type Row } from "../rows.js";

/**
 * A mesma lista alimenta a tabela, o CSV e as contagens do cabeçalho (ver `applyFilters`).
 * O que estes casos travam é que os três filtros se somam e que nenhuma linha some ou
 * duplica ao achatar os containers.
 */

const item = (itemId: number, name: string, slot = 0) => ({
  item: { itemId, name, slots: null },
  slot,
  qty: 1,
  refine: 0,
  grade: 0,
  cards: [],
  cardNames: [],
  equipped: 0,
});

const row = (over: Partial<Row> & { key: string }): Row => ({
  ...item(501, "Poção Vermelha"),
  origin: "inventory",
  ...over,
});

const filters = (over: Partial<Filters> = {}): Filters => ({
  origins: new Set(ALL_ORIGINS),
  hideUntradable: false,
  search: "",
  ...over,
});

const never = () => false;
const keys = (rows: Row[]): string[] => rows.map((r) => r.key);

describe("flatten", () => {
  const inventory: ReplayInventory = {
    recordedAt: 0,
    character: { name: "x", map: "prontera", baseLevel: 1, jobLevel: 1 },
    inventory: { items: [item(501, "Poção Vermelha", 0), item(501, "Poção Vermelha", 1)] },
    cart: { items: [item(502, "Poção Laranja")] },
    equipped: { items: [] },
    storage: null,
    guildStorage: { items: [item(503, "Poção Amarela")], usedSlots: 1, maxSlots: 100, openedAtMs: 0 },
    unidentified: { 4517: [item(504, "Poção Branca")] },
    notes: [],
  };

  it("marca a origem e dá chave distinta ao mesmo item em dois slots", () => {
    const rows = flatten(inventory);
    expect(rows.map((r) => r.origin)).toEqual(["inventory", "inventory", "cart", "guildStorage", "unidentified"]);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });
});

describe("applyFilters", () => {
  it("sem filtro, não tira nada", () => {
    const rows = [row({ key: "a" }), row({ key: "b", origin: "cart" })];
    expect(keys(applyFilters(rows, filters(), never))).toEqual(["a", "b"]);
  });

  it("origem desmarcada sai", () => {
    const rows = [row({ key: "a" }), row({ key: "b", origin: "cart" })];
    const origins = new Set(ALL_ORIGINS.filter((o) => o !== "cart"));
    expect(keys(applyFilters(rows, filters({ origins }), never))).toEqual(["a"]);
  });

  it("nome casa sem diferenciar caixa", () => {
    const rows = [row({ key: "a" }), row({ key: "b", item: { itemId: 1, name: "Jellopy", slots: null } })];
    expect(keys(applyFilters(rows, filters({ search: "jello" }), never))).toEqual(["b"]);
  });

  it("os filtros se somam", () => {
    const rows = [row({ key: "fica" }), row({ key: "preso" }), row({ key: "carrinho", origin: "cart" })];
    const origins = new Set(ALL_ORIGINS.filter((o) => o !== "cart"));
    const result = applyFilters(rows, filters({ origins, hideUntradable: true }), (r) => r.key === "preso");
    expect(keys(result)).toEqual(["fica"]);
  });
});
