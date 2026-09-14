/**
 * A carga única do que estava na Cloudflare: o banco do D1 e o mercado corrente do R2.
 *
 *   sqlite3 market.db < d1-export.sql            # o histórico, como o D1 exportou
 *   node dist/import-cloudflare.mjs \
 *     --db market.db --migrations migrations \
 *     --blob FREYA=freya.json.gz --blob NIDHOGG=nidhogg.json.gz
 *
 * O histórico entra pelo `sqlite3` e não por aqui: o export do D1 já é SQL puro, e o CLI lê
 * em stream um arquivo de centenas de MB que em memória não caberia na VM. Este passo faz
 * o resto:
 *
 *  1. abre o banco e migra — reconhece o `d1_migrations` do export e aplica só o que falta;
 *  2. carrega as ofertas de agora de cada blob do R2 (no D1 elas não existiam, eram só blob);
 *  3. marca como "já visto no mercado" todo id que o blob guardava. O primeiro retrato do
 *     Worker foi semeado com ~850 ids que NUNCA foram gravados em `item_market` — sem este
 *     passo eles sumiriam da busca, que filtra por "já visto" por padrão.
 *
 * Repetível: apaga as ofertas do servidor antes de carregar.
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { parseServer, type Server } from "../core/servers.js";
import { openDb, transact } from "../store/db.js";

/** O formato do blob do R2 (versão 1), só com o que a carga lê. */
interface SnapshotBlobV1 {
  v: number;
  server: string;
  snapshotId: number;
  startedAt: number;
  inMarket: number[];
  /** [itemId, price, cnt, slotMax, storeName, seller, mapId, ssi] */
  listings: Array<[number, number, number, string | null, string, string, number | null, string]>;
}

function parseArgs(argv: string[]) {
  const out = { db: "", migrations: "migrations", blobs: [] as Array<[Server, string]> };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--db") out.db = argv[++i]!;
    else if (flag === "--migrations") out.migrations = argv[++i]!;
    else if (flag === "--blob") {
      const [name, path] = argv[++i]!.split("=");
      const server = parseServer(name ?? null);
      if (!server || !path) throw new Error(`--blob espera SERVIDOR=arquivo, veio "${argv[i]}"`);
      out.blobs.push([server, path]);
    }
  }
  if (!out.db) throw new Error("falta --db");
  return out;
}

export function readBlob(path: string): SnapshotBlobV1 {
  const bytes = readFileSync(path);
  // O R2 guardava o blob comprimido; o `wrangler r2 object get` devolve os bytes como estão.
  const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  const blob = JSON.parse(text) as SnapshotBlobV1;
  if (blob.v !== 1) throw new Error(`blob ${path} na versão ${blob.v}, esperada 1`);
  return blob;
}

export function importBlob(db: import("node:sqlite").DatabaseSync, server: Server, blob: SnapshotBlobV1) {
  const snapshot = db.prepare(`SELECT ok FROM snapshot WHERE id = ?`).get(blob.snapshotId) as
    | { ok: number }
    | undefined;
  if (!snapshot || snapshot.ok !== 1) {
    // O blob aponta um snapshot que o export não trouxe: os dois foram tirados em momentos
    // diferentes. Carregar assim deixaria ofertas de uma coleta que o histórico não conhece.
    throw new Error(`snapshot ${blob.snapshotId} de ${server} não está fechado no banco importado`);
  }

  let offers = 0;
  let seeded = 0;
  transact(db, () => {
    db.prepare(`DELETE FROM offer WHERE server = ?`).run(server);
    db.prepare(`DELETE FROM offer_item WHERE server = ?`).run(server);

    const insertOffer = db.prepare(
      `INSERT OR REPLACE INTO offer (server, item_id, price, ssi, cnt, slot_max, store_name, seller, map_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const confirm = db.prepare(
      `INSERT OR REPLACE INTO offer_item (server, item_id, seen_at, snapshot_id) VALUES (?, ?, ?, ?)`,
    );
    const items = new Set<number>();
    for (const [itemId, price, cnt, slotMax, storeName, seller, mapId, ssi] of blob.listings) {
      insertOffer.run(server, itemId, price, ssi, cnt, slotMax, storeName, seller, mapId);
      items.add(itemId);
      offers++;
    }
    for (const itemId of items) confirm.run(server, itemId, blob.startedAt, blob.snapshotId);

    const seed = db.prepare(
      `INSERT INTO item_market (item_id, server, in_market) VALUES (?, ?, 1)
       ON CONFLICT (item_id, server) DO UPDATE SET in_market = 1 WHERE item_market.in_market = 0`,
    );
    for (const itemId of blob.inMarket) seeded += Number(seed.run(itemId, server).changes);
  });
  return { offers, seeded };
}

const isMain = process.argv[1]?.endsWith("import-cloudflare.mjs") || process.argv[1]?.endsWith("import-cloudflare.ts");
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb({ path: args.db, migrationsDir: args.migrations });
  for (const [server, path] of args.blobs) {
    const { offers, seeded } = importBlob(db, server, readBlob(path));
    console.log(`${server}: ${offers} ofertas carregadas, ${seeded} ids marcados como já vistos`);
  }
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  console.log(`integridade: ${integrity.integrity_check}`);
  db.close();
}
