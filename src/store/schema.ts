/**
 * Schema do banco de mercado.
 *
 * Fica como template string, e não num `.sql` lido do disco, porque o servidor é
 * empacotado num único `.mjs` pelo esbuild e enviado sozinho para o EC2 — um arquivo
 * ao lado seria mais uma coisa para o tar não esquecer.
 *
 * Regras que valem para tudo aqui:
 *  - `ts` é sempre epoch em SEGUNDOS (não ms): cabe em INTEGER e simplifica bucketing.
 *  - Leitores só enxergam snapshot com `ok=1`. Um crawl interrompido no meio deixa
 *    linhas gravadas com `ok=0`, invisíveis até ele fechar íntegro.
 *  - As tabelas de rollup são WITHOUT ROWID com PK `(item_id, ts)`: consultar o
 *    histórico de um item vira um range scan em vez de busca por índice secundário.
 */

/** Versão do schema. Suba junto com qualquer migração em `migrate` (ver `db.ts`). */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS snapshot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server      TEXT    NOT NULL,
  dataset     TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  row_count   INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'crawl'
);

CREATE INDEX IF NOT EXISTS snapshot_lookup ON snapshot (server, dataset, ok, started_at DESC);

-- O catálogo é do jogo, não de um servidor: nome, tipo e slots valem para os dois.
-- O que é observação de mercado mora em item_market.
CREATE TABLE IF NOT EXISTS item (
  item_id    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL,
  img_path   TEXT,
  db_type    TEXT,
  slots      INTEGER,
  aegis_name TEXT,
  -- Classificação derivada da descrição do cliente (ver core/taxonomy.ts). Vem do
  -- catálogo, não do mercado, então loadCatalogue é quem preenche.
  item_type   TEXT,
  -- Lista separada por vírgula: um elmo pode ocupar topo e meio ao mesmo tempo.
  equip_slots TEXT
);

CREATE INDEX IF NOT EXISTS item_name_norm ON item (name_norm);

-- "Este item já apareceu no mercado" é um fato POR SERVIDOR: um item pode ser comum
-- em FREYA e nunca ter sido anunciado em NIDHOGG.
CREATE TABLE IF NOT EXISTS item_market (
  item_id    INTEGER NOT NULL,
  server     TEXT    NOT NULL,
  in_market  INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen  INTEGER,
  PRIMARY KEY (item_id, server)
) WITHOUT ROWID;

-- O servidor vem PRIMEIRO na chave, aqui e nos dois rollups abaixo: o histórico de um
-- item é sempre consultado dentro de um servidor, então essa ordem mantém a consulta
-- como um range scan contíguo, que é a razão de estas tabelas serem WITHOUT ROWID.
CREATE TABLE IF NOT EXISTS price_point (
  server      TEXT    NOT NULL,
  item_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  total_cnt   INTEGER,
  min_price   INTEGER,
  max_price   INTEGER,
  avg_price   INTEGER,
  PRIMARY KEY (server, item_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS store (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  seller TEXT NOT NULL,
  UNIQUE (name, seller)
);

CREATE TABLE IF NOT EXISTS listing (
  snapshot_id INTEGER NOT NULL,
  ssi         TEXT    NOT NULL,
  item_id     INTEGER NOT NULL,
  map_id      INTEGER,
  price       INTEGER NOT NULL,
  cnt         INTEGER NOT NULL,
  slot_max    TEXT,
  store_type  TEXT,
  store_id    INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, ssi)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS listing_item ON listing (item_id, snapshot_id, price);

CREATE TABLE IF NOT EXISTS listing_stats (
  server    TEXT    NOT NULL,
  item_id   INTEGER NOT NULL,
  ts        INTEGER NOT NULL,
  listings  INTEGER NOT NULL,
  units     INTEGER NOT NULL,
  min_price INTEGER NOT NULL,
  p25       INTEGER NOT NULL,
  median    INTEGER NOT NULL,
  p75       INTEGER NOT NULL,
  max_price INTEGER NOT NULL,
  PRIMARY KEY (server, item_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS listing_daily (
  server    TEXT    NOT NULL,
  item_id   INTEGER NOT NULL,
  day       INTEGER NOT NULL,
  listings  INTEGER NOT NULL,
  units     INTEGER NOT NULL,
  min_price INTEGER NOT NULL,
  p25       INTEGER NOT NULL,
  median    INTEGER NOT NULL,
  p75       INTEGER NOT NULL,
  max_price INTEGER NOT NULL,
  PRIMARY KEY (server, item_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
