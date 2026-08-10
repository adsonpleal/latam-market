/**
 * Retenção em camadas.
 *
 * O EC2 é compartilhado, então o banco não pode crescer sem teto. As três camadas
 * respondem perguntas diferentes e por isso têm prazos diferentes:
 *
 *   listing        anúncio cru, com nome de vendedor     últimos N snapshots  (~40 MB)
 *   listing_stats  percentis por item por coleta         30 dias
 *   listing_daily  o mesmo, por dia                      para sempre  (~60 MB/ano)
 *   price_point    agregado publicado pelo próprio site  para sempre
 *
 * Quem precisa saber "quem está vendendo agora" usa a camada crua e não olha para trás;
 * quem pergunta "quanto custava em maio" usa a diária. Ninguém precisa do nome de um
 * vendedor de três meses atrás.
 */

import type { DatabaseSync } from "node:sqlite";

import { SERVERS } from "../core/servers.js";
import { nowSec, transact } from "./db.js";
import { rollupDaily } from "./write.js";

export const RETENTION = {
  /** Snapshots de trading mantidos com anúncios crus. 24 = um dia de coleta horária. */
  rawSnapshots: 24,
  /** Dias de `listing_stats` (granularidade por coleta). */
  statsDays: 30,
};

export interface SweepResult {
  listingsDeleted: number;
  statsDeleted: number;
  snapshotsDeleted: number;
}

/**
 * Uma passada de limpeza. Consolida o dia anterior ANTES de apagar qualquer coisa —
 * apagar primeiro perderia o dia que ainda não tinha sido consolidado.
 *
 * Roda de hora em hora (ver `worker/scheduler.ts`), numa worker thread: a varredura
 * foi medida em ~1,16 s no estado de regime, e `node:sqlite` é síncrono.
 */
export function sweep(db: DatabaseSync, now = nowSec()): SweepResult {
  const yesterday = Math.floor(now / 86400) * 86400 - 86400;
  // Um rollup por servidor: as tabelas diárias agora são particionadas por ele, e
  // consolidar só um deixaria o outro sem histórico permanente.
  for (const server of SERVERS) {
    rollupDaily(db, server, yesterday);
    rollupDaily(db, server, now);
  }

  return transact(db, () => {
    // Mantém os N snapshots de trading mais recentes com anúncio cru; os demais já
    // têm rollup em listing_stats, então perdem só a granularidade por vendedor.
    const keep = db
      .prepare(
        `SELECT id FROM snapshot
          WHERE dataset = 'trading' AND ok = 1
          ORDER BY started_at DESC LIMIT ?`,
      )
      .all(RETENTION.rawSnapshots) as Array<{ id: number }>;
    const keepIds = keep.map((r) => r.id);
    const placeholders = keepIds.map(() => "?").join(",") || "NULL";

    const listings = db
      .prepare(`DELETE FROM listing WHERE snapshot_id NOT IN (${placeholders})`)
      .run(...keepIds);

    const statsCutoff = now - RETENTION.statsDays * 86400;
    const stats = db.prepare(`DELETE FROM listing_stats WHERE ts < ?`).run(statsCutoff);

    // Um snapshot de trading sem anúncio cru e sem stats não descreve mais nada;
    // os de market-price ficam, porque price_point é permanente e referencia o id.
    const snapshots = db
      .prepare(
        `DELETE FROM snapshot
          WHERE dataset = 'trading'
            AND id NOT IN (${placeholders})
            AND started_at < ?`,
      )
      .run(...keepIds, statsCutoff);

    // Lojas que não têm mais nenhum anúncio viram lixo puro.
    db.exec(`DELETE FROM store WHERE id NOT IN (SELECT DISTINCT store_id FROM listing)`);

    return {
      listingsDeleted: Number(listings.changes),
      statsDeleted: Number(stats.changes),
      snapshotsDeleted: Number(snapshots.changes),
    };
  });
}

/**
 * Devolve páginas livres ao sistema de arquivos, aos poucos.
 *
 * Incremental de propósito: um VACUUM completo reescreve o arquivo inteiro e trava
 * o banco por segundos, o que numa máquina compartilhada aparece como a API travada.
 */
export function reclaim(db: DatabaseSync, pages = 1000): void {
  db.exec(`PRAGMA incremental_vacuum(${pages})`);
}
