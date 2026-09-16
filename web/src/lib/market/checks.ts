/**
 * Uma consulta ao site, do começo ao fim: a resposta da conexão vira o que se guarda de cada
 * item e o que a quarentena precisa saber.
 *
 * As duas saídas são separadas de propósito. `outcome` fala do SITE (recusou, bloqueou,
 * respondeu); `checks` falam dos ITENS. Um 429 não diz nada sobre o preço de item nenhum —
 * então não produz retrato, e cada linha continua mostrando a última consulta boa.
 *
 * Uma consulta pode cobrir vários itens (ver `plan.ts`): a página é lida uma vez e resumida
 * para cada um.
 */

import type { BridgeResponse } from "../../bridge/client.js";
import { finiteNumber, isRecord, parseServerItemKey } from "../persist.js";
import type { Server } from "../server.js";
import { SoftFailError, extractRows } from "./extract.js";
import type { Outcome } from "./quarantine.js";
import { summarize } from "./summarize.js";

/**
 *  - `ok`: há loja vendendo, e `min` é o menor preço.
 *  - `empty`: a busca respondeu inteira e nenhuma linha é deste item — ninguém vende.
 *  - `incomplete`: a página veio cortada e o item não apareceu nela. Não dá para dizer que
 *    ninguém vende.
 *  - `error`: a consulta não funcionou (rede, resposta sem a lista, status estranho).
 *  - `unsearchable`: o nome do item não vira busca que o site aceite.
 */
export type CheckStatus = "ok" | "empty" | "incomplete" | "error" | "unsearchable";

export interface MarketCheck {
  /** Epoch em ms. */
  at: number;
  status: CheckStatus;
  min: number | null;
  stores: number;
  units: number;
  seller: string | null;
  truncated: boolean;
  /** O que deu errado, em texto curto, quando `status` é `error`. */
  detail: string | null;
}

/**
 * Uma consulta sem preço nenhum: erro, ou nome que o site não aceita buscar.
 *
 * Fábrica em vez de objeto literal em cada lugar porque um campo novo em `MarketCheck`
 * precisa aparecer nos dois — aqui e em quem registra um item não consultável.
 */
export const barrenCheck = (status: CheckStatus, at: number, detail: string | null): MarketCheck => ({
  at,
  status,
  min: null,
  stores: 0,
  units: 0,
  seller: null,
  truncated: false,
  detail,
});

export function interpret(
  res: BridgeResponse,
  itemIds: readonly number[],
  now: number,
): { outcome: Outcome; checks: Map<number, MarketCheck> } {
  const all = (check: MarketCheck) => new Map(itemIds.map((id) => [id, check]));
  const failed = (detail: string) => all(barrenCheck("error", now, detail));

  if (res.status === 429) return { outcome: "blocked", checks: new Map() };
  // O desafio vem como 403 marcado. Um 403 sem a marca é o Cloudflare recusando de outro
  // jeito, e a saída para a pessoa é a mesma: abrir o site, ver o que ele pede.
  if (res.challenge || res.status === 403) return { outcome: "challenge", checks: new Map() };
  if (res.status === 0) return { outcome: "error", checks: failed(res.error ?? "falha de rede") };
  if (res.status !== 200) return { outcome: "error", checks: failed(`o site respondeu ${res.status}`) };

  let page: ReturnType<typeof extractRows>;
  try {
    page = extractRows(res.body);
  } catch (err) {
    if (err instanceof SoftFailError) {
      return { outcome: "soft", checks: failed("a página veio sem a lista de anúncios") };
    }
    throw err;
  }

  const checks = new Map<number, MarketCheck>();
  for (const id of itemIds) {
    const s = summarize(page.rows, page.totalCount, id);
    const status: CheckStatus = s.min !== null ? "ok" : s.truncated ? "incomplete" : "empty";
    checks.set(id, { at: now, status, ...s, detail: null });
  }
  return { outcome: "ok", checks };
}

/** Sem preço confiável para decidir alerta? `incomplete` e `error` não dizem nada. */
export const isConclusive = (check: MarketCheck): boolean =>
  check.status === "ok" || check.status === "empty";

/**
 * Os itens deste servidor cuja última consulta veio de página cortada.
 *
 * É a regra de quem vai sozinho no próximo planejamento (ver `plan.ts`): numa busca de grupo
 * eles já não couberam uma vez, e uma segunda tentativa agrupada só pagaria a requisição à toa.
 */
export function truncatedItems(checks: Record<string, MarketCheck>, server: Server): Set<number> {
  const out = new Set<number>();
  for (const [key, check] of Object.entries(checks)) {
    const parsed = parseServerItemKey(key);
    if (parsed?.server === server && (check.truncated || check.status === "incomplete")) out.add(parsed.itemId);
  }
  return out;
}

/** O retrato guardado só dos itens ainda favoritados — sem isto ele cresce para sempre. */
export function keepFavorites(
  checks: Record<string, MarketCheck>,
  favorites: ReadonlySet<number>,
): Record<string, MarketCheck> {
  const out: Record<string, MarketCheck> = {};
  for (const [key, check] of Object.entries(checks)) {
    const parsed = parseServerItemKey(key);
    if (parsed && favorites.has(parsed.itemId)) out[key] = check;
  }
  return out;
}

const STATUSES: readonly CheckStatus[] = ["ok", "empty", "incomplete", "error", "unsearchable"];

/** Lê as consultas guardadas sem confiar, descartando registro por registro. */
export function parseChecks(value: unknown): Record<string, MarketCheck> {
  if (!isRecord(value)) return {};
  const out: Record<string, MarketCheck> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const c = raw;
    const at = finiteNumber(c["at"]);
    const status = STATUSES.find((s) => s === c["status"]);
    if (at === null || status === undefined) continue;
    out[key] = {
      at,
      status,
      min: finiteNumber(c["min"]),
      stores: finiteNumber(c["stores"]) ?? 0,
      units: finiteNumber(c["units"]) ?? 0,
      seller: typeof c["seller"] === "string" ? c["seller"] : null,
      truncated: c["truncated"] === true,
      detail: typeof c["detail"] === "string" ? c["detail"] : null,
    };
  }
  return out;
}

/** Uma linha do registro de consultas que a tela mostra. */
export interface RequestLogEntry {
  at: number;
  /** O que foi buscado no site. */
  term: string;
  /** Quantos favoritos a busca cobria. */
  items: number;
  /** HTTP, ou 0 quando não houve resposta. */
  status: number;
  outcome: Outcome;
  ms: number;
}

export const LOG_SIZE = 30;

export function parseLog(value: unknown): RequestLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (e): e is RequestLogEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RequestLogEntry).at === "number" &&
        typeof (e as RequestLogEntry).term === "string" &&
        typeof (e as RequestLogEntry).items === "number" &&
        typeof (e as RequestLogEntry).status === "number",
    )
    .slice(0, LOG_SIZE);
}
