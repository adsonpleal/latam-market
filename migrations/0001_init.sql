-- Schema inicial no D1.
--
-- Vem do `SCHEMA_SQL` da versão 3 (SQLite no EC2), com as diferenças que a migração
-- justifica, todas anotadas abaixo. As regras de sempre continuam valendo:
--   - `ts` é epoch em SEGUNDOS.
--   - Leitores só enxergam snapshot com `ok = 1`.
--   - Os rollups são WITHOUT ROWID com o servidor na frente da PK: o histórico de um item
--     é sempre consultado dentro de um servidor, e assim vira range scan contíguo. No D1
--     isso também é dinheiro — linha lida é linha VARRIDA, não devolvida.
--
-- O que saiu, e por quê:
--   - `listing` e `store`. Os anúncios crus tinham um leitor só (`listingsOfSnapshot`, em
--     `store/cache.ts`), sempre com o snapshot MAIS RECENTE; os 24 que a retenção guardava
--     nunca eram lidos. No D1 eles custariam ~120 M linhas escritas/mês entre inserção,
--     índice e o DELETE da retenção (que também é cobrado). O snapshot corrente passa a
--     viver como blob no R2, que é a forma que o caminho quente já queria.
--   - `AUTOINCREMENT` em `snapshot.id`. A única coisa que ele garante é não reusar id
--     apagado, e a retenção só apaga id BAIXO, nunca o maior — `max(rowid)+1` basta.
--     De quebra, sai o `sqlite_sequence` do import.
--   - Os índices `listing_item` (tabela foi embora), `item_name_norm` (a busca por nome
--     roda em JS sobre o catálogo em memória, nunca no banco) e `snapshot_lookup` (o
--     snapshot corrente vem do ponteiro no R2, não de uma consulta).

CREATE TABLE IF NOT EXISTS snapshot (
  id          INTEGER PRIMARY KEY,
  server      TEXT    NOT NULL,
  dataset     TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  row_count   INTEGER NOT NULL DEFAULT 0,
  ok          INTEGER NOT NULL DEFAULT 0,
  source      TEXT    NOT NULL DEFAULT 'crawl',
  -- Idempotência da ingestão: o shipper carimba um id por crawl, então reenviar um lote
  -- depois de um timeout devolve o snapshot que já existe em vez de abrir outro. É o que
  -- substitui o `abortSnapshot` — não há mais nada pela metade para abortar.
  crawl_id    TEXT UNIQUE
);

-- O único leitor que sobrou de `snapshot` é o `listSnapshots` (ORDER BY started_at DESC
-- entre os ok=1). Sem índice isso é varredura de uma tabela que só cresce.
CREATE INDEX IF NOT EXISTS snapshot_recent ON snapshot (ok, started_at DESC);

-- O catálogo é do jogo, não de um servidor: nome, tipo e slots valem para os dois.
CREATE TABLE IF NOT EXISTS item (
  item_id     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  name_norm   TEXT NOT NULL,
  img_path    TEXT,
  db_type     TEXT,
  slots       INTEGER,
  aegis_name  TEXT,
  item_type   TEXT,
  -- Lista separada por vírgula: um elmo pode ocupar topo e meio ao mesmo tempo.
  equip_slots TEXT
);

-- "Este item já apareceu no mercado" é um fato POR SERVIDOR.
CREATE TABLE IF NOT EXISTS item_market (
  item_id    INTEGER NOT NULL,
  server     TEXT    NOT NULL,
  in_market  INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen  INTEGER,
  PRIMARY KEY (item_id, server)
) WITHOUT ROWID;

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
