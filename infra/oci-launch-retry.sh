#!/usr/bin/env bash
# Pega a instância A1 quando a capacidade aparecer, em vez de ficar clicando no console.
#
# RODE ISTO NO **OCI CLOUD SHELL** (ícone `>_` no topo do console). Lá o `oci` já vem
# autenticado — nada de chave de API para configurar.
#
#   1. Abra o Cloud Shell
#   2. Cole este arquivo (Ctrl+Shift+V) em `nano launch.sh`, salve
#   3. bash launch.sh
#
# São Paulo tem UM availability domain, então o conselho do console ("tente outro AD")
# não se aplica: só resta esperar a janela abrir. Ela abre por segundos, em horários
# aleatórios, e quem estiver tentando naquele instante leva.
#
# O loop é deliberadamente lento (~1 min). Mais rápido não aumenta a chance e esbarra no
# rate limit da API.

set -uo pipefail

# ── o que criar ───────────────────────────────────────────────────────────────
AD="${AD:-ImLU:SA-SAOPAULO-1-AD-1}"
NAME="${NAME:-latam-market}"
OCPUS="${OCPUS:-2}"
MEM_GB="${MEM_GB:-4}"          # 4 e não 12 de propósito: a Oracle recupera instância
                               # cujo uso de memória fica abaixo de 20% por 7 dias.
BOOT_GB="${BOOT_GB:-50}"
SSH_PUB="${SSH_PUB:-ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIy0CN9gPNB7CZl+fIBTSzubc8g+cBaJSq7AXdYnZXA2 latam-market-oracle}"

SLEEP_MIN="${SLEEP_MIN:-45}"
SLEEP_MAX="${SLEEP_MAX:-75}"
MAX_TRIES="${MAX_TRIES:-2000}"

# ── descoberta ────────────────────────────────────────────────────────────────
C="${COMPARTMENT_OCID:-${OCI_TENANCY:-}}"
if [ -z "$C" ]; then
  echo "Não achei o compartment. Exporte COMPARTMENT_OCID=ocid1.tenancy... e rode de novo." >&2
  exit 1
fi

if [ -z "${SUBNET_OCID:-}" ]; then
  echo "Procurando subnets públicas…"
  oci network subnet list -c "$C" --all \
    --query 'data[?"prohibit-public-ip-on-vnic"==`false`].{nome:"display-name",cidr:"cidr-block",id:id}' \
    --output table
  SUBNET_OCID=$(oci network subnet list -c "$C" --all \
    --query 'data[?"prohibit-public-ip-on-vnic"==`false`] | [0].id' --raw-output 2>/dev/null)
  [ "$SUBNET_OCID" = "null" ] && SUBNET_OCID=""
fi
if [ -z "$SUBNET_OCID" ]; then
  echo "Nenhuma subnet pública encontrada. Crie a VCN com Internet Gateway antes." >&2
  echo "Ou exporte SUBNET_OCID=ocid1.subnet... da lista acima." >&2
  exit 1
fi

# Filtrar pela shape já devolve só aarch64 — não dá para pegar a imagem x86 por engano.
IMAGE_OCID="${IMAGE_OCID:-$(oci compute image list -c "$C" \
  --operating-system 'Canonical Ubuntu' --operating-system-version '24.04' \
  --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output)}"
IMAGE_NAME=$(oci compute image get --image-id "$IMAGE_OCID" --query 'data."display-name"' --raw-output)

cat <<EOF

  AD .......... $AD
  compartment.. $C
  subnet ...... $SUBNET_OCID
  imagem ...... $IMAGE_NAME
  shape ....... VM.Standard.A1.Flex  ${OCPUS} OCPU / ${MEM_GB} GB
  boot ........ ${BOOT_GB} GB

EOF
read -rp "Confirma? [enter para começar, Ctrl+C para sair] " _

# ── o loop ────────────────────────────────────────────────────────────────────
i=0
while [ "$i" -lt "$MAX_TRIES" ]; do
  i=$((i + 1))
  out=$(oci compute instance launch \
    --availability-domain "$AD" \
    --compartment-id "$C" \
    --subnet-id "$SUBNET_OCID" \
    --image-id "$IMAGE_OCID" \
    --shape VM.Standard.A1.Flex \
    --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}" \
    --boot-volume-size-in-gbs "$BOOT_GB" \
    --display-name "$NAME" \
    --assign-public-ip true \
    --metadata "{\"ssh_authorized_keys\":\"$SSH_PUB\"}" \
    --wait-for-state RUNNING 2>&1)

  if [ $? -eq 0 ]; then
    echo
    echo "PEGOU na tentativa $i."
    ID=$(printf '%s' "$out" | grep -o 'ocid1\.instance\.[a-z0-9._-]*' | head -1)
    oci compute instance list-vnics --instance-id "$ID" \
      --query 'data[0]."public-ip"' --raw-output
    exit 0
  fi

  # "Out of capacity" e "Out of host capacity" são a mesma coisa e são esperadas.
  # Qualquer outro erro é problema de configuração e não melhora com repetição.
  if ! printf '%s' "$out" | grep -qi 'out of.*capacity\|TooManyRequests\|429'; then
    echo
    echo "Parando: este erro não é falta de capacidade." >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi

  printf '\r%s  tentativa %-5d sem capacidade' "$(date +%H:%M:%S)" "$i"
  sleep $((SLEEP_MIN + RANDOM % (SLEEP_MAX - SLEEP_MIN + 1)))
done

echo
echo "Desisti depois de $MAX_TRIES tentativas."
exit 1
