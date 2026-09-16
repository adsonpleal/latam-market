/**
 * Quanto se pode pedir ao site, e quando.
 *
 * Toda consulta sai do computador da pessoa, com o IP dela. O site limita requisições por
 * IP e, quando bloqueia, bloqueia também a navegação normal dela no mercado. Então errar
 * aqui para cima não custa só o alerta: custa o site. É o arquivo que carrega a promessa
 * de ser razoável.
 *
 * Os números vêm do que o coletor mediu enquanto existiu (documentação e calibrações do
 * repositório dele, de julho a setembro de 2026):
 *
 *  - o 429 é por IP e por tipo de busca, vem sem `Retry-After`, e dura **mais de 15
 *    minutos** — nunca foi medido o fim;
 *  - disparou com ~50 requisições acumuladas nas três vezes medidas, a 24, 30 e 42 por
 *    minuto. Ou seja: se comporta como uma **janela**, não como uma taxa;
 *  - 20 por minuto, por 30 requisições, passou limpo;
 *  - o coletor conviveu bem com uma requisição por vez por IP, espaçadas de 3 s;
 *  - repetir 60 s depois de um 429 já rendeu um bloqueio de 12 horas.
 *
 * Daí as duas regras: **uma requisição por vez, com 5 s entre inícios**, e **no máximo 30
 * a cada 15 minutos** — cerca de 60% do ponto em que o site bloqueou. A navegação da
 * própria pessoa no mercado gasta da mesma cota, e ela não passa por aqui; a folga é para
 * isso também.
 *
 * Funções puras sobre a lista de inícios de requisição, para serem testadas sem relógio. A
 * lista vive no `localStorage` (ver `persist.ts`), compartilhada entre as abas: recarregar a
 * página não pode zerar a conta.
 */

export const SPACING_MS = 5_000;
export const WINDOW_MS = 15 * 60_000;
export const WINDOW_CAP = 30;

/** Opções do seletor de intervalo, em minutos. */
export const INTERVAL_OPTIONS = [5, 10, 15, 30, 60] as const;
export const DEFAULT_INTERVAL_MIN = 10;

/** Só os inícios que ainda contam para a janela. Relógio que voltou conta como recente. */
export const prune = (starts: number[], now: number): number[] =>
  starts.filter((t) => now - t < WINDOW_MS);

/**
 * O primeiro instante em que a próxima requisição pode começar.
 *
 * Nunca descarta: quem chega com a cota cheia espera a mais antiga sair da janela. Um
 * favorito que fica para depois é melhor que um bloqueio que para todos.
 */
export function nextSlot(starts: number[], now: number): number {
  const recent = prune(starts, now).sort((a, b) => a - b);
  let at = now;
  const last = recent[recent.length - 1];
  if (last !== undefined) at = Math.max(at, last + SPACING_MS);
  if (recent.length >= WINDOW_CAP) {
    // A requisição que precisa sair da janela para abrir uma vaga.
    at = Math.max(at, recent[recent.length - WINDOW_CAP]! + WINDOW_MS);
  }
  return at;
}

/** Quantas requisições da janela já foram gastas. */
export const usedInWindow = (starts: number[], now: number): number => prune(starts, now).length;

/**
 * Quantas requisições por ciclo cabem num intervalo sem a cota precisar segurar ninguém.
 *
 * Em requisições, e não em itens: favoritos de nome parecido saem numa busca só (ver
 * `plan.ts`), então a lista pode ter bem mais itens que isto.
 *
 * A conta é por janela, e não por taxa média: uma janela de 15 minutos pode pegar o fim de
 * um ciclo e o começo de outro. A 10 minutos, dois ciclos cabem numa janela, então cada um
 * pode ter metade da cota. "Proporcional ao intervalo" daria 20 aí, e 40 requisições
 * em 15 minutos — o teste de simulação existe por causa desse erro.
 *
 * Acima da sugestão nada quebra: `nextSlot` segura as requisições e o ciclo só demora
 * mais. É o risco que sobe, porque a cota fica sem folga para a navegação da pessoa.
 */
export function suggestedMaxRequests(intervalMin: number): number {
  const cyclesPerWindow = Math.floor(WINDOW_MS / (intervalMin * 60_000)) + 1;
  return Math.max(1, Math.floor(WINDOW_CAP / cyclesPerWindow));
}

/**
 * Quanto um ciclo de `items` consultas leva, partindo de uma cota vazia.
 *
 * Simulado com a mesma `nextSlot`, e não com uma fórmula à parte: a estimativa na tela não
 * pode discordar do que o laço faz.
 */
export function estimateCycleMs(items: number): number {
  const starts: number[] = [];
  let now = 0;
  for (let i = 0; i < items; i++) {
    now = nextSlot(starts, now);
    starts.push(now);
  }
  return now;
}
