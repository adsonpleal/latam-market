/**
 * O lado da nossa página na conversa com a conexão.
 *
 * Não é React: é um objeto que vive enquanto a página vive, e o hook `useBridge` só o
 * observa. A conversa inteira é por mensagem, e a validação é sempre a mesma nos dois
 * sentidos — a origem do evento tem que ser exatamente a do outro lado.
 *
 * O estado de "conectada" vem de um `lm-ping` que a página manda de tempos em tempos e a
 * conexão responde na hora. Não do anúncio periódico da conexão: aquele depende de timer da aba
 * do mercado, que o navegador espaça para um por minuto quando ela fica em segundo plano — e
 * a aba do mercado vive em segundo plano, é o normal dela.
 */

import { MARKET_ORIGIN } from "../lib/market/url.js";
import { BRIDGE_VERSION } from "./bridge.js";
import type { BridgeMessage } from "./protocol.js";

export type BridgeState = "disconnected" | "connected" | "stale" | "outdated";

export interface BridgeResponse {
  status: number;
  challenge: boolean;
  body: string;
  error: string | null;
}

/** Sem pong há mais que isto, a conexão está "sem resposta". */
export const STALE_MS = 30_000;

/**
 * Teto de uma consulta.
 *
 * Folgado de propósito: o site responde entre 5 e 30 s quando está sob carga, porque a origem
 * enfileira. Uma consulta que estoura isto conta como erro de rede, não como bloqueio.
 */
const FETCH_TIMEOUT_MS = 90_000;

type Listener = () => void;

export class BridgeClient {
  private peer: Window | null = null;
  private version: number | null = null;
  private session: string | null = null;
  private lastSeen = 0;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: BridgeResponse) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<Listener>();
  private readonly sessionListeners = new Set<Listener>();

  constructor(
    private readonly win: Window,
    private readonly marketOrigin: string = MARKET_ORIGIN,
    private readonly now: () => number = Date.now,
  ) {
    win.addEventListener("message", this.onMessage);
  }

  dispose(): void {
    this.win.removeEventListener("message", this.onMessage);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(failure("página fechada"));
      this.pending.delete(id);
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Avisa quando a pessoa clica no favorito de novo — é o sinal de "resolvi o desafio". */
  onNewSession(fn: Listener): () => void {
    this.sessionListeners.add(fn);
    return () => this.sessionListeners.delete(fn);
  }

  state(): BridgeState {
    if (this.peer === null || this.peer.closed) return "disconnected";
    if (this.version !== BRIDGE_VERSION) return "outdated";
    if (this.now() - this.lastSeen > STALE_MS) return "stale";
    return "connected";
  }

  /**
   * Abre (ou reaproveita) a aba do mercado.
   *
   * O nome fixo faz o segundo clique trazer a mesma aba em vez de abrir outra. Sem
   * `noopener`, de propósito: é o `opener` que deixa a conexão achar esta página.
   */
  open(url: string): void {
    this.win.open(url, "latam-market-bridge");
  }

  ping(): void {
    this.post({ type: "lm-ping" });
    // Um par que fechou não manda pong; quem observa precisa reavaliar mesmo assim.
    this.emit();
  }

  status(text: string, level: "ok" | "warn" | "error"): void {
    this.post({ type: "lm-status", text, level });
  }

  /** Nunca rejeita: falha vira `status: 0` com `error`, para o laço tratar num lugar só. */
  fetch(url: string): Promise<BridgeResponse> {
    if (this.state() === "disconnected") return Promise.resolve(failure("sem conexão com o mercado"));
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failure("a aba do mercado não respondeu a tempo"));
      }, FETCH_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.post({ type: "lm-fetch", id, url });
    });
  }

  private post(msg: BridgeMessage): void {
    const peer = this.peer;
    if (peer === null || peer.closed) return;
    try {
      peer.postMessage(msg, this.marketOrigin);
    } catch {
      // A aba navegou para fora do site: `state()` descobre no próximo ping.
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.origin !== this.marketOrigin) return;
    const data = event.data as BridgeMessage | null;
    if (typeof data !== "object" || data === null) return;
    const source = event.source as Window | null;

    switch (data.type) {
      case "lm-hello": {
        const isNew = this.session !== null && this.session !== data.session;
        this.peer = source;
        this.version = typeof data.version === "number" ? data.version : null;
        this.session = String(data.session);
        this.lastSeen = this.now();
        this.post({ type: "lm-ack" });
        if (isNew) for (const fn of this.sessionListeners) fn();
        this.emit();
        return;
      }
      case "lm-pong":
        if (source !== this.peer) return;
        this.lastSeen = this.now();
        this.emit();
        return;
      case "lm-result": {
        // Só do par atual: outra aba do mercado com uma conexão velha não responde por esta.
        if (source !== this.peer) return;
        const p = this.pending.get(data.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(data.id);
        this.lastSeen = this.now();
        p.resolve({
          status: typeof data.status === "number" ? data.status : 0,
          challenge: data.challenge === true,
          body: typeof data.body === "string" ? data.body : "",
          error: typeof data.error === "string" ? data.error : null,
        });
        return;
      }
      default:
        return;
    }
  };
}

const failure = (error: string): BridgeResponse => ({ status: 0, challenge: false, body: "", error });
