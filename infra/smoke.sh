#!/usr/bin/env bash
#
# As respostas que precisam continuar de pé depois de QUALQUER mudança no site: o
# serviço, o MCP, a API e a raiz da interface. Todas dividem um bloco do Caddy, e é a
# ordem dos `handle` ali que garante que um arquivo estático nunca atenda no lugar da API
# — nem o Node no lugar da interface.
#
# Vive num script, e não copiado dentro de cada workflow, porque roda nos dois: o deploy
# do serviço (que aplica o fragmento do Caddy) e o da interface. Rode à mão depois de
# todo `systemctl reload caddy` feito fora do CI:
#
#   /opt/latam-market/infra/smoke.sh
#
# `caddy validate` confere a sintaxe do fragmento, não a ordenação — por isso este script
# existe além dele.
set -euo pipefail

BASE="${1:-https://mercado.latam-tools.com.br}"

echo "== $BASE =="

echo -n "healthz... "
curl -sf "$BASE/healthz" | grep -q '"ok":true'
echo "ok"

# Um bundle pode subir e ainda não servir dado nenhum — se o catálogo não chegou,
# `itens` vem 0 e nenhuma resposta de preço presta.
echo -n "catálogo carregado... "
curl -sf "$BASE/healthz" | grep -qv '"itens":0'
echo "ok"

# Chamada real ao MCP: prova que o transporte e o registro de ferramentas funcionam,
# não só que a porta abriu.
echo -n "mcp tools/list... "
curl -sf -X POST "$BASE/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -q '"get_price"'
echo "ok"

# E uma consulta REST de verdade, que exercita o cache do mercado.
echo -n "api /items... "
curl -sf "$BASE/api/v1/items?q=elixir&limit=1" | grep -q '"itemId"'
echo "ok"

# O outro lado da mesma ordenação: a raiz tem de cair no `file_server`, não no Node. Um
# 404 aqui é o fragmento antigo no lugar — foi exatamente o que aconteceu na 0.3.0.
# Confere só o tipo, não o conteúdo: numa máquina nova a raiz é o index de espera, sem
# bundle. Quem valida o bundle de verdade é o passo Verificar do web-deploy.
echo -n "raiz serve html... "
curl -sfI "$BASE/" | grep -qi 'content-type: text/html'
echo "ok"

echo "tudo de pé."
