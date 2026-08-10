/** Formatação para exibição. Números crus ficam para o CSV. */

const NUM = new Intl.NumberFormat("pt-BR");

/**
 * Zeny. `null` vira travessão, nunca zero.
 *
 * A regra do backend é "nada de inventar valor": um item sem oferta sai com preço
 * `null`. Mostrar 0 leria como "não vale nada" em vez de "não sabemos".
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

/** Epoch em SEGUNDOS (o backend inteiro usa segundos, não milissegundos). */
export const dateTime = (epochSec: number): string =>
  new Date(epochSec * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

export const date = (epochSec: number): string =>
  new Date(epochSec * 1000).toLocaleDateString("pt-BR");

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

/**
 * O contrário de `ago`: "em 12 min", "em 2 h".
 *
 * Um instante que já passou vira "a qualquer momento" em vez de um número negativo — é o
 * caso da coleta que atrasou, e "em -3 min" não diz nada a ninguém.
 */
export function upcoming(epochSec: number | null): string {
  if (epochSec === null) return "sem previsão";
  const min = (epochSec - Date.now() / 1000) / 60;
  if (min <= 1) return "a qualquer momento";
  if (min < 60) return `em ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `em ${Math.round(h)} h`;
  const d = Math.round(h / 24);
  return `em ${d} ${d === 1 ? "dia" : "dias"}`;
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
