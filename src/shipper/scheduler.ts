/**
 * Agendador do crawl, dentro do próprio processo.
 *
 * Um timer do systemd seria o reflexo natural, mas seria outro processo coletando sem saber
 * da existência do primeiro. Aqui esse problema some: o agendador sabe se já há uma coleta
 * rodando.
 *
 * A segurança contra queda vem do `Restart=always` da unit, não do agendador.
 *
 * Duas coisas saíram na migração para a Cloudflare, e as duas pelo mesmo motivo — não há
 * mais banco local:
 *
 *  - **as worker threads.** Existiam porque `node:sqlite` é síncrono e os ~20 mil inserts
 *    de uma coleta travariam a thread que servia a API. Não há API neste processo, e o
 *    destino das linhas é um POST.
 *  - **a retenção.** Virou Cron Trigger no Worker, ao lado do banco que ela limpa.
 */

import type { Dataset } from "../core/datasets.js";
import { SERVERS, type Server } from "../core/servers.js";
import { config, tradingEveryMinFor } from "../config.js";
import { runCrawl, type CrawlOutcome } from "./crawl.js";
import type { ShipTarget } from "./ship.js";

export interface Scheduler {
  stop(): void;
  /** Dispara uma coleta fora de hora. Ignorada se já houver uma rodando. */
  trigger(dataset: Dataset, server: Server): boolean;
  running(): { dataset: Dataset; server: Server } | null;
  /** Quando o próximo disparo está agendado, em epoch de segundos. */
  nextRun(dataset: Dataset, server: Server): number | null;
}

/**
 * Jitter para duas instâncias (ou dois reboots) não baterem no site no mesmo minuto.
 *
 * PROPORCIONAL ao intervalo, e não ±5min fixos como era. Os ±5min nasceram com a cadência
 * de 30min, onde são 17% da janela — folga suficiente para espalhar, pequena o bastante
 * para não desarrumar a ordem. A mesma constante numa cadência de 10min viraria ±50%: o
 * intervalo real oscilaria entre 5 e 15 minutos, e os dois servidores — que o agendador
 * afasta de meia janela justamente para não se cruzarem — passariam a se cruzar toda hora.
 * Como só uma coleta roda por vez, cruzar significa a segunda ser PULADA: menos dado, não
 * mais, que é o oposto de por que se mexe na cadência.
 *
 * ±10% mantém a proporção em qualquer cadência. Com 30min são ±3min; com 15, ±1,5min.
 */
const jitterMs = (everyMin: number): number =>
  Math.round((Math.random() - 0.5) * 0.2 * everyMin * 60_000);

export function startScheduler(target: ShipTarget): Scheduler {
  const timers: Array<{ handle: NodeJS.Timeout | null }> = [];
  const nextRuns = new Map<string, number>();
  let active: { dataset: Dataset; server: Server } | null = null;
  let stopped = false;

  const key = (dataset: Dataset, server: Server): string => `${dataset}:${server}`;

  function start(dataset: Dataset, server: Server): boolean {
    // Skip duro: cada coleta sobe o seu próprio coletor, e dois coletores ao mesmo tempo
    // não sabem um do outro — dividiriam a paciência que o coletor administra sozinho.
    // Vale entre servidores também: o que se divide é a saída de rede, não o mercado que
    // está sendo lido.
    if (active !== null) {
      console.log(
        `[crawl] ${dataset}/${server} pulado — ${active.dataset}/${active.server} ainda rodando`,
      );
      return false;
    }
    active = { dataset, server };

    void runCrawl(target, dataset, server, () => nextRuns.get(key(dataset, server)) ?? 0)
      .then((outcome: CrawlOutcome) => {
        if (outcome.error) {
          console.error(`[crawl] ${dataset}/${server} falhou: ${outcome.error}`);
          return;
        }
        const secs = (outcome.durationMs / 1000).toFixed(0);
        console.log(
          `[crawl] ${dataset}/${server}: ${outcome.rows} linhas em ${secs}s ` +
            `(snapshot ${outcome.snapshotId}, ${outcome.failures} falha(s)` +
            `${outcome.grouped > 0 ? `, ${outcome.grouped} agrupada(s)` : ""})`,
        );
      })
      .catch((err: unknown) => console.error(`[crawl] ${dataset}/${server} quebrou:`, err))
      .finally(() => {
        active = null;
      });

    return true;
  }

  /**
   * Agenda repetições.
   *
   * Guarda UM timer por agendamento e o sobrescreve a cada disparo. A versão anterior
   * empilhava um `Timeout` novo por tique sem nunca remover o que já disparou — num
   * processo feito para rodar por meses, são dezenas de milhares de objetos mortos retidos
   * junto com suas closures.
   */
  function every(
    minutes: number,
    fn: () => void,
    firstDelayMs: number,
    /** Recebe o instante do próximo disparo, sempre que ele é (re)agendado. */
    onSchedule?: (atMs: number) => void,
  ): void {
    const slot: { handle: NodeJS.Timeout | null } = { handle: null };
    timers.push(slot);

    const schedule = (delay: number): void => {
      const wait = Math.max(delay, 1_000);
      slot.handle = setTimeout(() => {
        if (stopped) return;
        // Reagenda ANTES de disparar: o envio precisa saber a hora do próximo disparo
        // para carimbá-la no cabeçalho, e é dela que sai o `nextTradingAt` do navegador.
        schedule(minutes * 60_000 + jitterMs(minutes));
        fn();
      }, wait);
      // ⚠ SEM `unref()`. Estes timers são a ÚNICA coisa que segura o event loop deste
      // processo: não há mais servidor HTTP, banco nem thread — foi tudo para o Worker.
      // Com `unref()` o Node não vê nada pendente, `startScheduler` retorna e o processo
      // sai limpo (código 0) segundos depois do boot; o `Restart=always` da unit o traz de
      // volta e ele sai de novo, num laço que imprime "[crawl] agendado" a cada 5s e nunca
      // coleta nada. Herdado do serviço antigo, onde o listener segurava o loop e o
      // `unref` era o certo.
      onSchedule?.(Date.now() + wait);
    };
    schedule(firstDelayMs);
  }

  // A primeira coleta não sai junto com o boot: um restart em laço (deploy quebrado, OOM)
  // viraria uma rajada contra o site.
  //
  // Um agendamento por (dataset, servidor), e a cadência é POR SERVIDOR: FREYA pode rodar
  // de 15 em 15 enquanto NIDHOGG roda de hora em hora.
  //
  // Os primeiros disparos são espaçados de propósito — deixá-los coincidir faria o segundo
  // bater no `active !== null` e ser pulado inteiro, para sempre. O deslocamento é uma
  // fração da MENOR cadência do dataset, não da própria: com 15 e 60, espaçar por 60/2
  // colocaria NIDHOGG em cima do FREYA das 30. Dividir a menor janela é o que garante que
  // cada um comece no meio do intervalo do outro. Com cadências diferentes eles ainda vão
  // se cruzar de vez em quando — aí o `active` decide, que é para isso que ele existe.
  const schedules: Array<[Dataset, number]> = [
    ["trading", 2],
    ["market-price", 12],
  ];
  for (const [dataset, firstMin] of schedules) {
    const everyFor = (server: Server): number =>
      dataset === "trading" ? tradingEveryMinFor(server) : config.crawl.marketEveryMin;
    const smallest = Math.min(...SERVERS.map(everyFor));

    SERVERS.forEach((server, i) => {
      const offset = (smallest / SERVERS.length) * i;
      every(
        everyFor(server),
        () => start(dataset, server),
        (firstMin + offset) * 60_000,
        (atMs) => nextRuns.set(key(dataset, server), Math.round(atMs / 1000)),
      );
    });
  }

  console.log(
    "[crawl] agendado: " +
      SERVERS.map((s) => `${s} trading a cada ${tradingEveryMinFor(s)}min`).join(", ") +
      `, market-price a cada ${config.crawl.marketEveryMin}min`,
  );

  return {
    nextRun: (dataset, server) => nextRuns.get(key(dataset, server)) ?? null,

    stop() {
      stopped = true;
      for (const slot of timers) if (slot.handle) clearTimeout(slot.handle);
    },
    trigger: start,
    running: () => active,
  };
}
