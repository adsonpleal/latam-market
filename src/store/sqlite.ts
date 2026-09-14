/**
 * Adaptador de `node:sqlite` para a porta `Db`.
 *
 * É o banco de produção: o serviço inteiro roda num processo Node na VM, com o SQLite no
 * disco ao lado. As promessas já vêm resolvidas — o SQLite embutido é síncrono e não há o
 * que aguardar; o `async` está aqui só para `core/` ter uma assinatura só.
 *
 * **Statements preparados ficam guardados**, um por texto de SQL. Preparar custa análise e
 * planejamento a cada chamada, e a ingestão repete as MESMAS dez consultas milhares de
 * vezes por coleta: sem o cache, só o preparo de um lote de ofertas segurava o laço de
 * eventos da API por mais de 100 ms.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { Db, SqlParam, SqlStatement, WritableDb } from "./port.js";
import { transact } from "./db.js";

export function sqliteDb(db: DatabaseSync): WritableDb {
  const statements = new Map<string, StatementSync>();
  const prepared = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (!stmt) statements.set(sql, (stmt = db.prepare(sql)));
    return stmt;
  };

  return {
    async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
      return prepared(sql).all(...(params as never[])) as T[];
    },
    async first<T>(sql: string, ...params: SqlParam[]): Promise<T | null> {
      return (prepared(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    async run(sql: string, ...params: SqlParam[]): Promise<number> {
      return Number(prepared(sql).run(...(params as never[])).changes);
    },
    async batch(list: readonly SqlStatement[]): Promise<void> {
      transact(db, () => {
        for (const s of list) prepared(s.sql).run(...((s.params ?? []) as never[]));
      });
    },
  } satisfies Db & WritableDb;
}
