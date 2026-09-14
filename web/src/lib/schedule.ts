/**
 * Quanto esperar até a próxima checagem.
 *
 * É a resposta para "de quanto em quanto tempo checar?" e ela não é uma preferência: os
 * preços de loja só mudam quando a coleta roda, a cada 10 minutos. Perguntar de minuto em
 * minuto devolveria bytes idênticos 9 vezes em 10, e trinta pessoas com a aba aberta somariam
 * quase duas mil requisições por hora contra um servidor pequeno.
 *
 * Houve um campo de intervalo na interface, e ele foi removido: era escolha sem informação
 * nenhuma, e qualquer número que a pessoa colocasse ou desperdiçava requisição ou atrasava
 * o aviso. Quem sabe a cadência é o servidor, que manda `nextTradingAt` em toda resposta de
 * `/prices` — a hora em que o dado da próxima coleta deve estar PUBLICADO (início agendado
 * mais a duração da última coleta), ou a estimativa "última coleta + a cadência" quando não
 * há agendador. A aba dorme até logo depois disso: **uma checagem por coleta**.
 */

/** Piso do navegador: aba em segundo plano tem o timer limitado a ~1 tique/min. */
const MIN_WAIT_MS = 60 * 1_000;

/**
 * Teto de segurança.
 *
 * Um `nextTradingAt` muito à frente (relógio errado dos dois lados, agendador travado) não
 * pode parar os alertas por horas. A coleta é a cada 10 minutos, com até 10% de variação e
 * mais o tempo de ela rodar: 12 minutos cobre uma janela, e no pior caso perde-se uma
 * coleta, não o dia.
 */
const MAX_WAIT_MS = 12 * 60 * 1_000;

/**
 * Espera para quando o servidor não sabe dizer nada — nunca houve coleta.
 *
 * É o único caso que sobrou sem informação, e é transitório (banco vazio, primeiro boot).
 */
const UNKNOWN_WAIT_MS = 5 * 60 * 1_000;

/**
 * Espera curta para quando a coleta ainda não pousou.
 *
 * Acontece quando ela atrasou, foi pulada por outra em andamento, ou quando a estimativa
 * errou para menos. Tentar de novo em um minuto custa uma ou duas requisições minúsculas;
 * esperar a janela inteira atrasaria o aviso em 10 minutos. Um minuto é também o piso do
 * navegador para aba em segundo plano.
 */
const RETRY_WAIT_MS = 60 * 1_000;

/**
 * Espalha as abas do mundo para elas não baterem todas no mesmo segundo após a coleta.
 *
 * Curto: o `nextTradingAt` já traz a folga de a coleta terminar, e cada segundo aqui é
 * atraso no aviso numa janela de 10 minutos.
 */
const JITTER_MS = 30 * 1_000;

export interface NextWaitInput {
  /** Epoch em SEGUNDOS, do backend. `null` só quando nunca houve coleta. */
  nextTradingAt: number | null;
  /** `true` quando este ciclo leu o mesmo retrato do anterior — a coleta não pousou. */
  stale: boolean;
  nowMs: number;
  /** 0..1. Recebido por parâmetro para o teste ser determinístico. */
  jitter: number;
}

export function nextWaitMs({ nextTradingAt, stale, nowMs, jitter }: NextWaitInput): number {
  const clamp = (ms: number): number => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, ms));

  if (nextTradingAt === null) return UNKNOWN_WAIT_MS;

  const target = nextTradingAt * 1_000 + jitter * JITTER_MS;

  // A coleta já deveria ter saído e o dado não mudou: tenta de novo daqui a pouco em vez
  // de dormir a janela inteira.
  if (target <= nowMs) return RETRY_WAIT_MS;
  if (stale) return clamp(Math.min(target - nowMs, RETRY_WAIT_MS));

  return clamp(target - nowMs);
}

/** Já passou da hora em que a coleta era esperada? Usado na volta para a aba. */
export const collectionDue = (nextTradingAt: number | null, nowMs: number): boolean =>
  nextTradingAt === null || nextTradingAt * 1_000 <= nowMs;
