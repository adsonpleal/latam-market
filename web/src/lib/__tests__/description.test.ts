import { describe, expect, it } from "vitest";

import { parseDescription, plainDescription } from "../description.js";

describe("parseDescription", () => {
  it("separa o texto por cor", () => {
    expect(parseDescription("normal^0000ffazul^000000normal de novo")).toEqual([
      { text: "normal" },
      { text: "azul", color: "#0000ff" },
      { text: "normal de novo" },
    ]);
  });

  it("trata ^000000 como volta ao padrão, e não como preto", () => {
    const runs = parseDescription("^ff0000vermelho^000000depois");
    expect(runs[1]).toEqual({ text: "depois" });
    expect(runs[1]).not.toHaveProperty("color");
  });

  /**
   * O irmão usa `/\^(.{6})/g`, que casaria "ircunf" aqui e comeria o resto da frase.
   * A regex apertada exige seis dígitos hexadecimais.
   */
  it("não confunde um circunflexo comum com código de cor", () => {
    expect(parseDescription("um ^circunflexo solto")).toEqual([{ text: "um ^circunflexo solto" }]);
  });

  it("aceita descrição vazia ou ausente", () => {
    expect(parseDescription(undefined)).toEqual([]);
    expect(parseDescription("")).toEqual([]);
  });

  it("plainDescription remove os códigos", () => {
    expect(plainDescription("^0000ffRecupera 45 de HP.^000000")).toBe("Recupera 45 de HP.");
  });

  it("plainDescription deixa o rótulo do destino e leva a marcação", () => {
    expect(plainDescription("Leve à <NAVI>[Loja]<INFO>mal_in01,20,107,0,100,0,0</INFO></NAVI>."))
      .toBe("Leve à [Loja].");
  });
});

describe("destinos de navegação", () => {
  it("vira um trecho clicável com o comando do cliente", () => {
    expect(
      parseDescription("Leve à <NAVI>[Loja Fashion]<INFO>mal_in01,20,107,0,100,0,0</INFO></NAVI> hoje"),
    ).toEqual([
      { text: "Leve à " },
      { text: "[Loja Fashion]", navi: "/navi mal_in01 20/107" },
      { text: " hoje" },
    ]);
  });

  /** `^4D4DFF[Casamenteira]^000000` — a cor do rótulo é do próprio cliente. */
  it("mantém a cor do rótulo e fecha o que ela abriu", () => {
    expect(
      parseDescription("vá à <NAVI>^4D4DFF[Igreja]^000000<INFO>prt_church,97,100,0,100,0,0</INFO></NAVI>depois"),
    ).toEqual([
      { text: "vá à " },
      { text: "[Igreja]", color: "#4d4dff", navi: "/navi prt_church 97/100" },
      { text: "depois" },
    ]);
  });

  it("tira do link o espaço que veio colado na tag", () => {
    const runs = parseDescription("<NAVI>[Acampamento] <INFO>prt_fild01,102,175,0,100,0,0</INFO></NAVI>fica ali");
    expect(runs).toEqual([
      { text: "[Acampamento]", navi: "/navi prt_fild01 102/175" },
      { text: " " },
      { text: "fica ali" },
    ]);
  });

  /**
   * O catálogo entrega o `<INFO>` sujo de três jeitos distintos, todos vistos em campo.
   * O comando tem de sair limpo dos três — é ele que a pessoa cola no jogo.
   */
  it.each([
    ["<INFO> spl_in01,110,322,0,101,0</INFO>", "/navi spl_in01 110/322"],
    ["<INFO>alberta.gat,140,170,0,101,0</INFO>", "/navi alberta 140/170"],
    ["<INFO><INFO>itemmall,16,75,0,100,0,0</INFO>", "/navi itemmall 16/75"],
  ])("extrai o destino de %s", (info, command) => {
    const runs = parseDescription(`<NAVI>[Loja]${info}</NAVI>`);
    expect(runs).toEqual([{ text: "[Loja]", navi: command }]);
  });

  it("sem coordenadas, mostra o rótulo e não inventa link", () => {
    expect(parseDescription("<NAVI>[Loja]<INFO>quebrado</INFO></NAVI>")).toEqual([{ text: "[Loja]" }]);
  });

  it("trata vários destinos na mesma descrição", () => {
    const runs = parseDescription(
      "<NAVI>[Prontera]<INFO>prt_in,63,59,0,100,0,0</INFO></NAVI> ou <NAVI>[Payon]<INFO>payon,145,170,0,100,0,0</INFO></NAVI>",
    );
    expect(runs.map((run) => run.navi)).toEqual([
      "/navi prt_in 63/59",
      undefined,
      "/navi payon 145/170",
    ]);
  });
});
