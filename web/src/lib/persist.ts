/**
 * O que a aba Favoritos guarda no navegador, e como ler isso sem confiar.
 *
 * Nada disto vai para o servidor: os alvos de preço e o tópico do ntfy são da pessoa, e
 * mantê-los aqui é o que faz o EC2 não ter estado de usuário nenhum. O preço é que tudo
 * pode chegar corrompido — outra versão do app, uma edição à mão no devtools, um
 * `localStorage` cheio pela metade. Por isso os parsers deste arquivo **nunca lançam** e
 * descartam entrada ruim *item por item*: um registro estragado não pode apagar a lista
 * inteira.
 *
 * As chaves seguem `latam-market:<coisa>`, como as duas que já existiam
 * (`latam-market:server` em `api/client.ts` e `latam-market:columns` em `ItemsTable.tsx`).
 */

import { SERVERS, type Server } from "../api/client.js";
import type { Freshness, ItemPrice } from "../api/types.js";

export const FAVORITES_KEY = "latam-market:favorites";
export const ALERTS_KEY = "latam-market:alerts";
export const ALERTS_CONFIG_KEY = "latam-market:alerts-config";
export const ALERTS_LEASE_KEY = "latam-market:alerts-lease";
export const FAVORITES_COLUMNS_KEY = "latam-market:columns-favorites";
export const SEARCH_COLUMNS_KEY = "latam-market:columns-mercado";
export const PRICES_SNAPSHOT_KEY = "latam-market:prices-snapshot";

/**
 * Identidade desta aba, para o lease dos alertas.
 *
 * `sessionStorage` e não uma variável: ele é por aba E sobrevive ao recarregamento. Com um
 * id novo a cada carga, recarregar a página faria a aba perder o próprio lease — que
 * continua fresco em nome do id anterior — e ficar sem checar nada por mais de uma volta.
 */
const TAB_ID_KEY = "latam-market:tab-id";

export function tabId(): string {
  try {
    const saved = sessionStorage.getItem(TAB_ID_KEY);
    if (saved !== null && saved !== "") return saved;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, fresh);
    return fresh;
  } catch {
    // Sem sessionStorage não há como manter identidade entre cargas. O lease passa a ser
    // renovado por um id novo a cada carga, o que no pior caso significa uma aba a mais
    // checando — melhor que nenhuma.
    return crypto.randomUUID();
  }
}

/** `down` = quero comprar, avisa quando cair. `up` = quero vender, avisa quando subir. */
export type Direction = "down" | "up";

export interface Alert {
  enabled: boolean;
  direction: Direction;
  /** Em zeny. Sempre > 0. */
  targetPrice: number;
  /**
   * Último preço que já gerou aviso, ou `null` quando o alerta está armado.
   *
   * É o que evita repetir a mesma notificação a cada ciclo. Vive no `localStorage` e não
   * na memória de propósito: o laço precisa ser idempotente, porque o navegador pode
   * congelar a aba e recarregá-la a qualquer momento.
   */
  lastAlertedPrice: number | null;
}

/**
 * Alertas por `servidor:item` — a chave composta é deliberada.
 *
 * FREYA e NIDHOGG cotam o mesmo id por preços muito diferentes, então um alvo em zeny só
 * significa algo junto do servidor. É o mesmo cuidado que `core/movers.ts` toma na chave da
 * sua memo. A lista de favoritos, ao contrário, é compartilhada: o item é o mesmo objeto do
 * jogo nos dois mercados.
 */
export type Alerts = Record<string, Alert>;

/** Sem intervalo de checagem de propósito: quem decide a cadência é `lib/schedule.ts`. */
export interface AlertsConfig {
  ntfyEnabled: boolean;
  ntfyTopic: string;
}

/** Qual aba está tocando o laço. Ver `lib/alertLease.ts`. */
export interface AlertsLease {
  tabId: string;
  /** Epoch em MILISSEGUNDOS: é comparado com `Date.now()`, não com dado do backend. */
  at: number;
}

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  ntfyEnabled: false,
  ntfyTopic: "",
};

const isServer = (value: string): value is Server => SERVERS.some((s) => s === value);

/** `FREYA:501`. */
export const alertKey = (server: Server, itemId: number): string => `${server}:${itemId}`;

export function parseAlertKey(key: string): { server: Server; itemId: number } | null {
  const parts = key.split(":");
  if (parts.length !== 2) return null;
  const [server, raw] = parts as [string, string];
  if (!isServer(server)) return null;
  const itemId = Number(raw);
  if (!Number.isInteger(itemId) || itemId <= 0) return null;
  return { server, itemId };
}

const isItemId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** Texto digitado → id de item, ou `null`. O campo "colar um ID" é o único que precisa. */
export const parseItemId = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return isItemId(n) ? n : null;
};

/**
 * Lista de favoritos. `null` significa "não deu, use o padrão".
 *
 * Deduplica porque a lista é um conjunto disfarçado de array (JSON não tem `Set`), e um
 * id repetido apareceria duas vezes na tabela.
 */
export function parseFavorites(raw: string | null): number[] | null {
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return null;
  return [...new Set(parsed.filter(isItemId))];
}

export function parseAlerts(raw: string | null): Alerts | null {
  const parsed = safeJson(raw);
  if (!isRecord(parsed)) return null;

  const out: Alerts = {};
  for (const [key, value] of Object.entries(parsed)) {
    // Chave estranha é descartada, não consertada: adivinhar a que servidor um alerta
    // pertence poderia avaliá-lo contra o mercado errado.
    if (parseAlertKey(key) === null || !isRecord(value)) continue;

    const { enabled, direction, targetPrice, lastAlertedPrice } = value;
    if (typeof targetPrice !== "number" || !Number.isFinite(targetPrice) || targetPrice <= 0) {
      continue;
    }
    out[key] = {
      enabled: enabled === true,
      direction: direction === "up" ? "up" : "down",
      targetPrice: Math.round(targetPrice),
      lastAlertedPrice:
        typeof lastAlertedPrice === "number" && Number.isFinite(lastAlertedPrice)
          ? lastAlertedPrice
          : null,
    };
  }
  return out;
}

/**
 * O último retrato de preços que o laço leu.
 *
 * Guardado porque só UMA aba roda o laço (ver `lib/alertLease.ts`). Sem isto, a segunda aba
 * mostraria uma tabela de travessões para sempre, e recarregar a página deixaria a tela
 * vazia até o próximo ciclo — que pode estar a meia hora de distância.
 *
 * É cache de exibição, não fonte de verdade: quem decide alerta é sempre a resposta fresca
 * do ciclo. Daí guardar o `at`, para a tela poder dizer de quando é.
 */
export interface PricesSnapshot {
  at: number;
  prices: ItemPrice[];
  missing: number[];
  freshness: Freshness | null;
  nextTradingAt: number | null;
}

export function parsePricesSnapshot(raw: string | null): PricesSnapshot | null {
  const parsed = safeJson(raw);
  if (!isRecord(parsed)) return null;
  const { at, prices, missing, freshness, nextTradingAt } = parsed;
  if (typeof at !== "number" || !Array.isArray(prices)) return null;
  return {
    at,
    // Entrada sem id utilizável não serve para casar com favorito nenhum.
    prices: prices.filter((p): p is ItemPrice => isRecord(p) && isItemId(p["itemId"])),
    missing: Array.isArray(missing) ? missing.filter(isItemId) : [],
    freshness: isRecord(freshness) ? (freshness as unknown as Freshness) : null,
    nextTradingAt:
      typeof nextTradingAt === "number" && Number.isFinite(nextTradingAt) ? nextTradingAt : null,
  };
}

/**
 * Preferência de colunas de uma tabela: `{ [id]: boolean }`.
 *
 * Descarta chave cujo valor não é booleano em vez de confiar num `as`. Um id que não existe
 * mais é inofensivo — a TanStack ignora o que não casa com nenhuma coluna.
 */
export function parseVisibility(raw: string | null): Record<string, boolean> | null {
  const parsed = safeJson(raw);
  if (!isRecord(parsed)) return null;
  const out: Record<string, boolean> = {};
  for (const [id, visible] of Object.entries(parsed)) {
    if (typeof visible === "boolean") out[id] = visible;
  }
  return out;
}

export function parseAlertsConfig(raw: string | null): AlertsConfig | null {
  const parsed = safeJson(raw);
  if (!isRecord(parsed)) return null;

  // Um `intervalSec` de uma versão anterior é simplesmente ignorado.
  const { ntfyEnabled, ntfyTopic } = parsed;
  return {
    ntfyEnabled: ntfyEnabled === true,
    ntfyTopic: typeof ntfyTopic === "string" ? ntfyTopic : "",
  };
}

function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
