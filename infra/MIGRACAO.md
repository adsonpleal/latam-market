# Migração do EC2 para a Cloudflare

Sequência para levar o histórico do `market.db` para o D1 e o retrato corrente para o R2.
Cada passo é repetível: toda tabela que atravessa tem chave primária natural, e o
`crawlId` do bootstrap é preso ao snapshot de origem. Reimportar não duplica nada.

## 1. Cópia consistente, sem parar o serviço

Na EC2:

```bash
sqlite3 /var/lib/latam-market/market.db "VACUUM INTO '/tmp/market-snap.db'"
```

`VACUUM INTO` roda dentro de uma transação de leitura: sai consistente contra o WAL de quem
está escrevendo, sem bloquear a coleta, e já entrega um arquivo único (sem `-wal`/`-shm`).
`cp` do arquivo vivo não dá essa garantia.

Traga o arquivo para a máquina de onde o `wrangler` roda:

```bash
scp -i <chave> ubuntu@<host>:/tmp/market-snap.db ./market-snap.db
```

## 2. Projetar no schema novo

```bash
node tools/migrate-to-d1.mjs market-snap.db carga.sql
```

O que o projetor deixa de fora, e por quê, está no cabeçalho dele — em resumo: `listing` e
`store` não vão (viram blob no R2, no passo 4), `listing_stats` vai recortado na mesma
janela da retenção, e `meta` não vai.

Ele imprime a **marca d'água** no fim. Guarde: é o `--since-snapshot` do catch-up.

## 3. Carregar no D1

```bash
npx wrangler d1 migrations apply latam-market --remote
npx wrangler d1 execute latam-market --remote --file=carga.sql
```

Conferir contra a origem — os números têm que bater:

```bash
npx wrangler d1 execute latam-market --remote --command \
  "SELECT 'item' t, COUNT(*) n FROM item
   UNION ALL SELECT 'item_market', COUNT(*) FROM item_market
   UNION ALL SELECT 'price_point', COUNT(*) FROM price_point
   UNION ALL SELECT 'listing_daily', COUNT(*) FROM listing_daily
   UNION ALL SELECT 'listing_stats', COUNT(*) FROM listing_stats"
```

## 4. Reconstruir o retrato no R2

Sem este passo o serviço sobe com histórico completo e mercado vazio — a busca não acha
oferta nenhuma até a primeira coleta pousar.

```bash
INGEST_URL=https://<worker>/internal/ingest \
INGEST_SECRET=<o mesmo do `wrangler secret put`> \
  npx tsx src/cli/bootstrap-blob.ts market-snap.db
```

Entra pela rota real de ingestão de propósito: o formato do blob, o rollup de percentis, a
assinatura e a virada do ponteiro passam a ser exercitados pelo mesmo código que roda para
sempre. Use `--dry-run` antes para ver o que ele mandaria.

## 5. Conferir de ponta a ponta

```bash
bash infra/smoke.sh https://<worker>
curl -s https://<worker>/healthz | jq '{catalogueItems, itensComPreco, itensComOferta}'
```

`itensComOferta` em zero significa que o passo 4 não rodou ou não pegou.

## 6. Catch-up no cutover

Entre o passo 1 e a virada do DNS a EC2 continua coletando. Antes de virar, repita 1–3 com
a marca d'água:

```bash
node tools/migrate-to-d1.mjs market-snap-2.db catchup.sql --since-snapshot <marca>
npx wrangler d1 execute latam-market --remote --file=catchup.sql
```

E rode o passo 4 de novo, para o retrato ser o da última coleta.

> Durante a fase de escrita dupla (o shipper mandando para o Worker enquanto a EC2 ainda
> coleta e serve), a janela que o catch-up cobre é só a diferença entre o `VACUUM INTO` e o
> início da escrita dupla. Nenhuma coleta se perde.

## 7. Escrita dupla (antes do cutover)

Os dois lados precisam receber toda coleta enquanto o domínio ainda aponta para a EC2 — é
isso que mantém o serviço antigo como alvo de rollback ATUALIZADO.

Quem faz isso é a ponte (`infra/latam-market-bridge.{service,timer}`), e ela **não coleta**:
lê o SQLite local em modo somente-leitura e empurra a coleta mais recente de cada
(dataset, servidor) de cinco em cinco minutos. Dois coletores ao mesmo tempo dividiriam a
paciência de rede que o coletor administra sozinho, então quem fala com ele continua sendo o
`latam-market.service`.

```bash
sudo cp infra/latam-market-bridge.{service,timer} /etc/systemd/system/
sudo systemctl edit latam-market-bridge     # Environment=INGEST_SECRET=...
sudo systemctl daemon-reload
sudo systemctl enable --now latam-market-bridge.timer
```

Conferir que os dois lados concordam:

```bash
for s in FREYA NIDHOGG; do
  curl -s "https://mercado.latam-tools.com.br/api/v1/ids?server=$s" | jq -c '[(.inMarket|length),(.forSale|length)]'
  curl -s "https://<worker>/api/v1/ids?server=$s" | jq -c '[(.inMarket|length),(.forSale|length)]'
done
```

A ponte sai de cena junto com o `latam-market.service`, quando o
`latam-market-shipper.service` — que coleta e empurra, sem SQLite no meio — assumir.

## Cuidado ao refazer o bootstrap

Se precisar rodar o passo 4 de novo depois de já ter rodado, **não basta apagar os
snapshots e repetir**. O id do snapshot é recalculado como `MAX(id)+1`, então apagar e
recriar REUSA o mesmo id — e a chave do cache interno é justamente `(servidor, id de
trading, id de market)`. O resultado é o Worker servindo a resposta anterior com dado novo
no banco, por até 5 minutos (o TTL da entrada).

Aconteceu na migração: o `inMarket` de FREYA continuou mostrando 5.497 depois de corrigido
para 6.348, e só uma consulta com parâmetro extra revelou que o dado estava certo. Em
operação normal isso não ocorre — os ids são monotônicos e nunca reusados.

Se refizer: espere os 5 minutos, ou confira com um parâmetro qualquer a mais na URL para
forçar outra chave.

## Reversão

Antes do cutover não há o que reverter: o domínio ainda aponta para a EC2 e o D1 é um banco
que ninguém lê. Depois do cutover, a reversão é trocar o registro de DNS de volta — o
serviço antigo continua de pé e atualizado enquanto a escrita dupla estiver ligada.

**Arquive o `market.db` fora da máquina antes de desligar qualquer coisa.** É a única cópia
do histórico anterior à migração.
