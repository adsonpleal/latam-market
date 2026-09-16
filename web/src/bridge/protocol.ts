/**
 * As mensagens entre a nossa página e a conexão na aba do mercado.
 *
 * Só tipos: `bridge.ts` vira texto de favorito e não pode importar valor nenhum.
 */

export type BridgeMessage =
  /** Conexão → página, repetido: "estou aqui". `session` muda a cada clique no favorito. */
  | { type: "lm-hello"; version: number; session: string }
  /** Página → conexão: "sou eu". Vira o par da conexão. */
  | { type: "lm-ack" }
  /** Página → conexão, periódico: prova de vida que não depende de timer da aba do mercado. */
  | { type: "lm-ping" }
  | { type: "lm-pong"; session: string }
  /** Página → conexão: texto para o selo (estado da cota, bloqueio). */
  | { type: "lm-status"; text: string; level: "ok" | "warn" | "error" }
  /** Página → conexão: busque esta URL. */
  | { type: "lm-fetch"; id: number; url: string }
  /** Conexão → página. `status` 0 é falha antes de haver resposta; `error` diz qual. */
  | {
      type: "lm-result";
      id: number;
      status: number;
      challenge: boolean;
      body: string;
      error: string | null;
    };
