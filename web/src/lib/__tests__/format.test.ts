import { describe, expect, it } from "vitest";

import { duration, plural, zeny } from "../format.js";

/**
 * A concordância existe porque a alternativa preguiçosa — "1 alerta(s) ligado(s)" — é o que
 * estava na tela antes, e ninguém lê isso como português.
 */
describe("plural", () => {
  it("concorda no singular e no plural", () => {
    expect(plural(1, "alerta ligado", "alertas ligados")).toBe("1 alerta ligado");
    expect(plural(2, "alerta ligado", "alertas ligados")).toBe("2 alertas ligados");
  });

  it("zero é plural em português", () => {
    expect(plural(0, "favorito", "favoritos")).toBe("0 favoritos");
  });

  /** É o caso que um `+"s"` no fim não cobre, e a razão de as duas formas virem inteiras. */
  it("leva a concordância para todas as palavras, não só a última", () => {
    expect(plural(3, "alerta disparou", "alertas dispararam")).toBe("3 alertas dispararam");
    expect(plural(1, "carta/encante", "cartas/encantes")).toBe("1 carta/encante");
    expect(plural(2, "carta/encante", "cartas/encantes")).toBe("2 cartas/encantes");
  });

  it("formata o número em pt-BR", () => {
    expect(plural(1500, "item", "itens")).toBe("1.500 itens");
  });
});

describe("duration", () => {
  it("escolhe a unidade que se lê", () => {
    expect(duration(45_000)).toBe("45 s");
    expect(duration(3 * 60_000)).toBe("3 min");
    expect(duration(60 * 60_000)).toBe("1 h");
    expect(duration(65 * 60_000)).toBe("1 h 5 min");
  });
});

describe("zeny", () => {
  /** A regra é "nada de inventar valor": 0 leria como "não vale nada". */
  it("null vira travessão, nunca zero", () => {
    expect(zeny(null)).toBe("—");
    expect(zeny(undefined)).toBe("—");
    expect(zeny(0)).toBe("0z");
  });
});
