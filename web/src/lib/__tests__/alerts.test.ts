/**
 * O ciclo de vida de um alerta.
 *
 * É a lógica mais fácil de quebrar sem ninguém notar: o modo de falhar é "não avisou", e
 * quem não recebeu um aviso não tem como saber que devia ter recebido. Os testes de
 * queda e de alta são espelhos de propósito — a assimetria entre eles seria justamente o
 * bug que passaria despercebido.
 */

import { describe, expect, it } from "vitest";

import type { ItemPrice } from "../../api/types.js";
import {
  COALESCE_ABOVE,
  applyAlertPatch,
  coalesce,
  evaluateAlert,
  gapToTarget,
  planAlerts,
  type AlertNotification,
} from "../alerts.js";
import { alertKey, parseAlertKey, type Alert } from "../persist.js";

const armed = (over: Partial<Alert> = {}): Alert => ({
  enabled: true,
  direction: "down",
  targetPrice: 1000,
  lastAlertedPrice: null,
  ...over,
});

describe("evaluateAlert — queda (quero comprar)", () => {
  it("dispara quando o preço encosta no alvo", () => {
    expect(evaluateAlert(armed(), 1000)).toEqual({ fire: true, patch: { lastAlertedPrice: 1000 } });
  });

  it("dispara abaixo do alvo", () => {
    expect(evaluateAlert(armed(), 900)).toEqual({ fire: true, patch: { lastAlertedPrice: 900 } });
  });

  it("não avisa acima do alvo", () => {
    expect(evaluateAlert(armed(), 1001)).toEqual({ fire: false, patch: null });
  });

  it("não repete o aviso no mesmo preço", () => {
    expect(evaluateAlert(armed({ lastAlertedPrice: 900 }), 900)).toEqual({
      fire: false,
      patch: null,
    });
  });

  it("avisa de novo quando cai mais", () => {
    expect(evaluateAlert(armed({ lastAlertedPrice: 900 }), 800)).toEqual({
      fire: true,
      patch: { lastAlertedPrice: 800 },
    });
  });

  it("não avisa quando sobe mas segue abaixo do alvo", () => {
    expect(evaluateAlert(armed({ lastAlertedPrice: 800 }), 950)).toEqual({
      fire: false,
      patch: null,
    });
  });

  it("rearma ao voltar acima do alvo", () => {
    expect(evaluateAlert(armed({ lastAlertedPrice: 800 }), 1200)).toEqual({
      fire: false,
      patch: { lastAlertedPrice: null },
    });
  });

  it("o ciclo completo: avisa, cala, rearma, avisa de novo no mesmo preço", () => {
    let alert = armed();
    const passo = (price: number) => {
      const { fire, patch } = evaluateAlert(alert, price);
      if (patch) alert = { ...alert, ...patch };
      return fire;
    };

    expect(passo(900)).toBe(true); // primeiro aviso
    expect(passo(900)).toBe(false); // mesmo preço, silêncio
    expect(passo(1500)).toBe(false); // subiu: rearma
    expect(alert.lastAlertedPrice).toBeNull();
    expect(passo(900)).toBe(true); // caiu de novo, avisa de novo
  });
});

describe("evaluateAlert — alta (quero vender)", () => {
  const up = (over: Partial<Alert> = {}) => armed({ direction: "up", ...over });

  it("dispara quando o preço encosta no alvo", () => {
    expect(evaluateAlert(up(), 1000)).toEqual({ fire: true, patch: { lastAlertedPrice: 1000 } });
  });

  it("dispara acima do alvo", () => {
    expect(evaluateAlert(up(), 1100)).toEqual({ fire: true, patch: { lastAlertedPrice: 1100 } });
  });

  it("não avisa abaixo do alvo", () => {
    expect(evaluateAlert(up(), 999)).toEqual({ fire: false, patch: null });
  });

  it("não repete o aviso no mesmo preço", () => {
    expect(evaluateAlert(up({ lastAlertedPrice: 1100 }), 1100)).toEqual({
      fire: false,
      patch: null,
    });
  });

  it("avisa de novo quando sobe mais", () => {
    expect(evaluateAlert(up({ lastAlertedPrice: 1100 }), 1200)).toEqual({
      fire: true,
      patch: { lastAlertedPrice: 1200 },
    });
  });

  it("não avisa quando cai mas segue acima do alvo", () => {
    expect(evaluateAlert(up({ lastAlertedPrice: 1200 }), 1050)).toEqual({
      fire: false,
      patch: null,
    });
  });

  it("rearma ao voltar abaixo do alvo", () => {
    expect(evaluateAlert(up({ lastAlertedPrice: 1200 }), 800)).toEqual({
      fire: false,
      patch: { lastAlertedPrice: null },
    });
  });
});

describe("evaluateAlert — sem preço", () => {
  it("ninguém vendendo não é sinal: nem avisa nem grava", () => {
    for (const direction of ["down", "up"] as const) {
      expect(evaluateAlert(armed({ direction }), null)).toEqual({ fire: false, patch: null });
      expect(evaluateAlert(armed({ direction, lastAlertedPrice: 900 }), null)).toEqual({
        fire: false,
        patch: null,
      });
    }
  });
});

describe("applyAlertPatch", () => {
  it("mudar o alvo rearma, para o preço atual poder disparar já", () => {
    const next = applyAlertPatch(armed({ lastAlertedPrice: 900 }), { targetPrice: 2000 });
    expect(next.lastAlertedPrice).toBeNull();
    expect(next.targetPrice).toBe(2000);
  });

  it("mudar a direção rearma", () => {
    const next = applyAlertPatch(armed({ lastAlertedPrice: 900 }), { direction: "up" });
    expect(next.lastAlertedPrice).toBeNull();
  });

  it("regravar o MESMO alvo não rearma", () => {
    const next = applyAlertPatch(armed({ lastAlertedPrice: 900 }), { targetPrice: 1000 });
    expect(next.lastAlertedPrice).toBe(900);
  });

  it("um patch só de 'enabled' preserva o marcador", () => {
    const next = applyAlertPatch(armed({ lastAlertedPrice: 900 }), { enabled: false });
    expect(next.lastAlertedPrice).toBe(900);
  });

  it("um 'lastAlertedPrice' explícito manda mais que a regra de rearme", () => {
    const next = applyAlertPatch(armed({ lastAlertedPrice: 900 }), {
      targetPrice: 2000,
      lastAlertedPrice: 1500,
    });
    expect(next.lastAlertedPrice).toBe(1500);
  });

  it("sem alerta anterior, cria um armado com o patch aplicado", () => {
    expect(applyAlertPatch(undefined, { targetPrice: 500 })).toEqual({
      enabled: true,
      direction: "down",
      targetPrice: 500,
      lastAlertedPrice: null,
    });
  });
});

describe("chave composta", () => {
  it("vai e volta", () => {
    expect(parseAlertKey(alertKey("NIDHOGG", 501))).toEqual({ server: "NIDHOGG", itemId: 501 });
  });

  it("recusa chave que não é um par servidor:item", () => {
    for (const bad of ["FREYA", "XPTO:501", "FREYA:0", "FREYA:-1", "FREYA:abc", "FREYA:501:2", ""]) {
      expect(parseAlertKey(bad)).toBeNull();
    }
  });
});

const priceOf = (itemId: number, min: number | null, name = `Item ${itemId}`): ItemPrice =>
  ({
    itemId,
    name,
    links: { dp: "dp", market: `market-${itemId}`, marketHistory: null },
    offers: min === null ? null : { min, median: min, max: min, stores: 1, units: 1, at: 0 },
    market: null,
    cheapest: [],
  }) as unknown as ItemPrice;

describe("planAlerts", () => {
  const favorites = new Set([501, 502]);

  it("favorito sem alerta é ignorado", () => {
    const plan = planAlerts("FREYA", {}, favorites, [priceOf(501, 10)]);
    expect(plan).toEqual({ patches: [], notifications: [] });
  });

  it("alerta desligado é ignorado", () => {
    const alerts = { "FREYA:501": armed({ enabled: false }) };
    expect(planAlerts("FREYA", alerts, favorites, [priceOf(501, 10)]).notifications).toEqual([]);
  });

  it("item desfavoritado é ignorado, mas o alerta continua existindo", () => {
    const alerts = { "FREYA:501": armed() };
    const plan = planAlerts("FREYA", alerts, new Set<number>(), [priceOf(501, 10)]);
    expect(plan.notifications).toEqual([]);
    expect(plan.patches).toEqual([]);
    expect(alerts["FREYA:501"]).toBeDefined();
  });

  /** A prova da decisão de escopo: um alvo de FREYA não pode ser julgado em NIDHOGG. */
  it("alerta de outro servidor não vaza para o servidor ativo", () => {
    const alerts = { "FREYA:501": armed({ targetPrice: 1_000_000 }) };
    expect(planAlerts("NIDHOGG", alerts, favorites, [priceOf(501, 10)]).notifications).toEqual([]);
    expect(planAlerts("FREYA", alerts, favorites, [priceOf(501, 10)]).notifications).toHaveLength(1);
  });

  it("item sem oferta nenhuma não gera patch nem aviso", () => {
    const alerts = { "FREYA:501": armed() };
    expect(planAlerts("FREYA", alerts, favorites, [priceOf(501, null)])).toEqual({
      patches: [],
      notifications: [],
    });
  });

  it("dois itens disparando geram dois avisos e dois patches", () => {
    const alerts = { "FREYA:501": armed(), "FREYA:502": armed() };
    const plan = planAlerts("FREYA", alerts, favorites, [priceOf(501, 10), priceOf(502, 20)]);
    expect(plan.notifications).toHaveLength(2);
    expect(plan.patches).toHaveLength(2);
  });

  it("o aviso diz a direção, o servidor e leva o link do mercado", () => {
    const alerts = { "FREYA:501": armed(), "FREYA:502": armed({ direction: "up", targetPrice: 5 }) };
    const [queda, alta] = planAlerts("FREYA", alerts, favorites, [
      priceOf(501, 900, "Poção"),
      priceOf(502, 20, "Elixir"),
    ]).notifications;

    expect(queda?.title).toBe("Preço baixou: Poção");
    expect(queda?.click).toBe("market-501");
    expect(queda?.body).toContain("FREYA");
    expect(alta?.title).toBe("Preço subiu: Elixir");
  });
});

describe("gapToTarget", () => {
  it("positivo enquanto falta cair", () => {
    expect(gapToTarget(armed({ targetPrice: 900 }), 1000)).toBeCloseTo(10);
  });

  it("negativo quando já passou do alvo", () => {
    expect(gapToTarget(armed({ targetPrice: 1100 }), 1000)).toBeCloseTo(-10);
  });

  it("na alta, o sinal se inverte junto com o sentido", () => {
    expect(gapToTarget(armed({ direction: "up", targetPrice: 1100 }), 1000)).toBeCloseTo(10);
    expect(gapToTarget(armed({ direction: "up", targetPrice: 900 }), 1000)).toBeCloseTo(-10);
  });

  it("sem alerta ou sem preço, não há distância a mostrar", () => {
    expect(gapToTarget(undefined, 1000)).toBeNull();
    expect(gapToTarget(armed(), null)).toBeNull();
    expect(gapToTarget(armed(), 0)).toBeNull();
  });
});

/**
 * O agrupamento saiu do laço para cá para ganhar teste.
 *
 * Doze notificações empilhadas no celular não se leem, e além disso o ntfy limita a rajada
 * por IP — as duas razões apontam para o mesmo resumo.
 */
describe("coalesce", () => {
  const notif = (i: number): AlertNotification => ({
    itemId: i,
    name: `Item ${i}`,
    title: `Preço baixou: Item ${i}`,
    body: "corpo",
    click: `link-${i}`,
  });

  it("poucos avisos passam um a um, com o link de cada item", () => {
    const out = coalesce([notif(1), notif(2)]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ title: "Preço baixou: Item 1", body: "corpo", click: "link-1" });
  });

  it("exatamente no limite ainda passa um a um", () => {
    expect(coalesce(Array.from({ length: COALESCE_ABOVE }, (_, i) => notif(i)))).toHaveLength(
      COALESCE_ABOVE,
    );
  });

  it("acima do limite vira um resumo só", () => {
    const out = coalesce(Array.from({ length: 12 }, (_, i) => notif(i)));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("12 itens bateram o alvo");
    expect(out[0]!.body).toContain("Item 0, Item 1, Item 2");
    expect(out[0]!.body).toContain("e mais 9 itens");
    // Sem `click`: o resumo não é de um item só, então não há para onde levar.
    expect(out[0]!.click).toBeUndefined();
  });

  it("nada a avisar, nada a mandar", () => {
    expect(coalesce([])).toEqual([]);
  });
});

/**
 * Devolver a MESMA referência quando nada muda é contrato, não detalhe: é o que deixa
 * `useAlerts` cortar o re-render com `merged === current` em vez de manter uma função de
 * igualdade à parte, que precisaria ser lembrada a cada campo novo de `Alert`.
 */
describe("applyAlertPatch — identidade", () => {
  it("patch sem efeito devolve o mesmo objeto", () => {
    const atual = armed({ lastAlertedPrice: 900 });
    expect(applyAlertPatch(atual, { enabled: true })).toBe(atual);
    expect(applyAlertPatch(atual, {})).toBe(atual);
    expect(applyAlertPatch(atual, { targetPrice: atual.targetPrice })).toBe(atual);
  });

  it("patch com efeito devolve um objeto novo", () => {
    const atual = armed({ lastAlertedPrice: 900 });
    expect(applyAlertPatch(atual, { enabled: false })).not.toBe(atual);
    expect(applyAlertPatch(atual, { targetPrice: 5 })).not.toBe(atual);
  });
});
