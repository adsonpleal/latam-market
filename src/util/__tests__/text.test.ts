/**
 * `enumerate` nasceu de um bug de leitura, não de tipo: o aviso de preço saía como
 * "refino +11 e grau C e 2 cartas/encantes e 2 bônus aleatórios". Compilava, estava
 * certo, e ninguém escreveria assim — então o que este teste guarda é a pontuação.
 */

import { describe, expect, it } from "vitest";

import { enumerate, normalizeName, plural, stripSlotSuffix } from "../text.js";

describe("enumerate", () => {
  it("devolve string vazia para lista vazia", () => {
    expect(enumerate([])).toBe("");
  });

  it("devolve o item sozinho, sem pontuação", () => {
    expect(enumerate(["refino +11"])).toBe("refino +11");
  });

  it("liga dois itens com 'e', sem vírgula", () => {
    expect(enumerate(["refino +11", "grau C"])).toBe("refino +11 e grau C");
  });

  it("usa vírgula entre os itens e 'e' antes do último", () => {
    expect(enumerate(["refino +11", "grau C", "2 cartas/encantes"])).toBe(
      "refino +11, grau C e 2 cartas/encantes",
    );
  });

  it("aguenta os quatro avisos que o caveat pode juntar", () => {
    expect(
      enumerate(["refino +11", "grau C", "2 cartas/encantes", "2 bônus aleatórios"]),
    ).toBe("refino +11, grau C, 2 cartas/encantes e 2 bônus aleatórios");
  });
});

describe("plural", () => {
  it("concorda as duas formas por inteiro", () => {
    expect(plural(1, "carta identificada", "cartas identificadas")).toBe(
      "1 carta identificada",
    );
    expect(plural(3, "carta identificada", "cartas identificadas")).toBe(
      "3 cartas identificadas",
    );
  });

  it("formata o número em pt-BR", () => {
    expect(plural(1500, "loja", "lojas")).toBe("1.500 lojas");
  });
});

describe("normalizeName", () => {
  it("tira acento, baixa a caixa e colapsa espaço", () => {
    expect(normalizeName("  Poção   Vermelha ")).toBe("pocao vermelha");
  });
});

describe("stripSlotSuffix", () => {
  it("remove o sufixo de slots que o cliente concatena", () => {
    expect(stripSlotSuffix("Arco de Cinzas [1]")).toBe("Arco de Cinzas");
  });

  it("deixa em paz o nome sem sufixo", () => {
    expect(stripSlotSuffix("Morango")).toBe("Morango");
  });
});
