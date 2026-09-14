/**
 * A faxina diária do banco, dentro do processo.
 *
 * Era um Cron Trigger no Worker. Aqui é um timer, e duas coisas mudaram por causa do
 * tamanho que o histórico passa a ter com coletas a cada 10 minutos (`listing_stats` passa
 * de 20 milhões de linhas):
 *
 *  - **por item, em faixas de chave**. `DELETE ... WHERE ts < ?` sem o item na frente varre
 *    a tabela inteira — segundos de SQLite síncrono segurando a API. Item a item, cada
 *    DELETE é uma faixa da chave primária;
 *  - **com pausas**: lotes de itens com uma volta do laço de eventos entre eles.
 *
 * O rollup diário não está mais aqui: a ingestão refaz o dia do item a cada entrega
 * (`rollupItemDay`).
 */

import { SERVERS } from "../core/servers.js";
import { sweepItem } from "../ingest/writes.js";
import type { DatabaseSync } from "node:sqlite";
import type { WritableDb } from "../store/port.js";

const CHUNK = 200;
const HOUR = 3_600_000;

export async function runMaintenance(db: WritableDb, raw: DatabaseSync, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const started = Date.now();
  let items = 0;
  for (const server of SERVERS) {
    const ids = (
      await db.all<{ item_id: number }>(`SELECT item_id FROM item_market WHERE server = ?`, server)
    ).map((r) => r.item_id);
    for (let i = 0; i < ids.length; i += CHUNK) {
      await db.batch(ids.slice(i, i + CHUNK).flatMap((id) => sweepItem(server, id, now)));
      await new Promise((resolve) => setImmediate(resolve));
    }
    items += ids.length;
  }
  // O snapshot é uma linha por coleta: some junto com a estatística que ele gerou.
  await db.run(
    `DELETE FROM snapshot WHERE dataset = 'trading' AND started_at < ?`,
    now - 30 * 86_400,
  );

  // Devolve ao disco o que a retenção liberou, aos poucos, só quando vale a pena.
  const pages = (raw.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
  const free = (raw.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  if (pages > 0 && free / pages > 0.1) {
    for (let i = 0; i < 50 && (raw.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count > 0; i++) {
      raw.exec("PRAGMA incremental_vacuum(2000)");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  raw.exec("PRAGMA optimize");
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");

  return `[manutenção] ${items} itens varridos em ${((Date.now() - started) / 1000).toFixed(1)}s`;
}

/** Uma vez por dia, na madrugada (03:13 UTC). */
export function startMaintenance(db: WritableDb, raw: DatabaseSync): { stop(): void } {
  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    const next = new Date();
    next.setUTCHours(3, 13, 0, 0);
    if (next.getTime() <= Date.now()) next.setTime(next.getTime() + 24 * HOUR);
    timer = setTimeout(() => {
      runMaintenance(db, raw)
        .then((line) => console.log(line))
        .catch((err: unknown) => console.error("[manutenção] falhou:", err))
        .finally(schedule);
    }, next.getTime() - Date.now());
    timer.unref();
  };
  schedule();
  return {
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}
