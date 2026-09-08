/**
 * Reconstrói o retrato corrente no R2 a partir de um `market.db`.
 *
 * A carga do D1 (`tools/migrate-to-d1.mjs`) leva o histórico e deliberadamente NÃO leva os
 * anúncios crus. Sem este passo o serviço sobe com histórico completo e mercado vazio: a
 * busca não acha oferta nenhuma até a primeira coleta pousar, meia hora depois.
 *
 * Entra pela rota REAL de ingestão, e não por uma escrita direta no R2. É de propósito: o
 * formato do blob, o rollup de percentis, a assinatura e a virada do ponteiro passam a ser
 * exercitados pelo mesmo código que vai rodar para sempre, na primeira vez que importa. Um
 * importador especial provaria o importador, não o serviço.
 *
 * Uso:
 *   INGEST_URL=... INGEST_SECRET=... npx tsx src/cli/bootstrap-blob.ts <origem.db> [--dry-run]
 */

import { createRequire } from "node:module";

import { SERVERS, type Server } from "../core/servers.js";
import type { MarketPriceRow, TradingRow } from "../store/rows.js";
import { ship } from "../shipper/ship.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const source = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!source) {
  console.error("uso: npx tsx src/cli/bootstrap-blob.ts <origem.db> [--dry-run]");
  process.exit(1);
}

const url = process.env["INGEST_URL"] ?? "";
const secret = process.env["INGEST_SECRET"] ?? "";
if (!dryRun && (!url || !secret)) {
  console.error("INGEST_URL e INGEST_SECRET são obrigatórios (ou use --dry-run)");
  process.exit(1);
}

const db = new DatabaseSync(source, { readOnly: true });

/** O snapshot fechado mais recente de um dataset. Mesma regra que os leitores usavam. */
function latest(dataset: string, server: Server): { id: number; started_at: number } | null {
  return (
    (db
      .prepare(
        `SELECT id, started_at FROM snapshot
          WHERE dataset = ? AND server = ? AND ok = 1 AND source <> 'live'
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(dataset, server) as { id: number; started_at: number } | undefined) ?? null
  );
}

/**
 * Os anúncios de um snapshot, na forma que o COLETOR produz.
 *
 * O caminho é o inverso do da gravação: `listing` + `store` + `item` voltam a ser a linha
 * crua que `writeRows` recebeu. Os nomes dos campos são os do site, porque é isso que
 * `store/rows.ts` define como contrato de ingestão.
 */
function tradingRows(snapshotId: number): TradingRow[] {
  const rows = db
    .prepare(
      `SELECT l.item_id, l.map_id, l.ssi, l.price, l.cnt, l.slot_max, l.store_type,
              s.name AS store_name, s.seller,
              i.name AS item_name, i.img_path, i.db_type
         FROM listing l
         JOIN store s ON s.id = l.store_id
         LEFT JOIN item i ON i.item_id = l.item_id
        WHERE l.snapshot_id = ?
        ORDER BY l.item_id, l.price`,
    )
    .all(snapshotId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    itemId: r["item_id"] as number,
    itemName: (r["item_name"] as string | null) ?? `Item ${String(r["item_id"])}`,
    databaseImgPath: (r["img_path"] as string | null) ?? null,
    databaseType: (r["db_type"] as string | null) ?? null,
    mapId: (r["map_id"] as number | null) ?? 0,
    ssi: r["ssi"] as string,
    storeName: r["store_name"] as string,
    itemPrice: r["price"] as number,
    itemCnt: r["cnt"] as number,
    // O site manda `""` quando não há slot, e é assim que a ingestão espera receber.
    slotMaxCount: (r["slot_max"] as string | null) ?? "",
    storeTypeName: (r["store_type"] as string | null) ?? "",
    itemSellerCharName: r["seller"] as string,
  }));
}

function marketRows(snapshotId: number): MarketPriceRow[] {
  const rows = db
    .prepare(
      `SELECT p.item_id, p.total_cnt, p.min_price, p.max_price, p.avg_price,
              i.name AS item_name, i.img_path, i.db_type
         FROM price_point p
         LEFT JOIN item i ON i.item_id = p.item_id
        WHERE p.snapshot_id = ?
        ORDER BY p.item_id`,
    )
    .all(snapshotId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    itemId: r["item_id"] as number,
    itemName: (r["item_name"] as string | null) ?? `Item ${String(r["item_id"])}`,
    databaseImgPath: (r["img_path"] as string | null) ?? null,
    databaseType: (r["db_type"] as string | null) ?? null,
    totalItemCnt: (r["total_cnt"] as number | null) ?? 0,
    minItemPrice: (r["min_price"] as number | null) ?? 0,
    maxItemPrice: (r["max_price"] as number | null) ?? 0,
    avgItemPrice: (r["avg_price"] as number | null) ?? 0,
  }));
}

/**
 * Tudo que já passou pelo mercado daquele servidor.
 *
 * É a fonte de verdade do `item_market`, e sem ela o primeiro retrato só conheceria os
 * itens anunciados no instante do dump.
 */
function inMarketIds(server: Server): number[] {
  return (
    db
      .prepare(`SELECT item_id FROM item_market WHERE server = ? AND in_market = 1`)
      .all(server) as Array<{ item_id: number }>
  ).map((r) => r.item_id);
}

const target = { url, secret };

for (const server of SERVERS) {
  // A ordem importa e é a mesma da ingestão normal: o agregado primeiro, os anúncios
  // depois. Cada retrato carrega adiante a metade que a outra coleta não tocou, então
  // inverter deixaria o `marketAt` do blob final apontando para o passado.
  for (const dataset of ["market-price", "trading"] as const) {
    const snap = latest(dataset, server);
    if (!snap) {
      console.log(`${server}/${dataset}: nenhum snapshot fechado, pulando`);
      continue;
    }

    const rows: Array<TradingRow | MarketPriceRow> =
      dataset === "trading" ? tradingRows(snap.id) : marketRows(snap.id);
    if (rows.length === 0) {
      console.log(`${server}/${dataset}: snapshot ${snap.id} está vazio, pulando`);
      continue;
    }

    if (dryRun) {
      console.log(
        `${server}/${dataset}: snapshot ${snap.id} (${new Date(snap.started_at * 1000).toISOString()}) ` +
          `-> ${rows.length} linhas`,
      );
      continue;
    }

    const result = await ship(target, {
      dataset,
      server,
      startedAt: snap.started_at,
      // Preso ao snapshot de origem: reexecutar o bootstrap não abre um segundo snapshot,
      // ele reencontra o mesmo e não faz nada. Importar é uma operação que costuma ser
      // repetida enquanto se ajusta o resto.
      crawlId: `bootstrap-${server}-${dataset}-${snap.id}`,
      inMarketSeed: inMarketIds(server),
      // Não há agendador aqui; o shipper de verdade assume a partir da próxima coleta.
      nextRunAt: 0,
      rows,
    });
    console.log(
      `${server}/${dataset}: snapshot ${snap.id} -> ${result.snapshotId}` +
        `${result.duplicate ? " (já existia)" : ""}, ${rows.length} linhas`,
    );
  }
}

db.close();
