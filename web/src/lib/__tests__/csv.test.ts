import { describe, expect, it } from "vitest";

import { toCsv } from "../csv.js";

describe("toCsv", () => {
  it("começa com BOM — sem ele o Excel pt-BR estropia os acentos", () => {
    expect(toCsv(["nome"], [["Poção Vermelha"]]).charCodeAt(0)).toBe(0xfeff);
  });

  it("aspas campos com vírgula, aspas ou quebra de linha", () => {
    const csv = toCsv(["a", "b", "c"], [['diz "oi"', "x,y", "linha\nquebrada"]]);
    expect(csv).toContain('"diz ""oi"""');
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"linha\nquebrada"');
  });

  it("null e undefined viram campo vazio", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toContain("\r\n,\r\n");
  });

  it("usa CRLF", () => {
    expect(toCsv(["a"], [[1]])).toBe("﻿a\r\n1\r\n");
  });
});
