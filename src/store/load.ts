/**
 * Monta o mercado corrente a partir do banco — o caminho do boot.
 *
 * Em regime o cache é mantido pela ingestão, item a item (`ingest/session.ts`). Isto só
 * roda quando o processo sobe, para ele não começar vazio até a próxima coleta.
 */

import type { Server } from "../core/servers.js";
import type { Db } from "./port.js";
import { setCache, type CatalogueIndex } from "./cache.js";
import { inMarketIds, type ListingRow, type PricePoint } from "./read.js";

export async function loadMarketFromDb(
  db: Db,
  catalogue: CatalogueIndex,
  server: Server,
): Promise<void> {
  // A coleta de anúncios que vale é a última fechada com cobertura suficiente — a mesma
  // regra com que a ingestão anda o relógio. Uma coleta fechada com metade dos termos
  // falhando continua tendo publicado os itens que completou, mas não é "o mercado de agora".
  const trading = await db.first<{ id: number; started_at: number }>(
    `SELECT id, started_at FROM snapshot
      WHERE server = ? AND dataset = 'trading' AND ok = 1 AND (coverage IS NULL OR coverage >= 0.8)
      ORDER BY started_at DESC LIMIT 1`,
    server,
  );
  const market = await db.first<{ id: number; started_at: number }>(
    `SELECT id, started_at FROM snapshot
      WHERE server = ? AND dataset = 'market-price' AND ok = 1
      ORDER BY started_at DESC LIMIT 1`,
    server,
  );

  const listings = new Map<number, ListingRow[]>();
  for (const r of await db.all<Record<string, unknown>>(
    `SELECT item_id, price, ssi, cnt, slot_max, store_name, seller, map_id
       FROM offer WHERE server = ? ORDER BY item_id, price, ssi`,
    server,
  )) {
    const itemId = r["item_id"] as number;
    let bucket = listings.get(itemId);
    if (!bucket) listings.set(itemId, (bucket = []));
    bucket.push({
      itemId,
      ssi: r["ssi"] as string,
      price: r["price"] as number,
      cnt: r["cnt"] as number,
      slotMax: (r["slot_max"] as string | null) ?? null,
      storeName: r["store_name"] as string,
      seller: r["seller"] as string,
      mapId: (r["map_id"] as number | null) ?? null,
    });
  }

  const prices = new Map<number, PricePoint>();
  if (market) {
    for (const r of await db.all<Record<string, number | null>>(
      `SELECT item_id, ts, total_cnt, min_price, max_price, avg_price
         FROM price_point WHERE server = ? AND ts = ?`,
      server,
      market.started_at,
    )) {
      prices.set(r["item_id"]!, {
        itemId: r["item_id"]!,
        ts: r["ts"]!,
        totalCnt: r["total_cnt"] ?? null,
        minPrice: r["min_price"] ?? null,
        maxPrice: r["max_price"] ?? null,
        avgPrice: r["avg_price"] ?? null,
      });
    }
  }

  setCache(server, {
    tradingSnapshotId: trading?.id ?? null,
    tradingAt: trading?.started_at ?? null,
    marketSnapshotId: market?.id ?? null,
    marketAt: market?.started_at ?? null,
    items: catalogue.items,
    byNameNorm: catalogue.byNameNorm,
    inMarket: await inMarketIds(db, server),
    prices,
    listings,
  });
}
