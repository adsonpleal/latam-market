# Virada da Cloudflare para a VM

> **Feita em 2026-09-14.** Fica como registro de como o serviço chegou aqui e de como
> refazer a parte da infraestrutura se a VM for trocada. O workflow de export e os secrets
> da Cloudflare no GitHub já foram removidos; o export ficou como artefato da execução
> 34893170041 (7 dias).

O serviço sai do Worker (D1 + R2) e passa a rodar inteiro na VM da OCI: um processo Node com
SQLite local, atrás de um túnel da Cloudflare. A coleta sobe junto, com publicação por item e
cadência de 10 minutos. Não há usuários reais ainda, então a janela de indisponibilidade é
aceita e nada fica na Cloudflare para reversão — a reversão é o export guardado no passo 3.

Marcações: **VM** = na máquina (`ssh ubuntu@<host>`), **CI** = workflow do GitHub,
**Dashboard** = painel da Cloudflare.

## 0. Preparo (uma vez) — FEITO em 2026-09-14

Registro do que existe, para refazer se a VM for trocada:

- **VM**: swap de 2 GB, `sqlite3` e `cloudflared` (repositório `pkg.cloudflare.com`,
  `any main`) instalados. O `cloudflared` roda como serviço (`systemctl status cloudflared`),
  instalado com o comando que o painel mostra ao criar o túnel — ele carrega o token do
  túnel, então é colado por quem tem acesso à conta.
- **Dashboard** → Networking → **Tunnels** (no painel principal; não precisa do Zero Trust):
  túnel `latam-market`, rota *Published application*
  `mercado.latam-tools.com.br` → `http://127.0.0.1:8788`. O CNAME foi criado pelo painel. Na
  virada existiu também `mercado-vm`, temporário, já removido.
- **Dashboard** → latam-tools.com.br → Caching → **Cache Rules**, regra
  "latam-market: API e arquivos gerados seguem o cache-control da origem":
  `(http.host eq "mercado.latam-tools.com.br" and (starts_with(http.request.uri.path, "/api/v1/") or starts_with(http.request.uri.path, "/generated/") or starts_with(http.request.uri.path, "/assets/")))`
  → *Eligible for cache*, TTLs no padrão (seguem os cabeçalhos da origem). `/mcp`, `/healthz`
  e o HTML não entram na regra e continuam `DYNAMIC`.

O servidor já manda `cloudflare-cdn-cache-control` para a borda; sem a regra a Cloudflare
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
`mercado.latam-tools.com.br`. Depois, em Networking → Tunnels → `latam-market` → Routes,
adicione a *Published application* `mercado.latam-tools.com.br` → `http://127.0.0.1:8788`.

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
