#!/usr/bin/env bash
#
# Ativa a unit systemd deste projeto: compara infra/latam-market.service (que o deploy já
# rsyncou para /opt/latam-market) com o que está em /etc/systemd/system/ e, se mudou,
# instala, recarrega o systemd e reinicia o serviço.
#
# Existe pelo mesmo motivo do apply-caddy-fragment.sh, e pela mesma pegadinha: o rsync do
# deploy só ativa o que mora em /opt. A unit mora em /etc/systemd/system/, então mexer em
# `ALLOWED_ORIGINS` (ou em qualquer `Environment=`) mudava um arquivo que ia para a
# máquina e nunca era lido — o `systemctl restart` do deploy subia o código novo com o
# ambiente antigo. Foi o que aconteceu na 0.7.0: a rota `/api/v1/ids` respondia 200, e o
# simulador de visuais levava 403 porque a origem dele só estava no arquivo do repositório.
#
# Chamado pelo deploy antes do restart, e seguro de rodar à mão — SEM sudo, que ele já
# pede onde precisa:
#
#   /opt/latam-market/infra/apply-unit.sh
#
# Aceita um caminho alternativo como $1, para testar uma unit candidata. Idempotente: sem
# mudança na unit, não recarrega nem reinicia nada.
set -euo pipefail

ATIVO=/etc/systemd/system/latam-market.service
NOVO=${1:-/opt/latam-market/infra/latam-market.service}

test -s "$NOVO"

if cmp -s "$NOVO" "$ATIVO"; then
  echo "unit inalterada; nada a fazer"
  exit 0
fi

echo "unit mudou:"
diff -u "$ATIVO" "$NOVO" || true

sudo install -m 0644 "$NOVO" "$ATIVO"
sudo systemctl daemon-reload

# Reinicia aqui, e não só no passo seguinte do deploy: rodado à mão, um `daemon-reload`
# sozinho não faz o serviço reler `Environment=` — quem roda isto quer a mudança no ar.
sudo systemctl restart latam-market
echo "unit aplicada e serviço reiniciado"
