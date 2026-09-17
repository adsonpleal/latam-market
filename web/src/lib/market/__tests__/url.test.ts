/**
 * Os links de um item.
 *
 * O que estes testes guardam é um contrato com um site de terceiro, verificado ao vivo: os
 * parâmetros que cada página aceita, e o nome que a busca recusa. Um link errado não quebra
 * nada aqui dentro — ele leva a pessoa a uma página vazia, o que é pior de perceber.
 */

import { describe, expect, it } from "vitest";

import { MARKET_ORIGIN, TRADING_PATH, linksFor } from "../url.js";

const links = (name: string, server: "FREYA" | "NIDHOGG" = "FREYA") => linksFor(1101, name, server);

describe("linksFor", () => {
  it("manda para a descrição do item no Divine Pride", () => {
    expect(links("Sabre").divinePride).toBe("https://www.divine-pride.net/database/item/1101");
  });

  it("abre as lojas ordenadas do mais barato: quem clica veio de um preço", () => {
    const url = new URL(links("Sabre").market!);
    expect(url.origin + url.pathname).toBe(MARKET_ORIGIN + TRADING_PATH);
    expect(url.searchParams.get("sortType")).toBe("LOW_PRICE");
    expect(url.searchParams.get("storeType")).toBe("BUY");
    expect(url.searchParams.get("p")).toBe("1");
  });

  it("abre o histórico na página de preço do site, com a série inteira", () => {
    const url = new URL(links("Sabre").marketHistory!);
    expect(url.origin + url.pathname).toBe(`${MARKET_ORIGIN}/pt/intro/shop-search/market-price`);
    expect(url.searchParams.get("period")).toBe("ALL");
  });

  it("o histórico não ordena por preço: é um agregado, não uma lista de anúncios", () => {
    const url = new URL(links("Sabre").marketHistory!);
    for (const param of ["sortType", "storeType", "p", "limit"]) {
      expect(url.searchParams.get(param)).toBeNull();
    }
  });

  it("os dois links do mercado carregam o servidor de quem está olhando", () => {
    const { market, marketHistory } = links("Sabre", "NIDHOGG");
    expect(new URL(market!).searchParams.get("serverType")).toBe("NIDHOGG");
    expect(new URL(marketHistory!).searchParams.get("serverType")).toBe("NIDHOGG");
  });

  it("busca pelo maior trecho que o site aceita, sem slots nem hífen", () => {
    expect(new URL(links("Sabre [3]").market!).searchParams.get("searchWord")).toBe("Sabre");
    expect(new URL(links("Ovo de Abelha-Rainha").market!).searchParams.get("searchWord")).toBe("Ovo de Abelha");
  });

  it("nome que o site recusa não vira link de mercado nenhum", () => {
    const unsearchable = links("[]");
    expect(unsearchable.market).toBeNull();
    expect(unsearchable.marketHistory).toBeNull();
    // O Divine Pride é por id, então continua valendo.
    expect(unsearchable.divinePride).toContain("1101");
  });
});
