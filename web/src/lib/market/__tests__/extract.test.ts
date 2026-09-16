/**
 * O parser da página de lojas.
 *
 * O fixture é uma resposta real do site (busca "Carta Zangão", 2026-09-15), com nomes de
 * loja e de personagem trocados e três armadilhas a mais: um objeto partido entre dois
 * pedaços do payload, um `"list":"Lista"` do pacote de traduções antes do resultado, e
 * nomes de loja com chave e aspas dentro.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SoftFailError, extractRows, toFlightText } from "../extract.js";
import { summarize } from "../summarize.js";

const page = readFileSync(resolve(import.meta.dirname, "fixtures/trading-carta-zangao.html"), "utf8");

describe("extractRows", () => {
  it("acha a lista mesmo com o objeto partido entre pedaços", () => {
    const { rows, totalCount } = extractRows(page);
    expect(totalCount).toBe(3);
    expect(rows.map((r) => r.itemPrice)).toEqual([1111, 40000, 50000]);
    expect(rows[2]!.ssi).toBe("7685868062368699387");
  });

  it("não se engana com o `list` das traduções nem com chaves e aspas dentro de nomes", () => {
    const { rows } = extractRows(page);
    expect(rows.map((r) => r.storeName)).toEqual(["Loja {A}", 'Loja "B"', "Loja C ]}"]);
  });

  it("aceita o payload cru, sem os `push`", () => {
    const raw = toFlightText(page);
    expect(extractRows(raw).rows).toHaveLength(3);
  });

  it("página sem a lista é falha, nunca zero anúncios", () => {
    expect(() => extractRows("<html><body>Just a moment...</body></html>")).toThrow(SoftFailError);
    expect(() => extractRows('19:{"queryParams":{"p":"1"},"list":"Lista"}')).toThrow(SoftFailError);
  });

  it("uma resposta vazia de verdade vem com a lista vazia e total zero", () => {
    const empty = '19:["$","$L2b",null,{"queryParams":{"p":"1"},"list":[],"totalCount":0}]';
    expect(extractRows(empty)).toEqual({ rows: [], totalCount: 0 });
  });
});

describe("summarize", () => {
  const { rows, totalCount } = extractRows(page);

  it("resume só as linhas do item pedido", () => {
    expect(summarize(rows, totalCount, 4019)).toEqual({
      min: 1111,
      // "Vendedor Um" tem duas vagas: é uma loja só.
      stores: 2,
      units: 4,
      seller: "Vendedor Um",
      truncated: false,
    });
  });

  it("item que a busca não trouxe fica sem preço", () => {
    expect(summarize(rows, totalCount, 4020)).toMatchObject({ min: null, stores: 0, units: 0 });
  });

  it("marca quando o site tinha mais anúncios que a página", () => {
    expect(summarize(rows, 1543, 4019).truncated).toBe(true);
  });
});
