/**
 * Leitura defensiva do que está guardado no navegador.
 *
 * A garantia que interessa: um registro estragado descarta a si mesmo e nada mais. Se um
 * parser rejeitasse o objeto inteiro, um byte errado num alerta apagaria a lista de
 * alertas da pessoa sem aviso.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALERTS_CONFIG,
  parseAlerts,
  parseAlertsConfig,
  parseFavorites,
  parsePricesSnapshot,
} from "../persist.js";

describe("parseFavorites", () => {
  it("lê uma lista de ids", () => {
    expect(parseFavorites("[501,1201]")).toEqual([501, 1201]);
  });

  it("descarta o que não é id de item", () => {
    expect(parseFavorites('[501,"501",0,-1,1.5,null,{}]')).toEqual([501]);
  });

  it("deduplica — a lista é um conjunto disfarçado", () => {
    expect(parseFavorites("[501,501,1201,501]")).toEqual([501, 1201]);
  });

  it("devolve null quando não é lista, para valer o padrão", () => {
    for (const raw of [null, "{}", '"501"', "1", "não é json"]) {
      expect(parseFavorites(raw)).toBeNull();
    }
  });

  it("lista vazia é uma resposta válida, não ausência", () => {
    expect(parseFavorites("[]")).toEqual([]);
  });
});

describe("parseAlerts", () => {
  const bom = { enabled: true, direction: "up", targetPrice: 1000, lastAlertedPrice: 900 };

  it("lê um alerta completo", () => {
    expect(parseAlerts(JSON.stringify({ "FREYA:501": bom }))).toEqual({ "FREYA:501": bom });
  });

  it("descarta chave malformada e PRESERVA as boas", () => {
    const raw = JSON.stringify({
      "FREYA:501": bom,
      "XPTO:502": bom,
      "FREYA:0": bom,
      semDoisPontos: bom,
    });
    expect(Object.keys(parseAlerts(raw)!)).toEqual(["FREYA:501"]);
  });

  it("descarta entrada malformada e PRESERVA as boas", () => {
    const raw = JSON.stringify({
      "FREYA:501": bom,
      "FREYA:502": { ...bom, targetPrice: 0 },
      "FREYA:503": { ...bom, targetPrice: "mil" },
      "FREYA:504": null,
      "FREYA:505": 42,
    });
    expect(Object.keys(parseAlerts(raw)!)).toEqual(["FREYA:501"]);
  });

  it("campo ausente cai num padrão seguro em vez de derrubar o registro", () => {
    const r = parseAlerts(JSON.stringify({ "FREYA:501": { targetPrice: 1000 } }))!;
    // Desligado e "queda" são os padrões conservadores: não avisar sem a pessoa ter
    // pedido, e não trocar a direção do que ela configurou.
    expect(r["FREYA:501"]).toEqual({
      enabled: false,
      direction: "down",
      targetPrice: 1000,
      lastAlertedPrice: null,
    });
  });

  it("direção desconhecida vira 'down'", () => {
    const r = parseAlerts(JSON.stringify({ "FREYA:501": { ...bom, direction: "lateral" } }))!;
    expect(r["FREYA:501"]!.direction).toBe("down");
  });

  it("devolve null quando não é objeto", () => {
    for (const raw of [null, "[]", '"x"', "quebrado"]) expect(parseAlerts(raw)).toBeNull();
  });
});

describe("parseAlertsConfig", () => {
  it("lê a configuração inteira", () => {
    expect(parseAlertsConfig('{"ntfyEnabled":true,"ntfyTopic":"abc"}')).toEqual({
      ntfyEnabled: true,
      ntfyTopic: "abc",
    });
  });

  it("campo ausente cai no padrão", () => {
    expect(parseAlertsConfig("{}")).toEqual(DEFAULT_ALERTS_CONFIG);
  });

  it("o canal só liga com `true` explícito", () => {
    expect(parseAlertsConfig('{"ntfyEnabled":"sim"}')!.ntfyEnabled).toBe(false);
    expect(parseAlertsConfig('{"ntfyEnabled":1}')!.ntfyEnabled).toBe(false);
  });

  /** O campo saiu da interface; uma configuração antiga não pode quebrar a leitura. */
  it("ignora o `intervalSec` de versões anteriores", () => {
    expect(parseAlertsConfig('{"ntfyEnabled":true,"ntfyTopic":"x","intervalSec":300}')).toEqual({
      ntfyEnabled: true,
      ntfyTopic: "x",
    });
  });

  it("devolve null quando não é objeto", () => {
    for (const raw of [null, "[]", '"x"', "quebrado"]) expect(parseAlertsConfig(raw)).toBeNull();
  });
});

/**
 * O retrato guardado é cache de EXIBIÇÃO: a aba que não roda o laço lê daqui, e um
 * recarregamento pinta a tabela na hora em vez de mostrar travessões até o próximo ciclo.
 * Por ser cache, entrada suja tem que degradar para menos linhas — nunca para uma exceção
 * no meio do primeiro render.
 */
describe("parsePricesSnapshot", () => {
  const bom = {
    at: 1_700_000_000_000,
    prices: [{ itemId: 501, name: "Poção" }],
    missing: [999],
    freshness: { tradingAt: 1, marketAt: 2, tradingAgeMin: 3 },
    nextTradingAt: 1_700_000_100,
  };

  it("lê um retrato completo", () => {
    expect(parsePricesSnapshot(JSON.stringify(bom))).toEqual(bom);
  });

  it("descarta preço sem id utilizável e preserva os bons", () => {
    const raw = JSON.stringify({ ...bom, prices: [{ itemId: 501 }, { itemId: 0 }, {}, null, 7] });
    expect(parsePricesSnapshot(raw)!.prices).toEqual([{ itemId: 501 }]);
  });

  it("sem 'at' ou sem lista de preços não é retrato", () => {
    expect(parsePricesSnapshot(JSON.stringify({ ...bom, at: "agora" }))).toBeNull();
    expect(parsePricesSnapshot(JSON.stringify({ ...bom, prices: {} }))).toBeNull();
    for (const raw of [null, "[]", "quebrado"]) expect(parsePricesSnapshot(raw)).toBeNull();
  });

  it("campos acessórios ruins caem em vazio em vez de derrubar o retrato", () => {
    const r = parsePricesSnapshot(
      JSON.stringify({ at: 1, prices: [], missing: "tudo", freshness: 7, nextTradingAt: "logo" }),
    )!;
    expect(r.missing).toEqual([]);
    expect(r.freshness).toBeNull();
    expect(r.nextTradingAt).toBeNull();
  });
});
