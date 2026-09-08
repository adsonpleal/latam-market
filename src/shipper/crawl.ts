/**
 * Uma coleta, do coletor até o Worker.
 *
 * É o que sobrou de `worker/crawl-worker.ts` depois que o destino das linhas deixou de ser
 * um SQLite local. O que ficou é justamente o que era do crawl e não do banco: subir o
 * coletor, juntar as linhas, aplicar o corte de 20% e fechar o coletor.
 *
 * `onRows` agora só acumula em memória. Uma coleta de `trading` em FREYA são ~16 mil linhas
 * — alguns MB de objetos, irrelevante nesta máquina — e some com isso a razão de os lotes
 * existirem: eles eram para manter o write lock do SQLite em poucos milissegundos.
 */

import { randomUUID } from "node:crypto";

import { loadCollector } from "../collect/load.js";
import { config, tradingEveryMinFor } from "../config.js";
import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { Row } from "../store/rows.js";
import { ship, type ShipResult, type ShipTarget } from "./ship.js";

/** Acima disto a coleta não descreve o mercado, e publicá-la faria itens "sumirem". */
const MAX_FAILURE_RATIO = 0.2;

/**
 * Teto de tempo para fechar o coletor. Curto de propósito: se o `close()` também travar,
 * insistir nele reproduziria exatamente o problema que o prazo existe para cortar.
 */
const CLOSE_DEADLINE_MS = 30_000;

/**
 * Resolve com o valor da promessa, ou rejeita ao estourar o prazo.
 *
 * ⚠ O trabalho pendurado NÃO é cancelado — não há como cancelar uma promessa alheia. O que
 * isto garante é só que QUEM ESPERA volta a andar; a coleta abandonada segue viva até o
 * processo morrer. É o compromisso certo aqui: um agendador parado para sempre é pior que
 * uma coleta órfã, que o `Restart=always` limpa no próximo boot.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} passou de ${ms}ms sem terminar`)), ms);
      }),
    ]);
  } finally {
    // Sem isto o timer do caso feliz seguraria o event loop até o prazo inteiro passar —
    // e os timers deste processo são justamente o que o mantém vivo (ver scheduler.ts).
    if (timer) clearTimeout(timer);
  }
}

/**
 * Quanto uma coleta pode durar antes de ser dada como perdida.
 *
 * É o próprio período dela: uma coleta que passa do intervalo em que deveria rodar de novo
 * já falhou pela definição do agendador — a próxima seria pulada de qualquer jeito. Assim
 * o prazo acompanha sozinho uma mudança de cadência em vez de virar uma constante que
 * alguém esquece de ajustar.
 *
 * Por SERVIDOR, porque a cadência é: com FREYA de 15 em 15 e NIDHOGG de hora em hora, um
 * prazo global daria a um dos dois o período do outro — ou cortando coleta boa, ou
 * deixando uma travada segurar o agendador muito além do que ela tinha para viver.
 */
function deadlineFor(dataset: Dataset, server: Server): number {
  const minutes =
    dataset === "trading" ? tradingEveryMinFor(server) : config.crawl.marketEveryMin;
  return minutes * 60_000;
}

export interface CrawlOutcome {
  dataset: Dataset;
  server: Server;
  snapshotId: number | null;
  rows: number;
  failures: number;
  durationMs: number;
  error?: string;
}

export async function runCrawl(
  target: ShipTarget,
  dataset: Dataset,
  server: Server,
  nextRunAt: () => number,
  /**
   * Injetável só para o teste: em produção o prazo é o período da própria coleta, e o
   * teste não pode esperar 30 minutos para provar que o prazo existe.
   */
  deadlineMs = deadlineFor(dataset, server),
): Promise<CrawlOutcome> {
  const startedAt = Math.floor(Date.now() / 1000);
  const started = Date.now();
  const failed = (error: string): CrawlOutcome => ({
    dataset,
    server,
    snapshotId: null,
    rows: 0,
    failures: 0,
    durationMs: Date.now() - started,
    error,
  });

  const collector = await loadCollector();
  // Sem coletor não há o que coletar — e é um estado válido: a máquina pode ter só o
  // shipper instalado enquanto o coletor não é migrado.
  if (collector === null) return failed("nenhum coletor instalado");

  try {
    const rows: Row[] = [];
    // Com prazo, e não `await` puro. Uma `crawl()` que nunca resolve deixa esta promessa
    // pendente para sempre; o `active` do agendador só é limpo no `finally` de quem espera,
    // então TODA coleta seguinte é pulada com "ainda rodando" e o processo nunca mais
    // coleta nada — vivo, sem erro, e sem dado novo. Aconteceu: 34min parado com zero
    // socket aberto e 0,2% de CPU, pulando trading/NIDHOGG e market-price/FREYA em
    // sequência, e é o que explica um `tradingAgeMin` de 12 horas.
    const report = await withDeadline(
      collector.crawl({
        dataset,
        server,
        onRows: (batch) => {
          rows.push(...batch);
        },
      }),
      deadlineMs,
      `coleta ${dataset}/${server}`,
    );

    if (report.planned > 0 && report.failures / report.planned > MAX_FAILURE_RATIO) {
      throw new Error(
        `${report.failures} de ${report.planned} unidades falharam (>20%), descartando a coleta`,
      );
    }

    let shipped: ShipResult;
    try {
      shipped = await ship(target, {
        dataset,
        server,
        startedAt,
        // v4 (aleatório) e não v7: o id só precisa ser único, e um id com carimbo de tempo
        // publicaria a hora da coleta para quem interceptasse o cabeçalho.
        crawlId: randomUUID(),
        nextRunAt: nextRunAt(),
        rows,
      });
    } catch (err) {
      // A coleta deu certo; foi o envio que falhou. Distinguir importa: coletar de novo
      // custa minutos de rede contra o site, reenviar custa um POST — e o `crawlId` torna
      // o reenvio seguro. Por ora só reporta; a retentativa é assunto do agendador.
      return failed(`coleta ok, envio falhou: ${(err as Error).message}`);
    }

    return {
      dataset,
      server,
      snapshotId: shipped.snapshotId,
      rows: shipped.rows,
      failures: report.failures,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return failed((err as Error).message);
  } finally {
    // Também com prazo, e engolindo o erro: este `finally` roda no caminho de sucesso e no
    // de falha, e deixar o `close()` travar aqui recriaria o impasse um andar acima —
    // desta vez sem nem o prazo da coleta para cortar. Um coletor que não fecha vira
    // recurso vazado até o próximo boot, o que é o preço aceitável por manter o agendador
    // andando.
    try {
      await withDeadline(collector.close(), CLOSE_DEADLINE_MS, `close ${dataset}/${server}`);
    } catch (err) {
      console.error(`[crawl] ${dataset}/${server}: close falhou: ${(err as Error).message}`);
    }
  }
}
