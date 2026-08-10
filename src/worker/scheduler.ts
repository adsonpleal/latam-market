/**
 * Agendador do crawl, dentro do próprio processo.
 *
 * Um timer do systemd seria o reflexo natural, mas seria outro processo coletando sem
 * saber da existência do primeiro — e ainda precisaria de um canal para avisar que o cache
 * deve ser reconstruído. Aqui os dois problemas somem: o agendador sabe se já há uma coleta
 * rodando e reconstrói o cache ao receber o resultado.
 *
 * A segurança contra queda vem do `Restart=always` da unit, não do agendador.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

import { refreshCache } from "../store/cache.js";
import type { SweepResult } from "../store/retention.js";
import { SERVERS, type Server } from "../core/servers.js";
import type { Dataset } from "../core/datasets.js";
import { config } from "../server/config.js";
import type { CrawlJob, CrawlOutcome } from "./crawl-worker.js";

/**
 * Resolve o caminho de um worker.
 *
 * `new Worker()` recebe um CAMINHO de arquivo, não um especificador de import: ninguém
 * reescreve `.js` para `.ts` por baixo. Em dev, rodando por tsx, o arquivo ao lado é
 * `.ts`; no bundle empacotado é `.js`. A extensão deste módulo diz em qual dos dois
 * estamos.
 */
function workerPath(name: string): string {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return fileURLToPath(new URL(`./${name}${ext}`, import.meta.url));
}

export interface Scheduler {
  stop(): void;
  /** Dispara uma coleta fora de hora. Ignorada se já houver uma rodando. */
  trigger(dataset: Dataset, server: Server): boolean;
  running(): { dataset: Dataset; server: Server } | null;
  /**
   * Quando o próximo disparo está agendado, em epoch de segundos.
   *
   * É o que a API conta ao navegador para ele dormir até a coleta pousar em vez de
   * perguntar em intervalo fixo. Mora aqui, e não num módulo à parte, porque quem sabe a
   * hora é este agendador — e a hora só existe depois do jitter de ±5min.
   */
  nextRun(dataset: Dataset, server: Server): number | null;
}

/** Jitter para duas instâncias (ou dois reboots) não baterem no site no mesmo minuto. */
const jitterMs = () => Math.round((Math.random() - 0.5) * 10 * 60_000);

export function startScheduler(db: DatabaseSync): Scheduler {
  const timers: Array<{ handle: NodeJS.Timeout | null }> = [];
  const nextRuns = new Map<string, number>();
  let active: { dataset: Dataset; server: Server } | null = null;
  let stopped = false;

  function runCrawl(dataset: Dataset, server: Server): boolean {
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

    const job: CrawlJob = { dataset, server };

    const worker = new Worker(workerPath("crawl-worker"), {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: 192 },
    });

    worker.on("message", (outcome: CrawlOutcome) => {
      if (outcome.error) {
        console.error(`[crawl] ${dataset}/${server} falhou: ${outcome.error}`);
        return;
      }
      const secs = (outcome.durationMs / 1000).toFixed(0);
      console.log(
        `[crawl] ${dataset}/${server}: ${outcome.rows} linhas em ${secs}s ` +
          `(snapshot ${outcome.snapshotId}, ${outcome.failures} falha(s))`,
      );
      // Publicação atômica: monta o índice novo inteiro e troca a referência.
      const cache = refreshCache(db, server);
      console.log(`[crawl] cache: ${cache.prices.size} com preço, ${cache.listings.size} com oferta`);
    });

    worker.on("error", (err) => console.error(`[crawl] worker de ${dataset}/${server} quebrou:`, err));
    worker.on("exit", () => {
      active = null;
    });

    return true;
  }

  function runRetention(): void {
    const worker = new Worker(workerPath("retention-worker"), {
      resourceLimits: { maxOldGenerationSizeMb: 96 },
    });
    worker.on("message", (result: SweepResult) => {
      if (result.listingsDeleted > 0 || result.statsDeleted > 0) {
        console.log(
          `[retenção] ${result.listingsDeleted} anúncios, ${result.statsDeleted} stats, ` +
            `${result.snapshotsDeleted} coleta(s) removida(s)`,
        );
      }
    });
    worker.on("error", (err) => console.error("[retenção] worker quebrou:", err));
  }

  /**
   * Agenda repetições.
   *
   * Guarda UM timer por agendamento e o sobrescreve a cada disparo. A versão anterior
   * empilhava um `Timeout` novo por tique sem nunca remover o que já disparou — num
   * processo feito para rodar por meses, são dezenas de milhares de objetos mortos
   * retidos junto com suas closures.
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

    const schedule = (delay: number) => {
      const wait = Math.max(delay, 1_000);
      slot.handle = setTimeout(() => {
        if (stopped) return;
        fn();
        schedule(minutes * 60_000 + jitterMs());
      }, wait);
      slot.handle.unref();
      // Depois do `setTimeout`, com o atraso já clampado: é o número que o timer vai
      // realmente cumprir, e não o que foi pedido.
      onSchedule?.(Date.now() + wait);
    };
    schedule(firstDelayMs);
  }

  // A primeira coleta não sai junto com o boot: um restart em laço (deploy quebrado,
  // OOM) viraria uma rajada contra o site.
  // Um agendamento por (dataset, servidor). Os primeiros disparos são espaçados de
  // propósito: com os dois servidores na mesma cadência, deixá-los coincidir faria o
  // segundo bater no `active !== null` e ser pulado inteiro, de hora em hora, para
  // sempre. O deslocamento é metade da janela — o mais longe possível um do outro.
  const schedules: Array<[Dataset, number, number]> = [
    ["trading", config.crawl.tradingEveryMin, 2],
    ["market-price", config.crawl.marketEveryMin, 12],
  ];
  for (const [dataset, everyMin, firstMin] of schedules) {
    SERVERS.forEach((server, i) => {
      const offset = (everyMin / SERVERS.length) * i;
      // Guardar a hora do próximo disparo é o que permite à API contar ao navegador
      // quando voltar. Ver `nextRun` na interface acima.
      every(
        everyMin,
        () => runCrawl(dataset, server),
        (firstMin + offset) * 60_000,
        (atMs) => nextRuns.set(`${dataset}:${server}`, Math.round(atMs / 1000)),
      );
    });
  }

  // Limpeza de hora em hora. A retenção é por contagem de snapshots e por idade, então
  // rodar com frequência não apaga nada a mais — só evita acumular até virar um
  // DELETE gigante que trava o banco.
  //
  // Vai para uma worker thread pelo mesmo motivo do crawl: medida em ~1,16 s no estado
  // de regime, e `node:sqlite` é síncrono. Na thread principal isso seria a API parada
  // por mais de um segundo, toda hora.
  every(60, runRetention, 30 * 60_000);

  console.log(
    `[crawl] agendado: trading a cada ${config.crawl.tradingEveryMin}min, ` +
      `market-price a cada ${config.crawl.marketEveryMin}min, ${SERVERS.join(" e ")}`,
  );

  return {
    nextRun: (dataset, server) => nextRuns.get(`${dataset}:${server}`) ?? null,

    stop() {
      stopped = true;
      for (const slot of timers) if (slot.handle) clearTimeout(slot.handle);
    },
    trigger: runCrawl,
    running: () => active,
  };
}
