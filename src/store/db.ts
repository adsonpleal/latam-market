/**
 * Abertura e configuração do banco.
 *
 * `node:sqlite` é síncrono e mora dentro do binário do Node — sem módulo nativo, o deploy
 * continua sendo "um .mjs e pronto". Em compensação toda consulta bloqueia a thread que
 * serve a API, e é por isso que as escritas da ingestão vão em lotes curtos (ver
 * `ingest/session.ts`) e a coleta roda numa worker thread.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrate.js";

/**
 * `node:sqlite` carregado por `createRequire` em vez de `import`.
 *
 * Por ser experimental, o módulo não aparece em `module.builtinModules`, e o Vite (que o
 * Vitest usa) decide o que é embutido consultando essa lista. Com um import estático ele
 * tenta resolver um pacote chamado "sqlite", não acha, e todo teste que toque no banco
 * falha antes de rodar. O esbuild externaliza qualquer `node:` sozinho.
 */
const { DatabaseSync: Database } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface OpenOptions {
  path: string;
  /** Diretório com `NNNN_*.sql`. Ausente: abre sem migrar (ferramentas que só leem). */
  migrationsDir?: string;
}

export function openDb(opts: OpenOptions): DatabaseSync {
  if (opts.path !== ":memory:") mkdirSync(dirname(opts.path), { recursive: true });
  const db = new Database(opts.path);

  // WAL: leitores da API não esperam a transação da ingestão terminar.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // 16 MB de cache de páginas. A VM tem 1 GB e divide com a coleta e o túnel; o que não
  // couber aqui o kernel ainda guarda no cache de arquivo.
  db.exec("PRAGMA cache_size = -16000");
  // Sem mmap: páginas mapeadas contam no `MemoryMax` da unit de um jeito difícil de prever,
  // e o ganho de leitura é pequeno com o cache acima.
  db.exec("PRAGMA mmap_size = 0");
  db.exec("PRAGMA journal_size_limit = 67108864");

  if (opts.migrationsDir) migrate(db, opts.migrationsDir);
  return db;
}

/**
 * Roda `fn` numa transação, com rollback em qualquer erro.
 *
 * **Reentrante.** Chamadas aninhadas usam SAVEPOINT em vez de um segundo `BEGIN` — que o
 * SQLite recusa com "cannot start a transaction within a transaction".
 */
const depth = new WeakMap<DatabaseSync, number>();

export function transact<T>(db: DatabaseSync, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = level > 0 ? `sp_${level}` : null;

  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN");
  depth.set(db, level + 1);

  try {
    const result = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec(savepoint ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      if (savepoint) db.exec(`RELEASE ${savepoint}`);
    } catch {
      // Uma transação já abortada pelo próprio SQLite faz o ROLLBACK falhar; o erro
      // original é o que interessa.
    }
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
