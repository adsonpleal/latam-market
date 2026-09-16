/** Formatação para exibição. Números crus ficam para o CSV. */

const NUM = new Intl.NumberFormat("pt-BR");

/**
 * Zeny. `null` vira travessão, nunca zero.
 *
 * Um item sem loja vendendo não tem preço, e mostrar 0 leria como "não vale nada" em vez
 * de "não sabemos".
 */
export const zeny = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${NUM.format(Math.round(n))}z`;

export const count = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : NUM.format(n);

/**
 * Concorda o texto com o número: "1 alerta ligado", "2 alertas ligados".
 *
 * Recebe as duas formas por inteiro, e não um sufixo, porque em português a concordância
 * pega mais de uma palavra — "alerta ligado" vira "alertas ligados", com dois plurais. Um
 * `+"s"` no fim resolveria só metade, e é como se chega ao "(s)" que ninguém quer ler.
 */
export const plural = (n: number, um: string, muitos: string): string =>
  `${NUM.format(n)} ${n === 1 ? um : muitos}`;

/**
 * Junta uma lista em prosa: vírgula entre os itens e "e" antes do último.
 *
 * Um `join(" e ")` só passa por português enquanto a lista tem dois itens.
 */
export function enumerate(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Epoch em SEGUNDOS — é o que o replay grava em `recordedAt`. */
export const dateTime = (epochSec: number): string =>
  new Date(epochSec * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** Só a hora: "14:32". O relógio das pausas e do selo da conexão. */
export const time = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** O mesmo que `ago`, para quem já tem milissegundos (o relógio do navegador). */
export const agoMs = (epochMs: number | null): string => ago(epochMs === null ? null : epochMs / 1000);

/** "há 12 min", "há 3 h", "há 2 dias". */
export function ago(epochSec: number | null): string {
  if (epochSec === null) return "sem data";
  const min = Math.max(0, Math.round(Date.now() / 1000 - epochSec) / 60);
  if (min < 1) return "agora";
  if (min < 60) return `há ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `há ${Math.round(h)} h`;
  const d = Math.round(h / 24);
  return `há ${d} ${d === 1 ? "dia" : "dias"}`;
}

/** Uma duração em milissegundos: "45 s", "3 min", "1 h 5 min". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`;
}

/** `yyyymmdd`, para nome de arquivo. */
export function stamp(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Nome de item com refino e slots, do jeito que o jogo escreve. */
export function itemLabel(name: string, refine: number, slots: number | null): string {
  const prefix = refine > 0 ? `+${refine} ` : "";
  const suffix = slots && slots > 0 ? ` [${slots}]` : "";
  return `${prefix}${name}${suffix}`;
}
