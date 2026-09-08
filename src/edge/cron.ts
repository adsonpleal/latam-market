/**
 * O trabalho agendado, do lado do banco.
 *
 * Estava em duas worker threads no EC2, disparadas pelo mesmo agendador que fazia o crawl.
 * A separação agora é por RESPONSABILIDADE, e ela caiu naturalmente onde cada coisa mora:
 * o crawl precisa do coletor e da saída de rede dele, e ficou na máquina; a retenção e o
 * rollup precisam do banco, e vieram para cá.
 *
 * Os dois gatilhos têm intervalo ≥ 1 h, o que na Cloudflare dá 15 minutos de CPU — muito
 * acima do que qualquer um deles usa.
 */

import { SERVERS } from "../core/servers.js";
import { d1Db } from "../store/d1.js";
import { RETENTION, rollupDaily, sweepStatements } from "../store/d1-write.js";
import { blobKey, pointerKey } from "../store/hydrate.js";
import type { SqlStatement } from "../store/port.js";

const DAY = 86_400;

/**
 * De hora em hora: fecha o dia corrente e limpa os retratos velhos do R2.
 *
 * O rollup do dia corrente é reescrito a cada hora porque ele ainda está crescendo — a
 * guarda de `WHERE` no upsert faz a linha que não mudou não custar escrita.
 */
export async function hourly(env: Env, now: number): Promise<void> {
  const db = d1Db(env.DB);
  const statements: SqlStatement[] = SERVERS.map((server) => rollupDaily(server, now));
  await db.batch(statements);

  await pruneBlobs(env);
}

/**
 * Uma vez por dia: fecha o dia ANTERIOR e varre o histórico vencido.
 *
 * O dia anterior é refeito uma última vez porque a última coleta dele pode ter pousado
 * depois do rollup das 23h — sem isto, o último ponto de cada dia ficaria sistematicamente
 * incompleto, e é justamente o ponto que `movers` usa como "agora".
 */
export async function daily(env: Env, now: number): Promise<void> {
  const db = d1Db(env.DB);
  const ontem = now - DAY;

  await db.batch([
    ...SERVERS.map((server) => rollupDaily(server, ontem)),
    ...sweepStatements(now),
  ]);
}

/**
 * Apaga os retratos que ninguém mais vai pedir.
 *
 * Guarda os `RETENTION.snapshotBlobs` mais recentes por servidor, e nunca o apontado pelo
 * ponteiro — um isolate pode estar no meio de uma leitura, e a hidratação trata "ponteiro
 * aponta para blob inexistente" como erro de propósito, para não servir mercado vazio.
 */
async function pruneBlobs(env: Env): Promise<void> {
  for (const server of SERVERS) {
    const pointer = await env.SNAPSHOTS.get(pointerKey(server));
    const current = pointer ? Number(await pointer.text()) : null;

    const listed = await env.SNAPSHOTS.list({ prefix: `snap/${server}/` });
    const blobs = listed.objects
      .map((object) => object.key)
      .filter((key) => key !== pointerKey(server))
      // O nome termina no id do snapshot, que é monotônico: ordenar por ele é ordenar por
      // idade sem precisar do `uploaded` de cada objeto.
      .map((key) => ({ key, id: Number(/\/(\d+)\.json$/.exec(key)?.[1]) }))
      .filter((blob) => Number.isFinite(blob.id))
      .sort((a, b) => b.id - a.id);

    for (const blob of blobs.slice(RETENTION.snapshotBlobs)) {
      if (blob.id === current) continue;
      await env.SNAPSHOTS.delete(blob.key);
    }
  }
}

/** Despacha pelo cron que disparou. Os padrões vêm do `wrangler.jsonc`. */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (cron.startsWith("13 0 ")) {
    await daily(env, now);
    console.log("[cron] fechamento diário e varredura concluídos");
    return;
  }
  await hourly(env, now);
  console.log("[cron] rollup horário e limpeza de retratos concluídos");
}

/** Exportado para o teste poder chamar cada metade sem depender do padrão do cron. */
export const __cron = { hourly, daily, blobKey };
