/**
 * A volta inteira, com as duas pontas conversando: a página pede, a conexão busca no site, a
 * resposta vira o que a tabela mostra e o que o alerta decide.
 *
 * As duas janelas são falsas, mas o código dos dois lados é o de produção — o mesmo
 * `marketBridge` que vira favorito e o mesmo `BridgeClient` do `App`. O que se prova aqui é
 * o encaixe: o `postMessage` de ida e volta, o casamento por id, e o caminho da página HTML
 * do site até `MarketCheck`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { planAlerts } from "../../lib/alerts.js";
import { interpret } from "../../lib/market/checks.js";
import { checkUrlForTerm } from "../../lib/market/url.js";
import type { Alert } from "../../lib/persist.js";
import { BRIDGE_VERSION, marketBridge } from "../bridge.js";
import { BridgeClient } from "../client.js";
import type { BridgeMessage } from "../protocol.js";

const OUR = "http://localhost:5173";
const MARKET = "https://ro.gnjoyamericas.com";

const page = readFileSync(
  resolve(import.meta.dirname, "../../lib/market/__tests__/fixtures/trading-carta-zangao.html"),
  "utf8",
);

/** Um par de janelas que entregam `postMessage` uma para a outra, como abas de verdade. */
function wiredWindows(fetchImpl: typeof fetch) {
  const listeners = { page: [] as Array<(e: MessageEvent) => void>, market: [] as Array<(e: MessageEvent) => void> };

  const deliver = (side: "page" | "market", origin: string, data: BridgeMessage, source: unknown) => {
    for (const fn of [...listeners[side]]) fn({ origin, data, source } as unknown as MessageEvent);
  };

  const pageWin = {
    closed: false,
    open: vi.fn(),
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.page.push(fn),
    removeEventListener: (_t: string, fn: (e: MessageEvent) => void) => {
      listeners.page = listeners.page.filter((l) => l !== fn);
    },
    // A conexão responde para a janela da página; o remetente visto lá é a aba do mercado.
    postMessage: (data: BridgeMessage, origin: string) => {
      expect(origin).toBe(OUR);
      deliver("page", MARKET, data, marketWin);
    },
  };

  const marketWin = {
    closed: false,
    location: { hostname: "ro.gnjoyamericas.com", origin: MARKET },
    document,
    opener: pageWin,
    alert: vi.fn(),
    open: vi.fn(),
    fetch: fetchImpl,
    setInterval: vi.fn(),
    addEventListener: (t: string, fn: (e: MessageEvent) => void) => t === "message" && listeners.market.push(fn),
    postMessage: (data: BridgeMessage, origin: string) => {
      expect(origin).toBe(MARKET);
      deliver("market", OUR, data, pageWin);
    },
  };

  return {
    pageWin: pageWin as unknown as Window,
    marketWin: marketWin as unknown as Window,
    /** Uma terceira página qualquer mandando mensagem para a aba do mercado. */
    sendFrom: (origin: string, data: BridgeMessage) => deliver("market", origin, data, { postMessage: vi.fn() }),
  };
}

describe("página ↔ conexão ↔ site", () => {
  it("consulta um item e chega ao preço, ao alerta e ao aviso", async () => {
    const fetchMock = vi.fn(async () => new Response(page, { status: 200 }));
    const { pageWin, marketWin } = wiredWindows(fetchMock as unknown as typeof fetch);

    const client = new BridgeClient(pageWin, MARKET);
    expect(client.state()).toBe("disconnected");

    // A pessoa clica no favorito na aba do mercado.
    marketBridge(OUR, BRIDGE_VERSION, marketWin);
    expect(client.state()).toBe("connected");

    const url = checkUrlForTerm("Carta Zangão", "FREYA")!;
    const res = await client.fetch(url);
    expect(fetchMock).toHaveBeenCalledWith(url, { credentials: "same-origin", cache: "no-store" });

    const { outcome, checks } = interpret(res, [4019], 1_800_000_000_000);
    const check = checks.get(4019);
    expect(outcome).toBe("ok");
    expect(check).toMatchObject({ status: "ok", min: 1111, stores: 2, units: 4, seller: "Vendedor Um" });

    // E o alerta decide a partir exatamente desse retrato.
    const alert: Alert = { enabled: true, direction: "down", targetPrice: 2000, lastAlertedPrice: null };
    const plan = planAlerts("FREYA", { "FREYA:4019": alert }, new Set([4019]), [
      { itemId: 4019, name: "Carta Zangão", check: check! },
    ]);
    expect(plan.notifications).toHaveLength(1);
    expect(plan.notifications[0]).toMatchObject({ title: "Preço baixou: Carta Zangão" });
    expect(plan.notifications[0]!.click).toContain("ro.gnjoyamericas.com");
  });

  it("o 429 do site chega inteiro do outro lado, sem virar 'ninguém vendendo'", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 429 }));
    const { pageWin, marketWin } = wiredWindows(fetchMock as unknown as typeof fetch);
    const client = new BridgeClient(pageWin, MARKET);
    marketBridge(OUR, BRIDGE_VERSION, marketWin);

    const res = await client.fetch(checkUrlForTerm("Carta Zangão", "FREYA")!);
    const { outcome, checks } = interpret(res, [4019], 1_800_000_000_000);
    expect(outcome).toBe("blocked");
    // Nenhum retrato: a linha continua com a última consulta boa, e o alerta não decide nada.
    expect(checks.size).toBe(0);
  });

  it("a conexão ignora um pedido de outra origem, mesmo com a página conectada", async () => {
    const fetchMock = vi.fn(async () => new Response(page, { status: 200 }));
    const { pageWin, marketWin, sendFrom } = wiredWindows(fetchMock as unknown as typeof fetch);
    new BridgeClient(pageWin, MARKET);
    marketBridge(OUR, BRIDGE_VERSION, marketWin);

    // Uma terceira página, noutra origem, mandando a mesma mensagem que a nossa manda.
    sendFrom("https://evil.example", { type: "lm-fetch", id: 99, url: checkUrlForTerm("Carta Zangão", "FREYA")! });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
