import { describe, expect, it } from "vitest";

import {
  ALL_ORIGINS,
  applyFilters,
  countHiddenUnpriced,
  type Filters,
  type Row,
} from "../rows.js";

/**
 * Os limites decidem o que a pessoa VÊ do próprio inventário, e a mesma lista alimenta a
 * tabela, o CSV e os totais do cabeçalho (ver `applyFilters`). O que estes casos travam é
 * a diferença entre "sem limite" e "limite zero": um item sem cotação não responde
 * "vale pelo menos X", e tratá-lo como zero — ou deixá-lo passar — quebra os dois lados.
 */

const row = (over: Partial<Row> & { key: string }): Row => ({
  item: {
    itemId: 501,
    name: "Poção Vermelha",
    slots: null,
    type: "consumivel",
    inMarket: true,
    links: { divinePride: "", market: null, marketHistory: null },
  },
  origin: "inventory",
  slot: 0,
  qty: 1,
  refine: 0,
  grade: 0,
  cards: [],
  cardNames: [],
  equipped: 0,
  unitPrice: 100,
  unitMedian: 120,
  total: 100,
  stores: 3,
  units: 10,
  market: { min: 90, max: 200, avg: 110, totalSold: 500, at: 0 },
  priceCaveat: null,
  ...over,
});

const filters = (over: Partial<Filters> = {}): Filters => ({
  origins: new Set(ALL_ORIGINS),
  hideUntradable: false,
  hideUnpriced: false,
  minTotal: null,
  maxStores: null,
  minSold: null,
  search: "",
  ...over,
});

/** Só o `totalSold` interessa nestes casos; o resto do agregado é ruído. */
const sold = (totalSold: number | null): Row["market"] => ({
  min: null,
  max: null,
  avg: null,
  totalSold,
  at: 0,
});

const never = () => false;
const keys = (rows: Row[]): string[] => rows.map((r) => r.key);

describe("applyFilters", () => {
  it("sem limites, não tira nada", () => {
    const rows = [row({ key: "a" }), row({ key: "b", total: null })];
    expect(keys(applyFilters(rows, filters(), never))).toEqual(["a", "b"]);
  });

  it("hideUnpriced tira só quem não tem total", () => {
    const rows = [row({ key: "a" }), row({ key: "b", total: null })];
    expect(keys(applyFilters(rows, filters({ hideUnpriced: true }), never))).toEqual(["a"]);
  });

  describe("minTotal", () => {
    it("mantém quem empata com o piso", () => {
      const rows = [row({ key: "a", total: 10_000 }), row({ key: "b", total: 9_999 })];
      expect(keys(applyFilters(rows, filters({ minTotal: 10_000 }), never))).toEqual(["a"]);
    });

    it("esconde os sem preço mesmo com hideUnpriced desligado", () => {
      const rows = [row({ key: "a", total: 10_000 }), row({ key: "b", total: null })];
      expect(keys(applyFilters(rows, filters({ minTotal: 1 }), never))).toEqual(["a"]);
    });

    it("piso zero é diferente de sem piso: o sem preço sai", () => {
      const rows = [row({ key: "a", total: 0 }), row({ key: "b", total: null })];
      expect(keys(applyFilters(rows, filters({ minTotal: 0 }), never))).toEqual(["a"]);
    });
  });

  describe("maxStores", () => {
    it("mantém quem empata com o teto", () => {
      const rows = [row({ key: "a", stores: 15 }), row({ key: "b", stores: 16 })];
      expect(keys(applyFilters(rows, filters({ maxStores: 15 }), never))).toEqual(["a"]);
    });

    it("teto zero deixa passar quem ninguém vende", () => {
      const rows = [row({ key: "a", stores: 0 }), row({ key: "b", stores: 1 })];
      expect(keys(applyFilters(rows, filters({ maxStores: 0 }), never))).toEqual(["a"]);
    });
  });

  describe("minSold", () => {
    it("mantém quem empata com o piso", () => {
      const rows = [row({ key: "a", market: sold(50) }), row({ key: "b", market: sold(49) })];
      expect(keys(applyFilters(rows, filters({ minSold: 50 }), never))).toEqual(["a"]);
    });

    /** Item que nunca apareceu no dataset do site: `market` é null, `totalSold` também. */
    it("esconde quem não tem histórico", () => {
      const rows = [row({ key: "a" }), row({ key: "b", market: null }), row({ key: "c", market: sold(null) })];
      expect(keys(applyFilters(rows, filters({ minSold: 1 }), never))).toEqual(["a"]);
    });
  });

  it("os limites se somam, e com os filtros que já existiam", () => {
    const rows = [
      // O caso que a combinação procura: vale a pena, quase ninguém vendendo, e sai.
      row({ key: "liquido", total: 50_000, stores: 2 }),
      row({ key: "barato", total: 500, stores: 2 }),
      row({ key: "disputado", total: 50_000, stores: 40 }),
      row({ key: "parado", total: 50_000, stores: 2, market: sold(3) }),
      row({ key: "preso", total: 50_000, stores: 2 }),
    ];
    const result = applyFilters(
      rows,
      filters({ minTotal: 10_000, maxStores: 15, minSold: 100, hideUntradable: true }),
      (r) => r.key === "preso",
    );
    expect(keys(result)).toEqual(["liquido"]);
  });
});

/**
 * O rótulo do botão "esconder sem preço". O que estes casos travam é que a conta ignora os
 * filtros que escondem sem preço e obedece a todos os outros — sem isso o número contradiz
 * o cabeçalho, ou zera na hora em que a pessoa marca a caixa.
 */
describe("countHiddenUnpriced", () => {
  const rows = [
    row({ key: "com-preco", total: 100 }),
    row({ key: "sem-preco", total: null }),
    row({ key: "sem-preco-no-carrinho", total: null, origin: "cart" }),
  ];

  it("conta os sem preço da seleção", () => {
    expect(countHiddenUnpriced(rows, filters(), never)).toBe(2);
  });

  it("não zera quando a caixa é marcada", () => {
    expect(countHiddenUnpriced(rows, filters({ hideUnpriced: true }), never)).toBe(2);
  });

  it("nem quando um piso também esconde os sem preço", () => {
    expect(countHiddenUnpriced(rows, filters({ minTotal: 1_000_000 }), never)).toBe(2);
  });

  it("mas obedece aos filtros que não têm nada a ver com preço", () => {
    const origins = new Set(ALL_ORIGINS.filter((o) => o !== "cart"));
    expect(countHiddenUnpriced(rows, filters({ origins }), never)).toBe(1);
    const untradable = (r: Row) => r.origin === "cart";
    expect(countHiddenUnpriced(rows, filters({ hideUntradable: true }), untradable)).toBe(1);
  });
});
