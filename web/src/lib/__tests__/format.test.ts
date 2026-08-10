import { describe, expect, it } from "vitest";

import { plural, upcoming, zeny } from "../format.js";

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

describe("upcoming", () => {
  const emSegundos = (min: number) => Date.now() / 1000 + min * 60;

  it("conta para a frente", () => {
    expect(upcoming(emSegundos(12))).toBe("em 12 min");
    expect(upcoming(emSegundos(120))).toBe("em 2 h");
  });

  /** Coleta atrasada não pode virar "em -3 min", que não diz nada a ninguém. */
  it("o que já passou vira 'a qualquer momento'", () => {
    expect(upcoming(emSegundos(-3))).toBe("a qualquer momento");
    expect(upcoming(emSegundos(0.5))).toBe("a qualquer momento");
  });

  it("sem previsão, diz isso", () => {
    expect(upcoming(null)).toBe("sem previsão");
  });
});

describe("zeny", () => {
  /** A regra do backend é "nada de inventar valor": 0 leria como "não vale nada". */
  it("null vira travessão, nunca zero", () => {
    expect(zeny(null)).toBe("—");
    expect(zeny(undefined)).toBe("—");
    expect(zeny(0)).toBe("0z");
  });
});
