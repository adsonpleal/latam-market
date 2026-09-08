#!/usr/bin/env bash
#
# As respostas que precisam continuar de pé depois de QUALQUER deploy: o serviço, o MCP, a
# API, a raiz da interface e os cabeçalhos de cache.
#
# Antes tudo isto dividia um bloco do Caddy, e era a ordem dos `handle` ali que garantia que
# um arquivo estático nunca atendesse no lugar da API — nem o Node no lugar da interface. A
# primitiva mudou de nome (`run_worker_first` no wrangler.jsonc) mas o risco é o mesmo, e
# quebra do mesmo jeito: silenciosamente, servindo a coisa errada com 200.
#
# Rode à mão contra qualquer ambiente:
#
#   bash infra/smoke.sh https://latam-market.<subdominio>.workers.dev
set -euo pipefail

BASE="${1:-https://mercado.latam-tools.com.br}"

echo "== $BASE =="

echo -n "healthz... "
curl -sf "$BASE/healthz" | grep -q '"ok":true'
echo "ok"

# Um deploy pode subir e ainda não servir dado nenhum — se o catálogo não chegou como
# asset, `catalogueItems` vem 0 e nenhuma resposta de preço presta.
echo -n "catálogo carregado... "
curl -sf "$BASE/healthz" | grep -qv '"catalogueItems":0'
echo "ok"

# Chamada real ao MCP: prova que o transporte e o registro de ferramentas funcionam, não só
# que a rota existe. É o que pega uma troca de SDK que compila e não serve.
echo -n "mcp tools/list... "
curl -sf -X POST "$BASE/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -q '"get_price"'
echo "ok"

# E uma consulta REST de verdade, que exercita a hidratação do retrato.
echo -n "api /items... "
curl -sf "$BASE/api/v1/items?q=elixir&limit=1" | grep -q '"itemId"'
echo "ok"

# O outro lado da mesma ordenação: a raiz tem de cair no asset estático, não no Worker. Um
# 404 aqui é o roteamento invertido — foi exatamente o que aconteceu na 0.3.0, com o Caddy.
echo -n "raiz serve html... "
curl -sfI "$BASE/" | grep -qi 'content-type: text/html'
echo "ok"

# Cache deixou de ser enfeite: sem cabeçalho, toda leitura atravessa até o D1 em `enam` e é
# cobrada. Um deploy que perca isto continua correto e fica caro em silêncio.
echo -n "cache-control nas rotas de mercado... "
curl -sfI "$BASE/api/v1/ids" | grep -qi '^cache-control: public'
echo "ok"

echo -n "etag em /ids... "
curl -sfI "$BASE/api/v1/ids" | grep -qi '^etag:'
echo "ok"

# A ingestão é a única rota que ESCREVE. Sem assinatura ela não pode responder 200 em
# hipótese alguma — um deploy sem o secret configurado responde 503, o que também é aceito
# aqui: o que não pode é passar.
echo -n "ingestão recusa sem assinatura... "
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/internal/ingest" -d '{}')
case "$code" in
  401 | 403 | 503) echo "ok ($code)" ;;
  *)
    echo "FALHOU: /internal/ingest respondeu $code sem assinatura"
    exit 1
    ;;
esac

echo "tudo de pé."
