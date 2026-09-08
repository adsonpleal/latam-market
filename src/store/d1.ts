/**
 * Adaptador do D1 para a porta `Db`.
 *
 * Fino de propósito: o D1 já fala SQLite, então não há tradução de dialeto para fazer —
 * `INSERT OR REPLACE`, `WITHOUT ROWID` e funções de janela passam como estão. O que este
 * arquivo resolve é só a forma da API (fluente e assíncrona) contra a da porta.
 *
 * `bind()` só é chamado quando há parâmetro: `prepare(sql).bind()` sem argumentos é um
 * erro no D1 para SQL sem placeholder, e boa parte das consultas de retenção não tem
 * nenhum.
 */

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

import type { SqlParam, SqlStatement, WritableDb } from "./port.js";

const bound = (db: D1Database, sql: string, params: readonly SqlParam[]): D1PreparedStatement => {
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.bind(...params) : stmt;
};

export function d1Db(db: D1Database): WritableDb {
  return {
    async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
      const { results } = await bound(db, sql, params).all<T>();
      return results ?? [];
    },
    async first<T>(sql: string, ...params: SqlParam[]): Promise<T | null> {
      return await bound(db, sql, params).first<T>();
    },
    async run(sql: string, ...params: SqlParam[]): Promise<number> {
      const { meta } = await bound(db, sql, params).run();
      return meta.changes ?? 0;
    },
    async batch(statements: readonly SqlStatement[]): Promise<void> {
      if (statements.length === 0) return;
      // O `batch` do D1 é UMA transação: se qualquer statement falhar, nada é gravado.
      // É a garantia em que a ingestão se apoia para nunca publicar snapshot pela metade.
      await db.batch(statements.map((s) => bound(db, s.sql, s.params ?? [])));
    },
  };
}
