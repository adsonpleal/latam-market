/**
 * Abertura e configuração do banco.
 *
 * `node:sqlite` é síncrono e mora dentro do binário do Node — sem módulo nativo, o
 * deploy continua sendo "um .mjs e pronto". Em compensação, toda escrita bloqueia a
 * thread: por isso o crawl roda num worker (ver src/worker/) e a thread principal só lê.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./paths.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/**
 * `node:sqlite` carregado por `createRequire` em vez de `import`.
 *
 * Por ser experimental, o módulo não aparece em `module.builtinModules`, e o Vite
 * (que o Vitest usa) decide o que é embutido consultando essa lista. Com um import
 * estático ele tenta resolver um pacote chamado "sqlite", não acha, e todo teste que
 * toque no banco falha antes de rodar. Um `require` dinâmico não é analisável
 * estaticamente, então passa direto para o Node — que sabe atendê-lo. O esbuild, que
 * externaliza qualquer `node:` sozinho, não se importa com a diferença.
 */
const { DatabaseSync: Database } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * Caminho do banco.
 *
 * Em produção aponta para /var/lib/latam-market/market.db, FORA de /opt/latam-market,
 * porque o deploy faz `rsync --delete` no /opt e levaria o histórico junto.
 */
export const DB_PATH = process.env["DB_PATH"] ?? resolve(DATA_DIR, "market.db");

export interface OpenOptions {
  path?: string;
}

export function openDb(opts: OpenOptions = {}): DatabaseSync {
  const path = opts.path ?? DB_PATH;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);

  // auto_vacuum só pega efeito se vier ANTES do primeiro CREATE TABLE do arquivo.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  // WAL é o que deixa a API ler sem esperar o worker terminar a transação.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  // 32 MB de cache e 256 MB de mmap: a máquina é compartilhada, não dá para ser guloso.
  db.exec("PRAGMA cache_size = -32000");
  db.exec("PRAGMA mmap_size = 268435456");

  migrate(db);
  return db;
}

/**
 * Cria o schema e aplica migrações.
 *
 * `user_version` é um inteiro guardado no header do arquivo — é o lugar canônico do
 * SQLite para versionar schema, e não custa uma tabela.
 */
function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);

  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `banco na versão ${current}, mais nova que a suportada (${SCHEMA_VERSION}). ` +
        `Atualize o servidor ou aponte DB_PATH para outro arquivo.`,
    );
  }

  // v2: classificação de item (tipo e slot de equipamento) na tabela `item`.
  //
  // `CREATE TABLE IF NOT EXISTS` acima não altera tabela existente, então um banco já
  // criado na v1 precisa das colunas por ALTER. As duas nascem NULL e são preenchidas
  // no `loadCatalogue` seguinte, que roda a cada boot.
  if (current > 0 && current < 2) {
    for (const column of ["item_type TEXT", "equip_slots TEXT"]) {
      try {
        db.exec(`ALTER TABLE item ADD COLUMN ${column}`);
      } catch {
        // Coluna já existe: banco criado do zero com o schema novo, ou migração
        // repetida. Ambos são estados válidos.
      }
    }
    // As colunas nascem NULL e quem as preenche é o `loadCatalogue`, que o boot pula
    // quando o carimbo do catálogo não mudou (ver `syncCatalogue` em server/index.ts).
    //
    // Hoje o carimbo já embute a TAXONOMY_VERSION, num formato que nenhum banco v1
    // poderia ter gravado, então a recarga aconteceria de qualquer jeito. Isto fica
    // como cinto e suspensório: se um dia a versão sair do carimbo, esta linha é o que
    // impede a coluna nova de ficar vazia até o próximo deploy que mexa no catálogo.
    db.exec(`DELETE FROM meta WHERE key = 'catalogue_stamp'`);
  }

  // v3: o mercado deixou de ser de um servidor só.
  //
  // Os três rollups tinham chave sem servidor — `(item_id, ts)` —, então NIDHOGG não
  // conviveria com FREYA: sobrescreveria. Como são WITHOUT ROWID, mudar a chave exige
  // recriar e copiar; `ALTER TABLE` não altera chave primária.
  //
  // Tudo que existe hoje é FREYA, então a cópia carimba o servidor. E `in_market`,
  // `first_seen` e `last_seen` saem de `item` (que é catálogo do jogo, igual nos dois
  // servidores) para `item_market`, onde são observação por servidor.
  if (current > 0 && current < 3) {
    transact(db, () => {
      db.exec(`
        INSERT OR IGNORE INTO item_market (item_id, server, in_market, first_seen, last_seen)
          SELECT item_id, 'FREYA', in_market, first_seen, last_seen FROM item;

        CREATE TABLE price_point_v3 (
          server TEXT NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
          snapshot_id INTEGER NOT NULL, total_cnt INTEGER, min_price INTEGER,
          max_price INTEGER, avg_price INTEGER,
          PRIMARY KEY (server, item_id, ts)
        ) WITHOUT ROWID;
        INSERT INTO price_point_v3
          SELECT 'FREYA', item_id, ts, snapshot_id, total_cnt, min_price, max_price, avg_price
            FROM price_point;
        DROP TABLE price_point;
        ALTER TABLE price_point_v3 RENAME TO price_point;

        CREATE TABLE listing_stats_v3 (
          server TEXT NOT NULL, item_id INTEGER NOT NULL, ts INTEGER NOT NULL,
          listings INTEGER NOT NULL, units INTEGER NOT NULL, min_price INTEGER NOT NULL,
          p25 INTEGER NOT NULL, median INTEGER NOT NULL, p75 INTEGER NOT NULL,
          max_price INTEGER NOT NULL,
          PRIMARY KEY (server, item_id, ts)
        ) WITHOUT ROWID;
        INSERT INTO listing_stats_v3
          SELECT 'FREYA', item_id, ts, listings, units, min_price, p25, median, p75, max_price
            FROM listing_stats;
        DROP TABLE listing_stats;
        ALTER TABLE listing_stats_v3 RENAME TO listing_stats;

        CREATE TABLE listing_daily_v3 (
          server TEXT NOT NULL, item_id INTEGER NOT NULL, day INTEGER NOT NULL,
          listings INTEGER NOT NULL, units INTEGER NOT NULL, min_price INTEGER NOT NULL,
          p25 INTEGER NOT NULL, median INTEGER NOT NULL, p75 INTEGER NOT NULL,
          max_price INTEGER NOT NULL,
          PRIMARY KEY (server, item_id, day)
        ) WITHOUT ROWID;
        INSERT INTO listing_daily_v3
          SELECT 'FREYA', item_id, day, listings, units, min_price, p25, median, p75, max_price
            FROM listing_daily;
        DROP TABLE listing_daily;
        ALTER TABLE listing_daily_v3 RENAME TO listing_daily;
      `);

      // As colunas de mercado saem de `item` só depois de copiadas acima.
      for (const column of ["in_market", "first_seen", "last_seen"]) {
        try {
          db.exec(`ALTER TABLE item DROP COLUMN ${column}`);
        } catch {
          // Banco novo já nasce sem elas.
        }
      }
    });
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * Roda `fn` numa transação, com rollback em qualquer erro.
 *
 * **Reentrante.** Chamadas aninhadas usam SAVEPOINT em vez de um segundo `BEGIN` —
 * que o SQLite recusa com "cannot start a transaction within a transaction". Isso
 * importa porque funções que já transacionam por dentro (`writeRows`) são chamadas
 * tanto soltas quanto de dentro de um lote maior; sem reentrância, quem compõe as
 * duas descobre o problema só em produção.
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
      // Uma transação já abortada pelo próprio SQLite faz o ROLLBACK falhar;
      // o erro original é o que interessa.
    }
    throw err;
  } finally {
    depth.set(db, level);
  }
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
