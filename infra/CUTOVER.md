# Virada da Cloudflare para a VM

O serviço sai do Worker (D1 + R2) e passa a rodar inteiro na VM da OCI: um processo Node com
SQLite local, atrás de um túnel da Cloudflare. A coleta sobe junto, com publicação por item e
cadência de 10 minutos. Não há usuários reais ainda, então a janela de indisponibilidade é
aceita e nada fica na Cloudflare para reversão — a reversão é o export guardado no passo 3.

Marcações: **VM** = na máquina (`ssh ubuntu@<host>`), **CI** = workflow do GitHub,
**Dashboard** = painel da Cloudflare.

## 0. Preparo (uma vez)

**VM**:

```bash
bash /opt/latam-market/infra/vm-prep.sh     # swap, sqlite3, diretórios
```

(Na primeira vez o `/opt/latam-market` ainda não existe: rode o script a partir de um clone,
ou depois do primeiro deploy do serviço, que o cria.)

**Dashboard** — Zero Trust → Networks → Tunnels → *Create a tunnel* (cloudflared), nome
`latam-market`. Copie o comando de instalação que ele mostra e rode na **VM**:

```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared noble main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
sudo cloudflared service install <TOKEN-DO-PAINEL>
```

No túnel, adicione o *Public Hostname* temporário:
`mercado-vm.latam-tools.com.br` → `HTTP` → `127.0.0.1:8788`.

**Dashboard** — Caching → Cache Rules (três regras):

1. `(http.host in {"mercado.latam-tools.com.br" "mercado-vm.latam-tools.com.br"} and starts_with(http.request.uri.path, "/api/v1/"))`
   → *Eligible for cache*; Edge TTL: *Use cache-control header if present, bypass cache if not*;
   Browser TTL: *Respect origin*.
2. Mesmos hosts e `starts_with(http.request.uri.path, "/assets/") or starts_with(http.request.uri.path, "/generated/")`
   → *Eligible for cache*, respeitando a origem.
3. Mesmos hosts e `http.request.uri.path in {"/mcp" "/healthz"}` → *Bypass cache*.

O servidor já manda `cloudflare-cdn-cache-control` para a borda; sem a regra 1 a Cloudflare
não guarda JSON e toda leitura chega à VM.

## 1. Conferir a VM antes de virar

Depois do deploy do serviço (push na `main`), com o banco ainda vazio:

```bash
bash infra/smoke.sh https://mercado-vm.latam-tools.com.br
curl -sI https://mercado-vm.latam-tools.com.br/api/v1/ids | grep -i cf-cache-status   # 2ª vez: HIT
```

## 2. Parar a coleta antiga

**VM**:

```bash
sudo systemctl disable --now latam-market-shipper
```

A partir daqui o Worker serve o último mercado que recebeu, parado.

## 3. Exportar

**CI** — Actions → *Exportar da Cloudflare* → *Run workflow*. Ao terminar, a VM tem em
`/var/lib/latam-market/import/`: `d1.sql.gz`, `FREYA.json.gz`, `NIDHOGG.json.gz`. O mesmo
conjunto fica 7 dias como artefato do workflow.

## 4. Carregar

**VM**:

```bash
cd /var/lib/latam-market
sudo systemctl stop latam-market
mv market.db market.vazio.db 2>/dev/null || true
rm -f market.db-wal market.db-shm
zcat import/d1.sql.gz | sqlite3 market.db
node /opt/latam-market/dist/import-cloudflare.mjs \
  --db market.db --migrations /opt/latam-market/migrations \
  --blob FREYA=import/FREYA.json.gz --blob NIDHOGG=import/NIDHOGG.json.gz
sudo systemctl start latam-market
curl -s -H 'Host: mercado.latam-tools.com.br' http://127.0.0.1:8788/healthz | head -c 400
```

O `healthz` tem que mostrar `itensComOferta` na casa dos milhares nos dois servidores.

## 5. Coleta nova

Push na `main` do **coletor** (a porta v2 está pronta lá). O deploy dele move o drop-in para
a `latam-market` e reinicia a unit. Só faz isso porque o passo 2 desabilitou o shipper:
enquanto ele estiver habilitado, o coletor fica nele. No journal:

```bash
journalctl -u latam-market -f | grep -E '\[crawl\]|\[egress\]'
```

Espere `[crawl] agendado: FREYA trading a cada 10min, NIDHOGG trading a cada 10min` e, em
poucos minutos, `[crawl] trading/FREYA: N itens publicados`.

## 6. Virar o domínio

**Dashboard** — Workers & Pages → `latam-market` → Settings → Domains & Routes → remova
`mercado.latam-tools.com.br`. Depois, no túnel, adicione o *Public Hostname*
`mercado.latam-tools.com.br` → `HTTP` → `127.0.0.1:8788`.

## 7. Conferir

```bash
bash infra/smoke.sh https://mercado.latam-tools.com.br
curl -sI https://mercado.latam-tools.com.br/api/v1/ids | grep -iE 'cf-cache-status|etag|cache-control'
```

E o conector do MCP no claude.ai continua listando as ferramentas.

## 8. Aposentar a Cloudflare

Com o passo 7 verde:

- **Dashboard**: apague o Worker `latam-market`, o banco D1 `latam-market` e o bucket R2
  `latam-market-snapshots`.
- **Dashboard**: tire `mercado-vm.latam-tools.com.br` do túnel.
- **GitHub**: o secret `CLOUDFLARE_API_TOKEN` e as variáveis `CLOUDFLARE_ACCOUNT_ID` e
  `DEPLOY_BASE_URL` só existiam para o Worker e para o export — podem sair depois que o
  artefato do passo 3 não for mais necessário.
- **VM**: `sudo rm -f /etc/systemd/system/latam-market-shipper.service && sudo rm -rf /etc/systemd/system/latam-market-shipper.service.d /opt/latam-market-shipper && sudo systemctl daemon-reload`.

## Depois

Nas primeiras horas, no journal e no `/healthz`:

- `[crawl] ... adiado` acumulando = as coletas não cabem nos 10 minutos;
- `[loop] atraso p99` ou `eventLoopP99Ms` acima de 100 = a ingestão está segurando a API;
- `vmstat 5`, coluna `st` acima de 10% = a VM está sem crédito de CPU;
- `rssMb` subindo sem parar = vazamento.

Qualquer um desses: suba `CRAWL_TRADING_MIN` em `infra/latam-market.service` e faça deploy.
