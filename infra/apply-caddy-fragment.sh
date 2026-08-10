#!/usr/bin/env bash
#
# Ativa o fragmento do Caddy deste projeto: compara infra/caddy/latam-market.caddy (que o
# deploy já rsyncou para /opt/latam-market) com o que está em /etc/caddy/conf.d/ e, se
# mudou, valida, recarrega e desfaz se a validação falhar.
#
# Existe porque /etc/caddy/conf.d/ é o único pedaço de infra que o rsync do deploy NÃO
# ativa — ele mora fora de /opt. Era copiado à mão, e a janela entre o push e a cópia
# deixou a raiz em 404 na 0.3.0: o serviço subiu com a interface nova e o Caddy continuou
# mandando `/` para o Node.
#
# Chamado pelo passo "Aplicar o fragmento do Caddy" do .github/workflows/deploy.yml, e
# seguro de rodar à mão — SEM sudo, que ele já pede onde precisa. Rodar o script inteiro
# como root muda o `~` do backup de /home/ubuntu para /root:
#
#   /opt/latam-market/infra/apply-caddy-fragment.sh
#
# Aceita um caminho alternativo como $1, útil para testar um fragmento candidato antes de
# ele existir em /opt. Idempotente: sem mudança no fragmento, não recarrega nada.
set -euo pipefail

ATIVO=/etc/caddy/conf.d/latam-market.caddy
NOVO=${1:-/opt/latam-market/infra/caddy/latam-market.caddy}
BAK=~/latam-market.caddy.bak

test -s "$NOVO"

# Sem reload quando nada mudou: este Caddy serve outros três sites, e um reload à toa em
# todo push é risco sem motivo.
if cmp -s "$NOVO" "$ATIVO"; then
  echo "fragmento inalterado; nada a fazer"
  exit 0
fi

echo "fragmento mudou:"
diff -u "$ATIVO" "$NOVO" || true

# O `root` da interface tem de existir ANTES do reload — o Caddy não confere ao carregar,
# e sem o diretório a raiz responde 404. Idempotente: numa máquina que já teve deploy da
# web, o index real fica no lugar.
sudo install -d -o ubuntu -g ubuntu /opt/latam-market-web
test -s /opt/latam-market-web/index.html || \
  printf "%s" '<!doctype html><meta charset="utf-8"><title>latam-market</title>' \
    | sudo tee /opt/latam-market-web/index.html >/dev/null

# Numa máquina nova não há o que salvar, e aí o desfazer é remover.
if [ -f "$ATIVO" ]; then
  sudo cp "$ATIVO" "$BAK"
else
  rm -f "$BAK"
fi
sudo cp "$NOVO" "$ATIVO"

# Valida ANTES de recarregar, e desfaz se não passar: um `import` inválido derruba os
# quatro sites de uma vez, então o Caddy em execução nunca chega a ver um arquivo que não
# passou daqui.
if ! sudo caddy validate --config /etc/caddy/Caddyfile; then
  # O validate cobre o /etc/caddy/Caddyfile inteiro, e não só este fragmento: se o erro
  # acima apontar para outro site da máquina, o problema não é deste deploy.
  echo "fragmento invalido; restaurando o anterior e falhando"
  if [ -f "$BAK" ]; then
    sudo cp "$BAK" "$ATIVO"
  else
    sudo rm -f "$ATIVO"
  fi
  exit 1
fi

# `reload` e nunca `restart`: restart derruba os outros três sites. O systemctl só volta
# quando o Caddy adotou (ou recusou) a configuração, então o código de saída basta — quem
# confere o resultado de verdade é o infra/smoke.sh, logo depois.
sudo systemctl reload caddy
echo "fragmento aplicado e Caddy recarregado"
