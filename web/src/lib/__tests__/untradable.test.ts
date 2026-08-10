import { describe, expect, it } from "vitest";

// @ts-expect-error — módulo .mjs sem tipos, compartilhado com o script de build.
import { isUntradable } from "../../../scripts/catalogue-rules.mjs";

/**
 * Esta regra decide o filtro que vem LIGADO por padrão, então um erro dela esconde
 * itens que a pessoa tem. Os casos abaixo são todos reais, tirados do catálogo.
 */
describe("isUntradable", () => {
  it("pega o marcador em linha própria, com código de cor", () => {
    // 802 — Passe de Batalha Premium
    expect(isUntradable("^ff0000Intransferível.^000000\nPasse que permite participar")).toBe(true);
  });

  it("pega o marcador no começo da descrição", () => {
    expect(isUntradable("Intransferível.\nUm item qualquer.")).toBe(true);
  });

  it("pega depois de dois-pontos", () => {
    expect(isUntradable("Observação: Intransferível.")).toBe(true);
  });

  /**
   * Os falsos positivos que motivaram a regra. As "Bolsa de Moedas" (12612, 12615-12617)
   * falam do CONTEÚDO; a bolsa em si é negociável, e de fato aparece à venda no mercado.
   */
  it("ignora quando a frase fala do conteúdo, no plural e no meio da frase", () => {
    expect(isUntradable("As moedas são inegociáveis e intransferíveis para o armazém.")).toBe(false);
    expect(
      isUntradable("Algumas moedas são inegociáveis e intransferíveis para o armazém."),
    ).toBe(false);
  });

  it("ignora item comum", () => {
    expect(isUntradable("Poção feita de ervas vermelhas.\n^0000ffRecupera 45 de HP.^000000")).toBe(
      false,
    );
  });

  it("aceita descrição ausente", () => {
    expect(isUntradable(undefined)).toBe(false);
    expect(isUntradable("")).toBe(false);
  });
});
