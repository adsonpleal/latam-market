/**
 * A conexão: o código que o favorito roda na aba do site oficial.
 *
 * **Por que existe.** O site do mercado não manda cabeçalho de CORS (o preflight leva 403) e
 * não aceita ser aberto em iframe (`frame-ancestors 'none'`). Uma página em outro domínio,
 * como a nossa, não consegue ler a resposta dele de jeito nenhum — nem de um Web Worker,
 * nem de um Service Worker, que obedecem o mesmo CORS. Consultar de um servidor nosso
 * também não serve: é o que a coleta fazia, e todos os IPs dela foram bloqueados. O que
 * sobra é pedir de dentro do próprio site: uma aba aberta nele, com este código rodando,
 * faz a busca na mesma origem — com os cookies e o IP da pessoa — e devolve o HTML para a
 * nossa página por `postMessage`.
 *
 * **O que ela aceita fazer, e nada além:** buscar `TRADING_PATH` na origem do site, a
 * pedido de mensagens vindas exatamente de `origin` (a nossa página, carimbada no favorito
 * quando ele é gerado). Não lê cookie, não navega, não busca outra página do site. Uma
 * mensagem de outra origem é ignorada em silêncio.
 *
 * **Tem que ser autossuficiente.** O favorito é `javascript:(<esta função>)(...)`, montado
 * com `Function.prototype.toString` em `bookmarklet.ts`. Nada de import, nada de variável
 * de fora do corpo — nem as constantes de `lib/market/url.ts`, que por isso estão repetidas
 * aqui e conferidas no teste. Pelo mesmo motivo os tipos das mensagens ficam em
 * `protocol.ts`, que só tem tipo.
 *
 * **Mostra o que faz.** Um selo fixo no canto da página do mercado diz que a conexão está
 * ativa, quantas consultas fez e o último estado que a nossa página mandou (inclusive o
 * bloqueio). A pessoa nunca fica sem saber por que aquela aba está aberta.
 */

import type { BridgeMessage } from "./protocol.js";

export const BRIDGE_VERSION = 1;

export function marketBridge(origin: string, version: number, win: Window = window): void {
  const MARKET_HOST = "ro.gnjoyamericas.com";
  const TRADING_PATH = "/pt/intro/shop-search/trading";
  const HELLO_EVERY_MS = 3_000;
  const ACK_GRACE_MS = 2_500;

  if (win.location.hostname !== MARKET_HOST) {
    win.alert(
      "Este favorito conecta o latam-market ao mercado. Ele só funciona na aba do site oficial do " +
        "mercado (ro.gnjoyamericas.com) — abra por \"Abrir aba do mercado\" na aba Favoritos.",
    );
    return;
  }

  type Existing = { hello: () => void };
  const holder = win as Window & { __latamMarketBridge?: Existing };
  // Clicar no favorito de novo não empilha outra conexão: só reanuncia a que já está aí.
  if (holder.__latamMarketBridge) {
    holder.__latamMarketBridge.hello();
    return;
  }

  const doc = win.document;
  const session = Math.random().toString(36).slice(2);
  /** Com quem a conexão fala. Vem do `opener` ou de quem mandou a primeira mensagem. */
  let peer: Window | null = null;
  /** A aba que o botão "Conectar" abriu, quando não havia `opener`. */
  let opened: Window | null = null;
  const startedAt = Date.now();
  let requests = 0;
  let lastAt: number | null = null;
  let pageText = "";
  let pageLevel: "ok" | "warn" | "error" = "ok";

  // --- selo ---------------------------------------------------------------
  const host = doc.createElement("div");
  host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
  // Shadow DOM para o CSS do site não vazar no selo, nem o do selo no site.
  const shadow = host.attachShadow({ mode: "open" });
  const box = doc.createElement("div");
  shadow.appendChild(box);
  const style = doc.createElement("style");
  style.textContent =
    ".b{font:13px/1.4 system-ui,sans-serif;background:#10141c;color:#e8ecf3;border-radius:10px;" +
    "padding:10px 12px;box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:300px;border:2px solid #3b82f6}" +
    ".b.warn{border-color:#f59e0b}.b.error{border-color:#ef4444}" +
    ".t{font-weight:600;margin-bottom:2px}.m{opacity:.8}" +
    "button{margin-top:8px;font:inherit;background:#3b82f6;color:#fff;border:0;border-radius:6px;" +
    "padding:5px 10px;cursor:pointer}";
  shadow.appendChild(style);
  doc.body.appendChild(host);

  const hhmm = (ms: number) =>
    new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  const render = () => {
    const connected = peer !== null && !peer.closed;
    const waiting = !connected && Date.now() - startedAt > ACK_GRACE_MS;
    box.className = `b ${connected ? pageLevel : "warn"}`;
    box.textContent = "";

    const title = doc.createElement("div");
    title.className = "t";
    title.textContent = connected
      ? "Conectado ao latam-market"
      : waiting
        ? "Sem conexão com o latam-market"
        : "Conectando ao latam-market…";
    box.appendChild(title);

    const line = (text: string) => {
      const el = doc.createElement("div");
      el.className = "m";
      el.textContent = text;
      box.appendChild(el);
    };
    line(
      requests === 0
        ? "Nenhuma consulta ainda. Deixe esta aba aberta."
        : `${requests} consulta${requests === 1 ? "" : "s"} daqui, a última às ${hhmm(lastAt!)}.`,
    );
    if (connected && pageText) line(pageText);

    if (waiting) {
      line("Não achei a página do latam-market que abriu esta aba.");
      const button = doc.createElement("button");
      button.textContent = "Conectar ao latam-market";
      button.onclick = () => {
        // Abrir a nossa página a partir daqui dá a ela um `opener` apontando para esta aba.
        opened = win.open(`${origin}/favoritos`, "latam-market");
        hello();
      };
      box.appendChild(button);
    }
  };

  // --- conversa -----------------------------------------------------------
  const send = (target: Window | null, msg: BridgeMessage) => {
    if (target === null || target.closed) return;
    try {
      target.postMessage(msg, origin);
    } catch {
      // Janela de outra origem no meio do caminho: a mensagem só não chega.
    }
  };

  const hello = () => {
    const msg: BridgeMessage = { type: "lm-hello", version, session };
    // Anuncia para todos os candidatos: quem responder com `lm-ack` vira o par.
    for (const target of new Set([peer, win.opener as Window | null, opened])) send(target, msg);
  };

  win.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== origin) return;
    const data = event.data as BridgeMessage | null;
    if (typeof data !== "object" || data === null) return;
    const source = event.source as Window | null;

    if (data.type === "lm-ack" || data.type === "lm-ping") {
      if (peer !== source) {
        peer = source;
        render();
      }
      if (data.type === "lm-ping") send(source, { type: "lm-pong", session });
      return;
    }

    if (data.type === "lm-status") {
      pageText = String(data.text).slice(0, 200);
      pageLevel = data.level === "warn" || data.level === "error" ? data.level : "ok";
      render();
      return;
    }

    if (data.type !== "lm-fetch") return;
    peer = source;

    const { id } = data;
    let url: URL;
    try {
      url = new URL(String(data.url), win.location.origin);
    } catch {
      send(source, { type: "lm-result", id, status: 0, challenge: false, body: "", error: "URL inválida" });
      return;
    }
    if (url.origin !== win.location.origin || url.pathname !== TRADING_PATH) {
      send(source, {
        type: "lm-result",
        id,
        status: 0,
        challenge: false,
        body: "",
        error: "a conexão só busca a página de lojas",
      });
      return;
    }

    requests++;
    lastAt = Date.now();
    render();
    // GET simples, sem cabeçalho nenhum: a mesma requisição de abrir o link no navegador.
    win
      .fetch(url.href, { credentials: "same-origin", cache: "no-store" })
      .then(async (res) => {
        const challenge = res.headers.get("cf-mitigated") === "challenge";
        const body = await res.text();
        send(source, { type: "lm-result", id, status: res.status, challenge, body, error: null });
      })
      .catch((err: unknown) => {
        send(source, {
          type: "lm-result",
          id,
          status: 0,
          challenge: false,
          body: "",
          error: err instanceof Error ? err.message : "falha de rede",
        });
      });
  });

  holder.__latamMarketBridge = { hello };
  hello();
  render();
  // O anúncio repete até alguém responder; depois só serve para reconectar uma página
  // recarregada. Timer de aba em segundo plano pode espaçar isto — por isso a conversa em si
  // é toda por mensagem, que não é estrangulada.
  win.setInterval(() => {
    hello();
    render();
  }, HELLO_EVERY_MS);
}
