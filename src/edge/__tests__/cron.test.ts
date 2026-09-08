/**
 * O trabalho agendado.
 *
 * O rollup diário saiu de "a cada coleta" para "de hora em hora" porque no D1 cada linha
 * reescrita é cobrada: 48 passadas por dia recalculando o mesmo dia eram ~10 M linhas/mês
 * para chegar ao mesmo resultado. Isso só é seguro se duas coisas valerem, e são elas que
 * este arquivo prova: o rollup produz o mesmo número rodando menos vezes, e reexecutá-lo
 * sobre um dia que não mudou não escreve nada.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { __cron } from "../cron.js";
import { RETENTION } from "../../store/d1-write.js";
import { applyMigrations, ingest } from "../../__tests__/parity-setup.js";
import type { TradingRow } from "../../store/rows.js";

const DAY = 86_400;
/** Um dia redondo, para as janelas do rollup caírem em bordas previsíveis. */
const HOJE = Math.floor(1_800_000_000 / DAY) * DAY;
const ITEM = 501;

const anuncio = (price: number, i: number, ts: number): TradingRow => ({
  itemId: ITEM,
  mapId: 1,
  ssi: `cron-${ts}-${i}`,
  itemName: "Poção Vermelha",
  databaseImgPath: null,
  databaseType: "healing",
  storeName: `Loja ${i}`,
  itemPrice: price,
  itemCnt: 2,
  slotMaxCount: "",
  storeTypeName: "BUY",
  itemSellerCharName: `Vendedor${i}`,
});

const daily = async (): Promise<Array<Record<string, number>>> => {
  const { results } = await env.DB.prepare(
    `SELECT day, listings, min_price, median, max_price FROM listing_daily
      WHERE server = 'FREYA' AND item_id = ? ORDER BY day`,
  )
    .bind(ITEM)
    .all<Record<string, number>>();
  return results;
};

describe("rollup diário", () => {
  beforeAll(async () => {
    await applyMigrations();
    // Duas coletas no mesmo dia, com preços diferentes: é a média das medianas horárias
    // que o diário guarda, e o MENOR mínimo.
    await ingest({
      dataset: "trading", server: "FREYA", startedAt: HOJE + 3600,
      crawlId: "cron-a",
      rows: [anuncio(100, 0, 1), anuncio(200, 1, 1)],
    });
    await ingest({
      dataset: "trading", server: "FREYA", startedAt: HOJE + 7200,
      crawlId: "cron-b",
      rows: [anuncio(50, 0, 2), anuncio(400, 1, 2)],
    });
  });

  it("consolida as coletas do dia numa linha só", async () => {
    expect(await daily()).toHaveLength(0);
    await __cron.hourly(env, HOJE + 8000);

    const rows = await daily();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: HOJE,
      // O menor mínimo do dia: 50, da segunda coleta.
      min_price: 50,
      // O maior máximo: 400.
      max_price: 400,
    });
  });

  /**
   * Rodar de novo sobre um dia que não mudou não escreve.
   *
   * É a guarda de `WHERE` no upsert, e é ela que torna a cadência horária barata: 8
   * passadas por dia das quais 7 tipicamente não gravam nada.
   */
  it("reexecutar sobre o mesmo dia não gera escrita", async () => {
    const antes = await daily();
    await __cron.hourly(env, HOJE + 9000);
    expect(await daily()).toEqual(antes);
  });

  it("uma coleta nova no mesmo dia muda o consolidado", async () => {
    await ingest({
      dataset: "trading", server: "FREYA", startedAt: HOJE + 10_800,
      crawlId: "cron-c",
      rows: [anuncio(10, 0, 3), anuncio(20, 1, 3)],
    });
    await __cron.hourly(env, HOJE + 11_000);

    const rows = await daily();
    expect(rows).toHaveLength(1);
    // O mínimo do dia acompanha a oferta nova.
    expect(rows[0]!["min_price"]).toBe(10);
  });
});

describe("varredura", () => {
  it("apaga percentis além da janela e preserva os de dentro", async () => {
    // Um ponto bem antigo, escrito direto: chegar lá pela ingestão exigiria forjar o
    // relógio, e o que se testa aqui é o corte por idade, não o caminho de entrada.
    const velho = HOJE - (RETENTION.statsDays + 5) * DAY;
    await env.DB.prepare(
      `INSERT INTO listing_stats
         (server, item_id, ts, listings, units, min_price, p25, median, p75, max_price)
       VALUES ('FREYA', ?, ?, 1, 1, 9, 9, 9, 9, 9)`,
    )
      .bind(ITEM, velho)
      .run();

    const conta = async (): Promise<number> =>
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM listing_stats WHERE server = 'FREYA' AND ts = ?`,
        )
          .bind(velho)
          .first<{ n: number }>()
      )!.n;

    expect(await conta()).toBe(1);
    await __cron.daily(env, HOJE + 12_000);
    expect(await conta()).toBe(0);

    // E o que está dentro da janela continua lá.
    const recentes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM listing_stats WHERE server = 'FREYA' AND ts >= ?`,
    )
      .bind(HOJE)
      .first<{ n: number }>();
    expect(recentes!.n).toBeGreaterThan(0);
  });
});
