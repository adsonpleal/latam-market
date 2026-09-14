#!/usr/bin/env bash
#
# As respostas que precisam continuar de pé depois de QUALQUER deploy: o serviço, o MCP, a
# API, a raiz da interface e os cabeçalhos de cache.
#
# O que casa com o quê é ordem de `if` em src/app.ts: o que é do serviço vem antes do
# arquivo estático. Quando isso quebra, quebra calado — servindo a coisa errada com 200.
#
# Contra o público, ou contra o processo local passando o Host:
#
#   bash infra/smoke.sh https://mercado.latam-tools.com.br
#   HOST_HEADER=mercado.latam-tools.com.br bash infra/smoke.sh http://127.0.0.1:8788
set -euo pipefail

BASE="${1:-https://mercado.latam-tools.com.br}"
H=()
[ -n "${HOST_HEADER:-}" ] && H=(-H "Host: $HOST_HEADER")

echo "== $BASE =="

echo -n "healthz... "
health=$(curl -sf "${H[@]}" "$BASE/healthz")
grep -q '"ok":true' <<<"$health"
# O processo Node publica memória e atraso do laço; o Worker não publicava. Se isto sumir,
# o domínio está apontando para outra coisa.
grep -q '"rssMb"' <<<"$health"
echo "ok"

# Um deploy pode subir e ainda não servir dado nenhum — sem o catálogo, nenhuma resposta
# de preço presta.
echo -n "catálogo carregado... "
grep -qv '"catalogueItems":0' <<<"$health"
echo "ok"

# Chamada real ao MCP: prova que o transporte e o registro de ferramentas funcionam.
echo -n "mcp tools/list... "
curl -sf "${H[@]}" -X POST "$BASE/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -q '"get_price"'
echo "ok"

# `all=1`: a busca filtra por "já visto no mercado", e um banco recém-criado não viu nada.
echo -n "api /items... "
curl -sf "${H[@]}" "$BASE/api/v1/items?q=elixir&limit=1&all=1" | grep -q '"itemId"'
echo "ok"

# O outro lado da mesma ordem: a raiz cai na interface, não na API.
echo -n "raiz serve html... "
curl -sfI "${H[@]}" "$BASE/" | grep -qi 'content-type: text/html'
echo "ok"

# Um arquivo que não existe não pode virar o HTML da SPA: a borda o guardaria como
# imutável por um ano.
echo -n "asset inexistente é 404... "
code=$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" "$BASE/assets/nao-existe-$$.js")
[ "$code" = "404" ] || { echo "FALHOU: $code"; exit 1; }
echo "ok"

# Sem cabeçalho de cache, toda leitura atravessa até a VM.
echo -n "cache-control nas rotas de mercado... "
curl -sfI "${H[@]}" "$BASE/api/v1/ids" | grep -qi '^cache-control: public'
echo "ok"

echo -n "etag em /ids... "
curl -sfI "${H[@]}" "$BASE/api/v1/ids" | grep -qi '^etag:'
echo "ok"

echo "tudo de pé."
