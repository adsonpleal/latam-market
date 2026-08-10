/**
 * Varreduras sobre o mercado inteiro: o que mudou de preço e o que está barato.
 *
 * Ambas exigem histórico acumulado. Num banco recém-criado (só o backfill dos NDJSON)
 * elas devolvem lista vazia, e isso é o certo — inventar movimento a partir de uma
 * única coleta seria pior que não responder.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Server } from "./servers.js";

import { getCache } from "../store/cache.js";
import { toBrief } from "./items.js";
import type { ItemBrief } from "./types.js";

/**
 * Teto da janela que o chamador pode pedir.
 *
 * As duas varreduras agregam `listing_daily`, que é guardada para sempre. Com 90 dias
 * acumulados, `days=365` foi medido em ~44 ms de `node:sqlite` — síncrono, portanto a
 * API inteira parada. E as rotas são públicas e sem limite de taxa. 90 dias respondem
 * qualquer pergunta de tendência que faça sentido aqui.
 */
const MAX_DAYS = 90;

/**
 * Memo dos resultados, chaveado pelos argumentos e pela coleta de origem.
 *
 * As entradas só mudam quando um crawl fecha um snapshot — de hora em hora. Sem isso,
 * cada requisição refaz um agregado que cresce com o histórico.
 */
const memo = new Map<string, unknown>();

function memoized<T>(kind: string, server: Server, args: unknown, compute: () => T): T {
  const cache = getCache(server);
  // O servidor entra na chave: sem ele, a primeira resposta de FREYA seria servida
  // para NIDHOGG e vice-versa — os ids de snapshot são de sequências independentes.
  const key = `${kind}:${server}:${cache.tradingSnapshotId}:${JSON.stringify(args)}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit as T;

  // Uma coleta nova invalida tudo de uma vez: as chaves antigas carregam o id
  // anterior e nunca mais seriam consultadas.
  if (memo.size > 64) memo.clear();

  const value = compute();
  memo.set(key, value);
  return value;
}

export interface Mover {
  item: ItemBrief;
  /** Mediana atual das ofertas. */
  now: number;
  /** Mediana no início da janela. */
  before: number;
  changePct: number;
  /** Lojas vendendo agora — serve para descartar movimento de item ilíquido. */
  stores: number;
}

export interface MoversOptions {
  days?: number;
  direction?: "up" | "down" | "both";
  /** Mínimo de lojas vendendo, para não listar item que só uma pessoa anuncia. */
  minStores?: number;
  /** Descarta itens baratos demais, onde 1z de variação vira 50%. */
  minPrice?: number;
  limit?: number;
}

export function topMovers(db: DatabaseSync, server: Server, opts: MoversOptions = {}): Mover[] {
  return memoized("movers", server, opts, () => computeMovers(db, server, opts));
}

function computeMovers(db: DatabaseSync, server: Server, opts: MoversOptions): Mover[] {
  const days = Math.min(Math.max(opts.days ?? 7, 1), MAX_DAYS);
  const minStores = opts.minStores ?? 3;
  const minPrice = opts.minPrice ?? 1000;
  const limit = Math.min(opts.limit ?? 20, 100);
  const direction = opts.direction ?? "both";

  const now = Math.floor(Date.now() / 1000);
  const from = Math.floor((now - days * 86400) / 86400) * 86400;

  // Primeiro e último ponto diário de cada item dentro da janela. Fazer isso em SQL
  // evita trazer a série inteira de 5 mil itens só para pegar dois valores de cada.
  const rows = db
    .prepare(
      `WITH bounds AS (
         SELECT item_id, MIN(day) AS first_day, MAX(day) AS last_day, COUNT(*) AS pts
           FROM listing_daily WHERE server = ? AND day >= ? GROUP BY item_id HAVING pts >= 2
       )
       SELECT b.item_id,
              f.median AS before, f.listings AS before_stores,
              l.median AS now,    l.listings AS now_stores
         FROM bounds b
         JOIN listing_daily f ON f.server = ? AND f.item_id = b.item_id AND f.day = b.first_day
         JOIN listing_daily l ON l.server = ? AND l.item_id = b.item_id AND l.day = b.last_day
        WHERE l.listings >= ? AND f.median >= ? AND l.median >= ?`,
    )
    .all(server, from, server, server, minStores, minPrice, minPrice) as Array<Record<string, number>>;

  const movers: Mover[] = [];
  for (const r of rows) {
    const before = r["before"]!;
    const value = r["now"]!;
    if (before <= 0) continue;
    const changePct = Math.round(((value - before) / before) * 100);
    if (changePct === 0) continue;
    if (direction === "up" && changePct < 0) continue;
    if (direction === "down" && changePct > 0) continue;
    const item = toBrief(server, r["item_id"]!);
    if (!item) continue;
    movers.push({ item, now: value, before, changePct, stores: r["now_stores"]! });
  }

  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return movers.slice(0, limit);
}

export interface Deal {
  item: ItemBrief;
  /** A oferta mais barata agora. */
  price: number;
  /** Mediana das medianas diárias da janela. */
  usual: number;
  /** Desconto em relação ao usual, em %. */
  discountPct: number;
  stores: number;
  seller: string;
}

export interface DealsOptions {
  days?: number;
  /** Desconto mínimo para entrar na lista. */
  minDiscountPct?: number;
  minPrice?: number;
  minStores?: number;
  limit?: number;
}

/**
 * Ofertas bem abaixo do que o item costuma custar.
 *
 * Exige `minStores` maior que 1 de propósito: um item com uma única loja não tem
 * "preço usual", tem o preço que aquela pessoa escolheu. E compara o mínimo de agora
 * contra a MEDIANA histórica, não contra o mínimo histórico — senão todo item cujo
 * dono errou o preço uma vez apareceria como pechincha para sempre.
 */
export function findDeals(db: DatabaseSync, server: Server, opts: DealsOptions = {}): Deal[] {
  return memoized("deals", server, opts, () => computeDeals(db, server, opts));
}

function computeDeals(db: DatabaseSync, server: Server, opts: DealsOptions): Deal[] {
  const days = Math.min(Math.max(opts.days ?? 14, 2), MAX_DAYS);
  const minDiscount = opts.minDiscountPct ?? 25;
  const minPrice = opts.minPrice ?? 5000;
  const minStores = opts.minStores ?? 2;
  const limit = Math.min(opts.limit ?? 20, 100);

  const from = Math.floor((Date.now() / 1000 - days * 86400) / 86400) * 86400;
  const usualByItem = new Map<number, number>();
  const rows = db
    .prepare(
      `SELECT item_id, AVG(median) AS usual, COUNT(*) AS pts
         FROM listing_daily WHERE server = ? AND day >= ? GROUP BY item_id HAVING pts >= 2`,
    )
    .all(server, from) as Array<Record<string, number>>;
  for (const r of rows) usualByItem.set(r["item_id"]!, r["usual"]!);

  const cache = getCache(server);
  const deals: Deal[] = [];
  for (const [itemId, listings] of cache.listings) {
    if (listings.length < minStores) continue;
    const usual = usualByItem.get(itemId);
    if (usual === undefined || usual < minPrice) continue;

    const best = listings[0]!;
    const discountPct = Math.round(((usual - best.price) / usual) * 100);
    if (discountPct < minDiscount) continue;

    const item = toBrief(server, itemId);
    if (!item) continue;
    deals.push({
      item,
      price: best.price,
      usual: Math.round(usual),
      discountPct,
      stores: listings.length,
      seller: best.seller,
    });
  }

  deals.sort((a, b) => b.discountPct - a.discountPct);
  return deals.slice(0, limit);
}
