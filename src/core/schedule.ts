/**
 * Quando esperar a próxima coleta de lojas, para contar a um cliente.
 *
 * Existe para o navegador poder dormir até a coleta pousar em vez de perguntar em
 * intervalo fixo. Sem isto o cliente teria de adivinhar a partir de `tradingAt + 30min` e
 * erraria por até cinco minutos: o agendador aplica um jitter de ±5min a cada tique
 * (`jitterMs` em `worker/scheduler.ts`).
 *
 * Só aritmética, sem estado: quem sabe a hora exata é o agendador, e ela chega aqui por
 * parâmetro. Uma versão anterior guardava um `Map` de módulo aqui para o agendador
 * escrever e a rota ler — o que fazia deste arquivo um mero correio entre duas camadas que
 * não podem se importar, e deixava a resposta da API dependente de estado global.
 */

/**
 * A próxima coleta, exata quando o agendador informa e estimada quando não.
 *
 * A estimativa vale a pena: errar por alguns minutos custa uma requisição a mais, e quem
 * consome já trata "passou da hora e o dado é o mesmo" como motivo para tentar de novo em
 * pouco tempo. `null` só quando nunca houve coleta — aí não há o que estimar.
 *
 * @param scheduled hora exata do agendador, ou `null` se não há agendador neste processo.
 */
export function nextTradingRun(
  scheduled: number | null,
  lastTradingAt: number | null,
  everyMinutes: number,
): number | null {
  if (scheduled !== null) return scheduled;
  if (lastTradingAt === null) return null;
  return lastTradingAt + everyMinutes * 60;
}
