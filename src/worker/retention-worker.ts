/**
 * Limpeza de retenção, numa worker thread.
 *
 * Medido no estado de regime (24 coletas de anúncios cruas, 35 dias de stats): a
 * varredura leva ~1,16 s com trabalho a fazer e ~0,39 s sem. `node:sqlite` é síncrono,
 * então rodando na thread principal isso é a API inteira parada por mais de um
 * segundo, de hora em hora — enquanto o módulo do banco promete justamente que só o
 * worker escreve e a principal só lê.
 *
 * A thread abre o próprio handle porque handles do SQLite não atravessam threads.
 */

import { parentPort } from "node:worker_threads";

import { openDb } from "../store/db.js";
import { reclaim, sweep, type SweepResult } from "../store/retention.js";

const db = openDb();
let result: SweepResult;
try {
  result = sweep(db);
  reclaim(db);
} finally {
  db.close();
}

parentPort?.postMessage(result);
