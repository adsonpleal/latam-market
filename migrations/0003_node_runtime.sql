-- O mercado corrente passa a morar no banco.
--
-- No Worker as ofertas de agora eram um blob no R2 por coleta: o D1 cobrava linha escrita,
-- e um isolate não tinha disco. Na VM nenhuma das duas coisas vale, e um arquivo ao lado do
-- banco seria um segundo ponto de gravação — uma queda entre os dois deixaria ofertas e
-- histórico discordando. Aqui elas são gravadas na MESMA transação que as estatísticas.
--
-- E a publicação agora é por item, conforme a coleta anda (ver `ingest/session.ts`). O que
-- era "o retrato da coleta N" vira "cada item com a última observação dele".

-- As ofertas de cada item, na ordem em que são servidas: por preço.
CREATE TABLE IF NOT EXISTS offer (
  server     TEXT    NOT NULL,
  item_id    INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  ssi        TEXT    NOT NULL,
  cnt        INTEGER NOT NULL,
  slot_max   TEXT,
  store_name TEXT    NOT NULL,
  seller     TEXT    NOT NULL,
  map_id     INTEGER,
  PRIMARY KEY (server, item_id, price, ssi)
) WITHOUT ROWID;

-- Quando cada item à venda foi confirmado pela última vez, e por qual coleta. É o que
-- expira um item que deixou de ser decidido (termos falhando coleta após coleta).
CREATE TABLE IF NOT EXISTS offer_item (
  server      TEXT    NOT NULL,
  item_id     INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  snapshot_id INTEGER NOT NULL,
  PRIMARY KEY (server, item_id)
) WITHOUT ROWID;

-- Quanto da coleta foi decidido. Uma coleta com termos falhando continua publicando os
-- itens que completou; estes números dizem quanto ficou de fora.
ALTER TABLE snapshot ADD COLUMN items_complete INTEGER;
ALTER TABLE snapshot ADD COLUMN items_incomplete INTEGER;
ALTER TABLE snapshot ADD COLUMN coverage REAL;

-- O agregado do site da última coleta de market-price, no boot: `WHERE server = ? AND ts = ?`.
-- Sem índice por `ts` a chave `(server, item_id, ts)` obrigaria a varrer dois anos de pontos.
CREATE INDEX IF NOT EXISTS price_point_ts ON price_point (server, ts);
