/**
 * O que a aba Favoritos guarda no navegador, e como ler isso sem confiar.
 *
 * Não há servidor para onde isto iria: os alvos de preço e o tópico do ntfy são da pessoa e
 * ficam neste navegador. O preço é que tudo
 * pode chegar corrompido — outra versão do app, uma edição à mão no devtools, um
 * `localStorage` cheio pela metade. Por isso os parsers deste arquivo **nunca lançam** e
 * descartam entrada ruim *item por item*: um registro estragado não pode apagar a lista
 * inteira.
 *
 * As chaves seguem `latam-market:<coisa>` e moram todas aqui, menos `latam-market:server`,
 * que `lib/server.ts` lê antes de qualquer componente montar.
 */

import { SERVERS, type Server } from "./server.js";
import { DEFAULT_INTERVAL_MIN, INTERVAL_OPTIONS } from "./market/budget.js";

export const FAVORITES_KEY = "latam-market:favorites";
export const ALERTS_KEY = "latam-market:alerts";
export const ALERTS_CONFIG_KEY = "latam-market:alerts-config";
export const ALERTS_LEASE_KEY = "latam-market:alerts-lease";
export const FAVORITES_COLUMNS_KEY = "latam-market:columns-favorites";
export const INVENTORY_COLUMNS_KEY = "latam-market:columns";
/** O que cada consulta ao site achou, por `servidor:item`. Ver `market/checks.ts`. */
export const MARKET_CHECKS_KEY = "latam-market:market-checks";
/**
 * A cota e a quarentena, juntas: as duas mudam na mesma requisição e são lidas juntas antes
 * da próxima. Ver `market/budget.ts` e `market/quarantine.ts`.
 */
export const MARKET_GUARD_KEY = "latam-market:market-guard";
/** As últimas consultas, para a tela mostrar o que saiu do computador da pessoa. */
export const MARKET_LOG_KEY = "latam-market:market-log";

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

/**
 * `down` = quero comprar, avisa quando cair. `up` = quero vender, avisa quando subir.
 * `available` = quero o item a qualquer preço, avisa quando alguém puser à venda.
 */
export type Direction = "down" | "up" | "available";

export interface Alert {
  enabled: boolean;
  direction: Direction;
  /**
   * Em zeny. Sempre > 0 em `down` e `up`.
   *
   * Em `available` não é lido, e pode ser 0 (alerta criado já nesse modo) ou o alvo de
   * antes — guardado para quem volta a um alerta de preço não ter de redigitá-lo.
   */
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
 * significa algo junto do servidor. A lista de favoritos, ao contrário, é compartilhada: o
 * item é o mesmo objeto do jogo nos dois mercados.
 */
export type Alerts = Record<string, Alert>;

export interface AlertsConfig {
  ntfyEnabled: boolean;
  ntfyTopic: string;
  /**
   * De quantos em quantos minutos checar os itens com alerta.
   *
   * Voltou a ser configurável quando a consulta passou a sair do IP da pessoa: é ela quem
   * paga a cota do site, então é ela quem escolhe entre frequência e quantidade de itens.
   */
  intervalMin: number;
}

/** Qual aba está tocando o laço. Ver `lib/alertLease.ts`. */
export interface AlertsLease {
  tabId: string;
  /** Epoch em MILISSEGUNDOS: é comparado com `Date.now()`. */
  at: number;
}

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = {
  ntfyEnabled: false,
  ntfyTopic: "",
  intervalMin: DEFAULT_INTERVAL_MIN,
};

const isServer = (value: string): value is Server => SERVERS.some((s) => s === value);

/**
 * `FREYA:501` — a identidade de um item NUM mercado.
 *
 * Chaveia os alertas e também as consultas guardadas (`MARKET_CHECKS_KEY`): as duas coisas
 * são por servidor pelo mesmo motivo, que FREYA e NIDHOGG cotam o mesmo id por preços muito
 * diferentes.
 */
export const serverItemKey = (server: Server, itemId: number): string => `${server}:${itemId}`;

export function parseServerItemKey(key: string): { server: Server; itemId: number } | null {
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
    if (parseServerItemKey(key) === null || !isRecord(value)) continue;

    const { enabled, direction, targetPrice, lastAlertedPrice } = value;
    const validTarget =
      typeof targetPrice === "number" && Number.isFinite(targetPrice) && targetPrice > 0;
    // Só o aviso de "à venda" dispensa alvo; nos de preço, sem alvo não há o que comparar.
    if (!validTarget && direction !== "available") continue;
    out[key] = {
      enabled: enabled === true,
      direction: direction === "up" || direction === "available" ? direction : "down",
      targetPrice: validTarget ? Math.round(targetPrice) : 0,
      lastAlertedPrice:
        typeof lastAlertedPrice === "number" && Number.isFinite(lastAlertedPrice)
          ? lastAlertedPrice
          : null,
    };
  }
  return out;
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

  // Um `intervalSec` de uma versão anterior é simplesmente ignorado. Um intervalo fora das
  // opções da tela volta ao padrão: um "1" escrito à mão no devtools não pode virar uma
  // consulta por minuto.
  const { ntfyEnabled, ntfyTopic, intervalMin } = parsed;
  return {
    ntfyEnabled: ntfyEnabled === true,
    ntfyTopic: typeof ntfyTopic === "string" ? ntfyTopic : "",
    intervalMin: INTERVAL_OPTIONS.find((o) => o === intervalMin) ?? DEFAULT_INTERVAL_MIN,
  };
}

export function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Número utilizável, ou `null`. `NaN` e `Infinity` contam como ausência. */
export const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
