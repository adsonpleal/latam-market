#!/usr/bin/env bash
#
# Preparo de uma vez só da VM para o serviço (rodar na máquina, com sudo disponível).
# Idempotente: rodar de novo não refaz o que já está feito.
#
#   bash infra/vm-prep.sh
set -euo pipefail

echo "== swap"
# A VM tem ~950 MB e nenhum swap. Um pico de memória sem swap é o OOM matando o serviço; com
# swap é lentidão por alguns segundos. `swappiness` baixo para só usar quando precisar.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/90-latam-market.conf >/dev/null
sudo sysctl -q -p /etc/sysctl.d/90-latam-market.conf
swapon --show

echo "== sqlite3 (backup e carga inicial)"
command -v sqlite3 >/dev/null || sudo apt-get install -y -q sqlite3

echo "== node"
node -e "require('node:sqlite'); console.log('node', process.version, 'com node:sqlite')"

echo "== diretórios"
sudo install -d -o ubuntu -g ubuntu /opt/latam-market /var/lib/latam-market /var/lib/latam-market/import

echo "== memória agora"
free -m
