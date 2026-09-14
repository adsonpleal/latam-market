/**
 * As migrações sobre um banco novo e sobre o export do D1.
 *
 * O banco de produção chega à VM como o D1 o exportou: schema criado, `user_version` 0 e as
 * migrações registradas numa tabela `d1_migrations`. Rodar as migrações do zero em cima dele
 * falharia no primeiro `ALTER TABLE` que já foi aplicado.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { migrate, migrationFiles } from "../migrate.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};

const DIR = resolve(import.meta.dirname, "..", "..", "..", "migrations");
const version = (db: DatabaseSyncType) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("migrate", () => {
  it("banco novo recebe todas, e rodar de novo não faz nada", () => {
    const db = new DatabaseSync(":memory:");
    expect(migrate(db, DIR)).toEqual({ from: 0, to: migrationFiles(DIR).length });
    expect(migrate(db, DIR)).toEqual({ from: migrationFiles(DIR).length, to: migrationFiles(DIR).length });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'offer'").get()).toBeTruthy();
  });

  it("export do D1: adota o que o d1_migrations registrou e aplica só o resto", () => {
    const files = migrationFiles(DIR);
    const db = new DatabaseSync(":memory:");
    // O que o D1 tinha: as duas primeiras aplicadas, e a tabela que as registra.
    for (const f of files.slice(0, 2)) db.exec(readFileSync(resolve(DIR, f), "utf8"));
    db.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`);
    for (const f of files.slice(0, 2)) db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(f);
    db.exec(`CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)`);

    expect(migrate(db, DIR)).toEqual({ from: 2, to: files.length });
    expect(version(db)).toBe(files.length);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('d1_migrations', '_cf_KV')").all()).toEqual([]);
  });

  it("banco mais novo que o código é recusado", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA user_version = 999");
    expect(() => migrate(db, DIR)).toThrow(/mais nova/);
  });
});
