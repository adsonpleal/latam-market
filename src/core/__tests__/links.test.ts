/**
 * O que estes testes protegem: o link do mercado tem que abrir uma busca que o site
 * ACEITA. Verificado ao vivo contra o site — `Abelha-Rainha` responde 200 com corpo
 * vazio (a forma de recusa dele), `Ovo de Abelha` responde 13 resultados.
 */

import { describe, expect, it } from "vitest";

import { linksFor, searchWordFor } from "../links.js";

describe("searchWordFor", () => {
  it("mantém o nome inteiro quando é seguro", () => {
    expect(searchWordFor("Bota Temporal VIT")).toBe("Bota Temporal VIT");
  });

  it("aceita acento e espaço, que o site não recusa", () => {
    expect(searchWordFor("Poção Vermelha")).toBe("Poção Vermelha");
    expect(searchWordFor("Chapéu de Viagem")).toBe("Chapéu de Viagem");
  });

  it("corta no caractere especial e fica com o maior trecho", () => {
    // Como a busca do site é por substring, "Ovo de Abelha" acha o item do mesmo
    // jeito — e é maior que "Rainha", então tem menos chance de trazer lixo junto.
    expect(searchWordFor("Ovo de Abelha-Rainha")).toBe("Ovo de Abelha");
  });

  it("descarta o sufixo de slots", () => {
    expect(searchWordFor("Espada [3]")).toBe("Espada");
  });

  it("devolve null quando não sobra nada buscável", () => {
    // Melhor não oferecer link do que oferecer um que abre vazio.
    expect(searchWordFor("---")).toBeNull();
    expect(searchWordFor("")).toBeNull();
  });
});

describe("linksFor", () => {
  const links = linksFor(22003, "Bota Temporal VIT", "FREYA");

  it("aponta para a página do item no Divine Pride", () => {
    expect(links.divinePride).toBe("https://www.divine-pride.net/database/item/22003");
  });

  it("monta a busca ao vivo com servidor e tipo de loja", () => {
    const url = new URL(links.market!);
    expect(url.origin + url.pathname).toBe(
      "https://ro.gnjoylatam.com/pt/intro/shop-search/trading",
    );
    expect(url.searchParams.get("searchWord")).toBe("Bota Temporal VIT");
    expect(url.searchParams.get("serverType")).toBe("FREYA");
    expect(url.searchParams.get("storeType")).toBe("BUY");
  });

  it("monta o link de histórico no dataset certo", () => {
    const url = new URL(links.marketHistory!);
    expect(url.pathname).toContain("market-price");
    expect(url.searchParams.get("period")).toBe("ALL");
    // `storeType` é do outro dataset; mandá-lo aqui seria ruído.
    expect(url.searchParams.has("storeType")).toBe(false);
  });

  /**
   * Quem clica veio de um preço — o mínimo da tabela, ou o alvo de um alerta que acabou de
   * disparar — e precisa achar a loja que cobra aquilo. Na ordenação padrão do site esse
   * anúncio pode estar em qualquer lugar da lista.
   */
  it("abre ordenado do mais barato, na primeira página", () => {
    const url = new URL(links.market!);
    expect(url.searchParams.get("sortType")).toBe("LOW_PRICE");
    expect(url.searchParams.get("p")).toBe("1");
  });

  it("não leva o `limit` do coletor — o link é para uma pessoa abrir", () => {
    expect(new URL(links.market!).searchParams.has("limit")).toBe(false);
  });

  it("o histórico não ordena por preço: é um agregado, não uma lista de anúncios", () => {
    const url = new URL(links.marketHistory!);
    expect(url.searchParams.has("sortType")).toBe(false);
    expect(url.searchParams.has("p")).toBe(false);
  });

  /** A ordem dos parâmetros é a mesma que o site produz, para o link ser reconhecível. */
  it("monta a URL inteira do jeito esperado", () => {
    expect(linksFor(659, "Ovo de Abelha-Rainha", "FREYA").market).toBe(
      "https://ro.gnjoylatam.com/pt/intro/shop-search/trading" +
        "?serverType=FREYA&searchWord=Ovo+de+Abelha&storeType=BUY&sortType=LOW_PRICE&p=1",
    );
  });

  it("omite o link do mercado quando o nome não é buscável, mas mantém o Divine Pride", () => {
    const unsearchable = linksFor(999, "!!!", "FREYA");
    expect(unsearchable.market).toBeNull();
    expect(unsearchable.marketHistory).toBeNull();
    expect(unsearchable.divinePride).toContain("/999");
  });
});

/**
 * O servidor entra na URL do mercado oficial. Sem isso, um link gerado para NIDHOGG
 * abriria a busca em FREYA e mostraria outro mercado sem avisar.
 */
describe("linksFor por servidor", () => {
  it("carimba o serverType pedido", () => {
    const freya = linksFor(501, "Poção Vermelha", "FREYA");
    const nidhogg = linksFor(501, "Poção Vermelha", "NIDHOGG");
    expect(new URL(freya.market!).searchParams.get("serverType")).toBe("FREYA");
    expect(new URL(nidhogg.market!).searchParams.get("serverType")).toBe("NIDHOGG");
    expect(new URL(nidhogg.marketHistory!).searchParams.get("serverType")).toBe("NIDHOGG");
  });

  it("o Divine Pride não depende de servidor", () => {
    expect(linksFor(501, "Poção Vermelha", "NIDHOGG").divinePride).toBe(
      linksFor(501, "Poção Vermelha", "FREYA").divinePride,
    );
  });
});
