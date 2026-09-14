-- Índice da janela de dias em `listing_daily`.
--
-- As duas varreduras de mercado (`core/movers.ts`) filtram por servidor e por uma janela
-- de dias recentes. A chave primária é `(server, item_id, day)`, então o filtro por `day`
-- não usava índice nenhum: cada execução lia o histórico inteiro do servidor (~235 mil
-- linhas em FREYA, e crescendo para sempre). Com `day` logo depois de `server`, a leitura
-- fica do tamanho da janela pedida.
--
-- `item_id` e `median` entram para o índice cobrir as duas consultas sozinho: o `bounds`
-- dos movers e o `AVG(median)` das pechinchas não precisam voltar à tabela.

CREATE INDEX IF NOT EXISTS listing_daily_window ON listing_daily (server, day, item_id, median);
