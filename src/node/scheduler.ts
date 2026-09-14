/**
 * Agendador da coleta, dentro do processo que serve o site.
 *
 * Uma coleta por vez, sempre: duas ao mesmo tempo dividiriam a saída de rede que o coletor
 * administra sozinho. O que muda em relação ao shipper é o que acontece quando uma coleta
 * vence enquanto outra roda — antes era pulada; agora **espera na fila** (uma por
 * dataset/servidor) e começa assim que a atual terminar. Com os dois servidores a cada 10
 * minutos, pular significava perder metade das coletas de um deles sempre que o outro
 * atrasasse um pouco.
 */

import type { Dataset } from "../core/datasets.js";
import { SERVERS, type Server } from "../core/servers.js";
import { config, tradingEveryMinFor } from "../config.js";

export interface Scheduler {
  stop(): void;
  running(): { dataset: Dataset; server: Server } | null;
  /** Quando o próximo disparo está agendado, em epoch de segundos. */
  nextRun(dataset: Dataset, server: Server): number | null;
}

export type CrawlJob = (dataset: Dataset, server: Server, deadlineMs: number) => Promise<void>;

/** Jitter proporcional ao intervalo: ±10%, para duas instâncias não baterem no mesmo minuto. */
const jitterMs = (everyMin: number): number =>
  Math.round((Math.random() - 0.5) * 0.2 * everyMin * 60_000);

/**
 * Prazo de uma coleta.
 *
 * `trading`: o próprio período, com teto de 9 min — uma coleta que chega no período seguinte
 * já perdeu a vez, e com a publicação por item o que ela completou até ali está publicado.
 * `market-price`: 30 min, e não as 6 h do período; uma coleta pendurada não pode segurar a
 * fila dos anúncios por horas.
 */
export function deadlineFor(dataset: Dataset, server: Server): number {
  if (dataset === "market-price") return 30 * 60_000;
  return Math.min(tradingEveryMinFor(server), 9) * 60_000;
}

export function startScheduler(job: CrawlJob): Scheduler {
  // Um timer por agendamento, sobrescrito a cada disparo. Empilhar um novo por tique sem
  // tirar o que já disparou retém dezenas de milhares de objetos mortos num processo que
  // roda por meses.
  const timers: Array<{ handle: NodeJS.Timeout | null }> = [];
  const nextRuns = new Map<string, number>();
  const pending: Array<{ dataset: Dataset; server: Server }> = [];
  let active: { dataset: Dataset; server: Server } | null = null;
  let stopped = false;

  const key = (dataset: Dataset, server: Server): string => `${dataset}:${server}`;

  function pump(): void {
    if (stopped || active !== null) return;
    const next = pending.shift();
    if (!next) return;
    active = next;
    job(next.dataset, next.server, deadlineFor(next.dataset, next.server))
      .catch((err: unknown) => console.error(`[crawl] ${next.dataset}/${next.server} quebrou:`, err))
      .finally(() => {
        active = null;
        pump();
      });
  }

  function due(dataset: Dataset, server: Server): void {
    const k = key(dataset, server);
    if ((active && key(active.dataset, active.server) === k) || pending.some((p) => key(p.dataset, p.server) === k)) {
      console.log(`[crawl] ${dataset}/${server} já está na fila ou rodando — este disparo não soma outro`);
      return;
    }
    if (active) console.log(`[crawl] ${dataset}/${server} adiado — ${active.dataset}/${active.server} rodando`);
    pending.push({ dataset, server });
    pump();
  }

  function every(minutes: number, firstDelayMs: number, dataset: Dataset, server: Server): void {
    const slot: { handle: NodeJS.Timeout | null } = { handle: null };
    timers.push(slot);
    const schedule = (delay: number): void => {
      const wait = Math.max(delay, 1_000);
      // Sem `unref`: estes timers são o que mantém o agendador vivo.
      slot.handle = setTimeout(() => {
        if (stopped) return;
        schedule(minutes * 60_000 + jitterMs(minutes));
        due(dataset, server);
      }, wait);
      nextRuns.set(key(dataset, server), Math.round((Date.now() + wait) / 1000));
    };
    schedule(firstDelayMs);
  }

  const schedules: Array<[Dataset, number]> = [
    ["trading", 2],
    ["market-price", 12],
  ];
  for (const [dataset, firstMin] of schedules) {
    const everyFor = (server: Server): number =>
      dataset === "trading" ? tradingEveryMinFor(server) : config.crawl.marketEveryMin;
    const smallest = Math.min(...SERVERS.map(everyFor));
    // Os servidores afastados de meia janela, para não chegarem juntos.
    SERVERS.forEach((server, i) => {
      every(everyFor(server), (firstMin + (smallest / SERVERS.length) * i) * 60_000, dataset, server);
    });
  }

  console.log(
    "[crawl] agendado: " +
      SERVERS.map((s) => `${s} trading a cada ${tradingEveryMinFor(s)}min`).join(", ") +
      `, market-price a cada ${config.crawl.marketEveryMin}min`,
  );

  return {
    stop() {
      stopped = true;
      for (const slot of timers) if (slot.handle) clearTimeout(slot.handle);
      pending.length = 0;
    },
    running: () => active,
    nextRun: (dataset, server) => nextRuns.get(key(dataset, server)) ?? null,
  };
}
