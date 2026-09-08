/**
 * Adaptador de `node:sqlite` para a porta `Db`.
 *
 * Serve dois usuários que continuam em Node depois da migração: o shipper, que roda no
 * EC2 ao lado do coletor, e os testes de unidade de `core/`, que não precisam subir um
 * Worker para conferir uma consulta de histórico.
 *
 * As promessas já vêm resolvidas: o SQLite embutido é síncrono e não há o que aguardar.
 * O `async` está aqui só para a assinatura bater com a do D1.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Db, SqlParam, SqlStatement, WritableDb } from "./port.js";
import { transact } from "./db.js";

export function sqliteDb(db: DatabaseSync): WritableDb {
  return {
    async all<T>(sql: string, ...params: SqlParam[]): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async first<T>(sql: string, ...params: SqlParam[]): Promise<T | null> {
      return (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
    },
    async run(sql: string, ...params: SqlParam[]): Promise<number> {
      return Number(db.prepare(sql).run(...(params as never[])).changes);
    },
    async batch(statements: readonly SqlStatement[]): Promise<void> {
      transact(db, () => {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as never[]));
      });
    },
  } satisfies Db & WritableDb;
}
