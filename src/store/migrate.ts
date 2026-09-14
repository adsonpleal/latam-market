/**
 * Migrações do schema: os arquivos de `migrations/`, na ordem, uma vez cada.
 *
 * `PRAGMA user_version` guarda quantos arquivos já foram aplicados — é o lugar canônico do
 * SQLite para versionar schema, e não custa tabela.
 *
 * O banco de produção nasceu no D1 e veio para cá por export. O D1 não usa `user_version`:
 * guarda as migrações aplicadas numa tabela `d1_migrations`. Um banco importado chega com
 * `user_version = 0` e o schema já criado, então a primeira abertura conta o que a tabela do
 * D1 registrou, adota esse número e a descarta.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { transact } from "./db.js";

const FILE = /^(\d{4})_.+\.sql$/;

export function migrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => FILE.test(f))
    .sort();
}

export function migrate(db: DatabaseSync, dir: string): { from: number; to: number } {
  const files = migrationFiles(dir);
  let current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

  if (current === 0 && hasTable(db, "d1_migrations")) {
    const applied = new Set(
      (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name),
    );
    // Conta só o prefixo contíguo: uma migração faltando no meio tem que rodar aqui.
    while (current < files.length && applied.has(files[current]!)) current++;
    db.exec("DROP TABLE d1_migrations");
    db.exec(`PRAGMA user_version = ${current}`);
  }
  // Tabelas internas do D1 que um export pode trazer. Não são nossas.
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_cf\\_%' ESCAPE '\\'")
    .all() as { name: string }[]) {
    db.exec(`DROP TABLE "${name}"`);
  }

  if (current > files.length) {
    throw new Error(
      `banco na versão ${current}, mais nova que as ${files.length} migrações conhecidas. ` +
        `Atualize o servidor ou aponte DB_PATH para outro arquivo.`,
    );
  }

  const from = current;
  for (let i = current; i < files.length; i++) {
    const sql = readFileSync(resolve(dir, files[i]!), "utf8");
    transact(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
  }
  return { from, to: files.length };
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}
