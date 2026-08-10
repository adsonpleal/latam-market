/**
 * O crawl, rodando numa worker thread.
 *
 * Precisa ser thread separada porque `node:sqlite` é síncrono: os ~20 mil inserts de
 * uma coleta de `trading` na thread principal travariam a API por segundos, de forma
 * visível. Com WAL, a thread principal continua lendo sem esperar enquanto esta
 * escreve.
 *
 * A thread tem seu próprio handle de banco (handles do SQLite não atravessam threads) e o
 * seu próprio coletor — o da thread principal também não atravessa. É por isso que o
 * agendador nunca dispara duas coletas ao mesmo tempo: seriam dois coletores sem saber um
 * do outro.
 *
 * O que este arquivo decide é só o destino das linhas; de onde elas vêm é assunto do
 * coletor, atrás da porta em `collect/port.ts`.
 */

import { parentPort, workerData } from "node:worker_threads";

import { loadCollector } from "../collect/load.js";
import { type Dataset } from "../core/datasets.js";
import { type Server } from "../core/servers.js";
import { openDb, transact } from "../store/db.js";
import {
  abortSnapshot,
  beginSnapshot,
  finishSnapshot,
  rollupDaily,
  rollupListings,
  writeRows,
} from "../store/write.js";

export interface CrawlJob {
  dataset: Dataset;
  server: Server;
}

export interface CrawlOutcome {
  dataset: Dataset;
  snapshotId: number | null;
  rows: number;
  failures: number;
  durationMs: number;
  error?: string;
}

const job = workerData as CrawlJob;

async function run(): Promise<CrawlOutcome> {
  const started = Date.now();
  // No caminho de erro o snapshot é abortado, então as linhas gravadas até ali não existem
  // mais: não há contagem honesta a reportar, e o agendador só olha `error` mesmo.
  const failed = (error: string): CrawlOutcome => ({
    dataset: job.dataset,
    snapshotId: null,
    rows: 0,
    failures: 0,
    durationMs: Date.now() - started,
    error,
  });

  const collector = await loadCollector();
  // Sem coletor não há o que abrir: um snapshot vazio e abortado só sujaria a tabela.
  if (collector === null) return failed("nenhum coletor instalado");

  const db = openDb();
  const snap = beginSnapshot(db, job.dataset, job.server, "crawl");

  /**
   * Falha da NOSSA gravação, guardada em vez de propagada.
   *
   * `onRows` é chamado de dentro do laço do coletor, que trata qualquer exceção como
   * "esta unidade falhou". Deixar um erro de banco subir por ali o converteria numa
   * falha de coleta — podendo até ser retentada, e contando para o corte de 20% — quando
   * o problema é daqui. Então ele é capturado e relançado depois que `crawl()` retorna.
   */
  let writeError: unknown = null;

  try {
    const report = await collector.crawl({
      dataset: job.dataset,
      server: job.server,
      // `writeRows` abre a própria transação, uma por lote, que é o que mantém o write
      // lock em poucos milissegundos e deixa a API ler durante a coleta.
      onRows: (batch) => {
        if (writeError !== null) return;
        try {
          writeRows(db, snap, batch);
        } catch (err) {
          writeError = err;
        }
      },
    });

    if (writeError !== null) throw writeError;

    // Uma coleta que falhou demais não descreve o mercado — publicá-la faria o cache
    // "perder" itens que só não foram buscados. Melhor manter a anterior.
    if (report.planned > 0 && report.failures / report.planned > 0.2) {
      throw new Error(
        `${report.failures} de ${report.planned} unidades falharam (>20%), descartando a coleta`,
      );
    }

    if (job.dataset === "trading") {
      rollupListings(db, snap);
      transact(db, () => rollupDaily(db, snap.server, snap.startedAt));
    }

    return {
      dataset: job.dataset,
      snapshotId: snap.id,
      rows: finishSnapshot(db, snap.id, job.dataset),
      failures: report.failures,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    abortSnapshot(db, snap.id);
    return failed((err as Error).message);
  } finally {
    await collector.close();
    db.close();
  }
}

const outcome = await run();
parentPort?.postMessage(outcome);
