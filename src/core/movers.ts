/**
 * Varreduras sobre o mercado inteiro: o que mudou de preço e o que está barato.
 *
 * Ambas exigem histórico acumulado. Num banco recém-criado (só o backfill dos NDJSON)
 * elas devolvem lista vazia, e isso é o certo — inventar movimento a partir de uma
 * única coleta seria pior que não responder.
 */

import type { Db } from "../store/port.js";

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
 * Memo das consultas a `listing_daily`, chaveado pelos argumentos e pela HORA.
 *
 * A hora, e não a coleta: `listing_daily` só muda quando o rollup de hora em hora roda,
 * então uma coleta nova não muda nada do que estas consultas leem. Chavear pelo id do
 * snapshot fazia cada coleta — e cada isolate — refazer a varredura: foram 219 execuções
 * num dia, e com a cadência mais curta seriam várias vezes isso.
 */
const memo = new Map<string, unknown>();

const hourBucket = (): number => Math.floor(Date.now() / 3_600_000);

function memoized<T>(
  kind: string,
  server: Server,
  args: unknown,
  compute: () => Promise<T>,
): Promise<T> {
  // O servidor entra na chave: sem ele, a primeira resposta de FREYA seria servida
  // para NIDHOGG e vice-versa.
  const key = `${kind}:${server}:${hourBucket()}:${JSON.stringify(args)}`;
  const hit = memo.get(key);
  if (hit !== undefined) return hit as Promise<T>;

  // Uma hora nova invalida tudo de uma vez: as chaves antigas carregam o balde anterior
  // e nunca mais seriam consultadas.
  if (memo.size > 64) memo.clear();

  // Guarda a PROMESSA, não o valor resolvido: duas requisições simultâneas para o mesmo
  // agregado passam a dividir uma consulta em vez de disparar duas. Uma rejeição sai do
  // memo, senão o primeiro erro ficaria cacheado até a coleta seguinte.
  const value = compute().catch((err: unknown) => {
    memo.delete(key);
    throw err;
  });
  memo.set(key, value);
  return value;
}

/**
 * Primeiro e último ponto diário de cada item dentro da janela.
 *
 * A ORDEM das junções é o que custa. Com `JOIN` comum o planejador escolhia varrer
 * `listing_daily l` inteira como laço externo e, para cada linha, percorrer o histórico
 * do item em `f` — ~11 milhões de linhas lidas por execução no D1, onde a consulta
 * certa lê ~250 mil. `MATERIALIZED` calcula `bounds` uma vez, e `CROSS JOIN` é a forma
 * de o SQLite respeitar a ordem escrita: `b` por fora, `f` e `l` como buscas pela chave
 * primária inteira. Exportada para `store/__tests__/movers-query.test.ts` conferir o plano.
 *
 * Parâmetros `?` anônimos, e não `?1`: o `node:sqlite` recusa parâmetro numerado ligado por
 * posição ("column index out of range"), e a consulta precisa rodar nos dois. Parâmetros:
 * `server, from, server, server, minStores, minPrice, minPrice`.
 */
export const MOVERS_SQL = `WITH bounds AS MATERIALIZED (
     SELECT item_id, MIN(day) AS first_day, MAX(day) AS last_day
       FROM listing_daily
      WHERE server = ? AND day >= ?
      GROUP BY item_id
     HAVING COUNT(*) >= 2
   )
   SELECT b.item_id,
          f.median AS before, f.listings AS before_stores,
          l.median AS now,    l.listings AS now_stores
     FROM bounds b
    CROSS JOIN listing_daily f
    CROSS JOIN listing_daily l
    WHERE f.server = ? AND f.item_id = b.item_id AND f.day = b.first_day
      AND l.server = ? AND l.item_id = b.item_id AND l.day = b.last_day
      AND l.listings >= ? AND f.median >= ? AND l.median >= ?`;

/** Média das medianas diárias por item na janela — o "preço usual" das pechinchas. */
export const USUAL_PRICES_SQL = `SELECT item_id, AVG(median) AS usual, COUNT(*) AS pts
   FROM listing_daily WHERE server = ? AND day >= ? GROUP BY item_id HAVING pts >= 2`;

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

export function topMovers(
  db: Db,
  server: Server,
  opts: MoversOptions = {},
): Promise<Mover[]> {
  return memoized("movers", server, opts, () =>
    computeMovers(db, server, opts),
  );
}

async function computeMovers(
  db: Db,
  server: Server,
  opts: MoversOptions,
): Promise<Mover[]> {
  const days = Math.min(Math.max(opts.days ?? 7, 1), MAX_DAYS);
  const minStores = opts.minStores ?? 3;
  const minPrice = opts.minPrice ?? 1000;
  const limit = Math.min(opts.limit ?? 20, 100);
  const direction = opts.direction ?? "both";

  const now = Math.floor(Date.now() / 1000);
  const from = Math.floor((now - days * 86400) / 86400) * 86400;

  // Fazer isso em SQL evita trazer a série inteira de 5 mil itens só para pegar dois
  // valores de cada.
  const rows = await db.all<Record<string, number>>(
    MOVERS_SQL,
    server,
    from,
    server,
    server,
    minStores,
    minPrice,
    minPrice,
  );

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
    movers.push({
      item,
      now: value,
      before,
      changePct,
      stores: r["now_stores"]!,
    });
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
export async function findDeals(
  db: Db,
  server: Server,
  opts: DealsOptions = {},
): Promise<Deal[]> {
  const days = Math.min(Math.max(opts.days ?? 14, 2), MAX_DAYS);
  // Só o "preço usual" vai para o memo: ele sai de `listing_daily`, que muda de hora em
  // hora. A comparação com as ofertas de AGORA é refeita a cada chamada — é barata, e as
  // ofertas mudam a cada coleta.
  const usualByItem = await memoized("deals-usual", server, { days }, () =>
    usualPrices(db, server, days),
  );
  return dealsFrom(server, usualByItem, opts);
}

async function usualPrices(db: Db, server: Server, days: number): Promise<Map<number, number>> {
  const from = Math.floor((Date.now() / 1000 - days * 86400) / 86400) * 86400;
  const usualByItem = new Map<number, number>();
  const rows = await db.all<Record<string, number>>(
    USUAL_PRICES_SQL,
    server,
    from,
  );
  for (const r of rows) usualByItem.set(r["item_id"]!, r["usual"]!);
  return usualByItem;
}

function dealsFrom(server: Server, usualByItem: Map<number, number>, opts: DealsOptions): Deal[] {
  const minDiscount = opts.minDiscountPct ?? 25;
  const minPrice = opts.minPrice ?? 5000;
  const minStores = opts.minStores ?? 2;
  const limit = Math.min(opts.limit ?? 20, 100);

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
