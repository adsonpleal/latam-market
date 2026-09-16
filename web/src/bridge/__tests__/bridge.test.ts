/**
 * A conexão roda num site que não é nosso, com os cookies da pessoa. O que ela aceita fazer
 * precisa ser exatamente o que o cabeçalho de `bridge.ts` promete — e o teste é o lugar
 * onde essa promessa deixa de ser comentário.
 */

import { describe, expect, it, vi } from "vitest";

import { BridgeClient, STALE_MS } from "../client.js";
import { BRIDGE_VERSION, marketBridge } from "../bridge.js";
import { bookmarkletCode, bookmarkletHref } from "../bookmarklet.js";
import { MARKET_ORIGIN, TRADING_PATH } from "../../lib/market/url.js";
import type { BridgeMessage } from "../protocol.js";

const OUR = "https://mercado.latam-tools.com.br";
const MARKET = "https://ro.gnjoyamericas.com";
const TRADING = `${MARKET}/pt/intro/shop-search/trading?serverType=FREYA&searchWord=Poring`;

interface FakePeer {
  closed: boolean;
  posted: Array<{ msg: BridgeMessage; origin: string }>;
  postMessage: (msg: BridgeMessage, origin: string) => void;
}

const fakePeer = (): FakePeer => {
  const peer: FakePeer = {
    closed: false,
    posted: [],
    postMessage: (msg, origin) => peer.posted.push({ msg, origin }),
  };
  return peer;
};

/** Uma janela do site do mercado, só com o que a conexão toca. */
function marketWindow(opts: { host?: string; fetch?: typeof fetch; opener?: FakePeer | null } = {}) {
  let handler: ((e: MessageEvent) => void) | null = null;
  const win = {
    location: { hostname: opts.host ?? "ro.gnjoyamericas.com", origin: MARKET },
    document,
    opener: opts.opener ?? null,
    alert: vi.fn(),
    open: vi.fn(),
    fetch: opts.fetch ?? vi.fn(),
    setInterval: vi.fn(),
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => {
      if (type === "message") handler = fn;
    },
  };
  const dispatch = (origin: string, data: BridgeMessage, source: FakePeer) =>
    handler!({ origin, data, source } as unknown as MessageEvent);
  return { win: win as unknown as Window & typeof win, dispatch, hasListener: () => handler !== null };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("marketBridge", () => {
  it("fora do site do mercado, só avisa e não escuta nada", () => {
    const { win, hasListener } = marketWindow({ host: "example.com" });
    marketBridge(OUR, BRIDGE_VERSION, win);
    expect(win.alert).toHaveBeenCalled();
    expect(hasListener()).toBe(false);
  });

  it("anuncia-se para quem abriu a aba", () => {
    const opener = fakePeer();
    const { win } = marketWindow({ opener });
    marketBridge(OUR, BRIDGE_VERSION, win);
    expect(opener.posted[0]).toMatchObject({ msg: { type: "lm-hello", version: BRIDGE_VERSION }, origin: OUR });
  });

  it("ignora mensagem de qualquer outra origem", async () => {
    const { win, dispatch } = marketWindow();
    marketBridge(OUR, BRIDGE_VERSION, win);
    const source = fakePeer();
    dispatch("https://evil.example", { type: "lm-fetch", id: 1, url: TRADING }, source);
    await flush();
    expect(win.fetch).not.toHaveBeenCalled();
    expect(source.posted).toEqual([]);
  });

  it("recusa buscar qualquer coisa além da página de lojas", async () => {
    const { win, dispatch } = marketWindow();
    marketBridge(OUR, BRIDGE_VERSION, win);
    const source = fakePeer();
    for (const url of [
      `${MARKET}/pt/mypage`,
      `${MARKET}/pt/intro/shop-search/trading/../../../account`,
      "https://example.com/pt/intro/shop-search/trading",
      `${MARKET}/pt/intro/shop-search/market-price`,
    ]) {
      dispatch(OUR, { type: "lm-fetch", id: 7, url }, source);
    }
    await flush();
    expect(win.fetch).not.toHaveBeenCalled();
    expect(source.posted).toHaveLength(4);
    for (const { msg, origin } of source.posted) {
      expect(origin).toBe(OUR);
      expect(msg).toMatchObject({ type: "lm-result", id: 7, status: 0 });
    }
  });

  it("busca a página de lojas na mesma origem e devolve para quem pediu", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>ok</html>", { status: 200 }));
    const { win, dispatch } = marketWindow({ fetch: fetchMock as unknown as typeof fetch });
    marketBridge(OUR, BRIDGE_VERSION, win);
    const source = fakePeer();
    dispatch(OUR, { type: "lm-fetch", id: 3, url: TRADING }, source);
    await flush();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(TRADING, { credentials: "same-origin", cache: "no-store" });
    expect(source.posted.at(-1)).toEqual({
      msg: { type: "lm-result", id: 3, status: 200, challenge: false, body: "<html>ok</html>", error: null },
      origin: OUR,
    });
  });

  it("marca o desafio do Cloudflare", async () => {
    const fetchMock = vi.fn(
      async () => new Response("Just a moment", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    );
    const { win, dispatch } = marketWindow({ fetch: fetchMock as unknown as typeof fetch });
    marketBridge(OUR, BRIDGE_VERSION, win);
    const source = fakePeer();
    dispatch(OUR, { type: "lm-fetch", id: 4, url: TRADING }, source);
    await flush();
    await flush();
    expect(source.posted.at(-1)?.msg).toMatchObject({ status: 403, challenge: true });
  });
});

describe("favorito", () => {
  it("é autossuficiente: roda sem nada de fora do próprio texto", () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    // O jsdom está em localhost, então a conexão só pode avisar — e avisar prova que o texto
    // inteiro compilou e rodou sem referência solta.
    new Function(bookmarkletCode(OUR))();
    expect(alert).toHaveBeenCalledOnce();
    alert.mockRestore();
  });

  /**
   * A conexão repete o host e o caminho porque tem de ser autossuficiente. Se `url.ts` mudar e
   * ela não, a conexão recusa em silêncio toda consulta que a página monta.
   */
  it("carrega o mesmo host e caminho que a página usa para montar a URL", () => {
    const code = bookmarkletCode(OUR);
    expect(code).toContain(TRADING_PATH);
    expect(code).toContain(new URL(MARKET_ORIGIN).hostname);
  });

  it("o href decodifica para o mesmo código", () => {
    const href = bookmarkletHref(OUR);
    expect(href.startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(href.slice("javascript:".length))).toBe(`${bookmarkletCode(OUR)}void 0`);
  });
});

describe("BridgeClient", () => {
  function pageWindow() {
    let handler: ((e: MessageEvent) => void) | null = null;
    const win = {
      open: vi.fn(),
      addEventListener: (_: string, fn: (e: MessageEvent) => void) => (handler = fn),
      removeEventListener: vi.fn(),
    };
    const dispatch = (origin: string, data: BridgeMessage, source: FakePeer) =>
      handler!({ origin, data, source } as unknown as MessageEvent);
    return { win: win as unknown as Window, dispatch };
  }

  it("conecta com o anúncio da conexão, responde e fica sem resposta sem pong", () => {
    let now = 1_000;
    const { win, dispatch } = pageWindow();
    const client = new BridgeClient(win, MARKET, () => now);
    expect(client.state()).toBe("disconnected");

    const bridge = fakePeer();
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION, session: "a" }, bridge);
    expect(client.state()).toBe("connected");
    expect(bridge.posted[0]).toEqual({ msg: { type: "lm-ack" }, origin: MARKET });

    now += STALE_MS + 1;
    expect(client.state()).toBe("stale");
    dispatch(MARKET, { type: "lm-pong", session: "a" }, bridge);
    expect(client.state()).toBe("connected");

    bridge.closed = true;
    expect(client.state()).toBe("disconnected");
  });

  it("não conversa com quem não é o site do mercado", () => {
    const { win, dispatch } = pageWindow();
    const client = new BridgeClient(win, MARKET);
    dispatch("https://evil.example", { type: "lm-hello", version: BRIDGE_VERSION, session: "x" }, fakePeer());
    expect(client.state()).toBe("disconnected");
  });

  it("conexão de outra versão pede para arrastar o favorito de novo", () => {
    const { win, dispatch } = pageWindow();
    const client = new BridgeClient(win, MARKET);
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION + 1, session: "x" }, fakePeer());
    expect(client.state()).toBe("outdated");
  });

  it("casa a resposta pelo id, e só do par atual", async () => {
    const { win, dispatch } = pageWindow();
    const client = new BridgeClient(win, MARKET);
    const bridge = fakePeer();
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION, session: "a" }, bridge);

    const pending = client.fetch(TRADING);
    const sent = bridge.posted.at(-1)!.msg as Extract<BridgeMessage, { type: "lm-fetch" }>;
    expect(sent).toMatchObject({ type: "lm-fetch", url: TRADING });

    const result = { type: "lm-result", id: sent.id, status: 200, challenge: false, body: "x", error: null } as const;
    dispatch(MARKET, { ...result, body: "impostora" }, fakePeer());
    dispatch(MARKET, result, bridge);
    await expect(pending).resolves.toEqual({ status: 200, challenge: false, body: "x", error: null });
  });

  it("um clique novo no favorito é avisado, para tirar a pausa de desafio", () => {
    const { win, dispatch } = pageWindow();
    const client = new BridgeClient(win, MARKET);
    const onNew = vi.fn();
    client.onNewSession(onNew);
    const bridge = fakePeer();
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION, session: "a" }, bridge);
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION, session: "a" }, bridge);
    expect(onNew).not.toHaveBeenCalled();
    dispatch(MARKET, { type: "lm-hello", version: BRIDGE_VERSION, session: "b" }, bridge);
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("desconectada, a consulta falha na hora sem mandar nada", async () => {
    const { win } = pageWindow();
    const client = new BridgeClient(win, MARKET);
    await expect(client.fetch(TRADING)).resolves.toMatchObject({ status: 0, error: "sem conexão com o mercado" });
  });
});
