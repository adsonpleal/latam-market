# Desligamento da VM

> **2026-09-15.** O site oficial do mercado do RO LATAM pôs proteção contra robôs da
> Cloudflare na frente das páginas, e a coleta feita pelo servidor ficou bloqueada de vez.
> A API pública e o MCP foram aposentados. O que sobrou — busca no catálogo e leitura de
> replay — passou para o navegador: o catálogo virou JSON estático e o `.rrf` é lido pelo
> `rrfparser` na própria página. Sem processo para rodar, o site vai para o **Cloudflare
> Pages**, e a VM da Oracle Cloud deixa de ter função.

O repositório já está do lado novo: o `deploy.yml` publica `web/dist` no Pages e não sabe
mais que a VM existe. O que sobra é o que nenhum workflow alcança — o projeto no Pages, o
domínio, o banco guardado na VM, a própria VM e os IPs dela. Os passos abaixo são manuais,
feitos **uma vez**, **na ordem**: cada um conta com o anterior pronto, e os que destroem
alguma coisa ficam por último.

Marcações:

- **Cloudflare** = painel da Cloudflare (dash.cloudflare.com)
- **Zero Trust** = painel do Zero Trust (one.dash.cloudflare.com)
- **GitHub** = configurações do repositório (este, salvo quando diz "coletor")
- **VM** = na máquina (`ssh ubuntu@<host>`)
- **OCI** = console da Oracle Cloud
- **claude.ai** = configurações da conta

Até o passo 4 o domínio continua servido pela VM e nada fica fora do ar. A troca acontece
inteira no passo 4.

## 1. Criar o projeto no Pages — Cloudflare

*Workers & Pages* → *Create* → aba *Pages* → **Upload assets** (direct upload, *não*
"Connect to Git").

- Nome do projeto: **`latam-market`** — exatamente esse, é o `--project-name` do workflow.
- O painel pede um primeiro upload para criar o projeto. Qualquer coisa serve (um
  `web/dist` gerado local com `pnpm --filter web build`, ou uma pasta com um `index.html`
  qualquer): o workflow sobrescreve no passo 3.
- *Settings* → *Builds & deployments*: **Production branch = `main`**. É o nome que o
  workflow passa em `--branch`; se não bater, todo deploy vira preview e a produção nunca
  muda.

Não configure build no painel: quem builda é o GitHub Actions.

## 2. Token e secrets — Cloudflare, depois GitHub

**Cloudflare** → ícone do perfil → *My Profile* → *API Tokens* → *Create Token* →
*Create Custom Token*:

| Campo | Valor |
|---|---|
| Nome | `latam-market deploy (GitHub Actions)` |
| Permissões | **Account › Cloudflare Pages › Edit** — só essa |
| Account Resources | *Include* → a conta que tem o projeto |
| Zone Resources | nenhuma (não aparece se não houver permissão de zona) |

Copie o token: ele só é mostrado uma vez. O **Account ID** está na URL do painel
(`dash.cloudflare.com/<account id>/...`) ou na barra lateral da página de qualquer zona.

**GitHub** → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*:

- `CLOUDFLARE_API_TOKEN` = o token
- `CLOUDFLARE_ACCOUNT_ID` = o id da conta

`DISCORD_BOT_TOKEN` e a variável `DISCORD_CHANNEL_ID` continuam como estão.

## 3. Primeiro deploy e conferência — GitHub, depois navegador

*Actions* → *Deploy* → *Run workflow* na `main`. Tem que sair verde, com o passo
"Publicar no Cloudflare Pages" mostrando a URL do deploy.

Em **`https://latam-market.pages.dev`** (a URL de produção, sem hash na frente), confira
com a mão:

- **Busca**: digitar um nome sem acento (`poring`) e um id (`502`) — os dois acham.
- **Favoritos**: favoritar um item, recarregar a página, ele continua lá.
- **Replay**: subir um `.rrf` (sem um à mão, serve
  `web/src/lib/replay/__tests__/fixtures/equip-test-2.rrf`). O inventário tem
  que aparecer com nomes e slots, e a aba *Rede* do DevTools não pode mostrar o arquivo
  saindo — nenhum POST.
- **Deep link**: abrir `https://latam-market.pages.dev/favoritos` direto, numa aba nova.
  Tem que abrir a página de favoritos, não um 404. Isso depende de **não** existir
  `404.html` no `dist`: sem ele o Pages serve o `index.html` para rota desconhecida.
- **Cabeçalhos**: `curl -sI https://latam-market.pages.dev/assets/<algum>.js` traz
  `cache-control: public, max-age=31536000, immutable`, e o `/` traz
  `max-age=0, must-revalidate` — é o `web/public/_headers` sendo aplicado.

Se algo aqui falhar, **pare**: o domínio ainda aponta para a VM e ninguém percebeu nada.

## 4. Desligar o deploy do coletor — GitHub (repositório do coletor)

*Actions* → workflow de deploy → **Disable workflow**.

Ele reinstala o drop-in `/etc/systemd/system/latam-market.service.d/collector.conf` na VM
a cada push. Com a VM indo embora isso parece irrelevante, mas até o passo 8 ela ainda
existe, e um deploy do coletor no meio do caminho religa uma unit que você acabou de parar.
Quando a VM sumir, o workflow só falharia no SSH — desabilitado, nem tenta.

## 5. Trocar o domínio — Cloudflare

O `mercado.latam-tools.com.br` hoje é um CNAME criado pelo túnel. O Pages não adiciona um
domínio que já tem registro apontando para outro lugar, então a ordem é: soltar do túnel,
prender no Pages. Entre os dois o domínio fica fora do ar por um ou dois minutos.

1. *Networking* → **Tunnels** → túnel `latam-market` → *Published application routes* →
   remover a rota `mercado.latam-tools.com.br`.
2. Zona `latam-tools.com.br` → *DNS* → *Records*: se o CNAME `mercado` →
   `<id>.cfargotunnel.com` continuar lá depois de tirar a rota, apague.
3. *Workers & Pages* → `latam-market` → *Custom domains* → **Set up a custom domain** →
   `mercado.latam-tools.com.br`. Como a zona já está na Cloudflare, o painel cria o CNAME
   para `latam-market.pages.dev` sozinho e emite o certificado.
4. Espere o domínio ficar **Active** e repita as conferências do passo 3 em
   `https://mercado.latam-tools.com.br`. O `/healthz` e o `/api/v1/items` agora devolvem a
   própria interface (é o fallback de SPA) — esperado.

Ainda na zona, *Caching* → **Cache Rules**: a regra "latam-market: API e arquivos gerados
seguem o cache-control da origem" (a que deixava `/mcp` e o HTML de fora) não tem mais
origem para seguir. O Pages aplica o `_headers` por conta própria; **pode apagar a regra**.

## 6. Tirar os dados da VM — VM, depois sua máquina

> **Este é o único passo que não tem volta depois do passo 8.**
> `/var/lib/latam-market/market.db` é **o histórico inteiro de preços** — tudo o que a
> coleta juntou desde o começo do projeto, FREYA e NIDHOGG, e não existe cópia em outro
> lugar. As cópias em `/var/lib/latam-market/backup/` moram **no mesmo disco**. Terminar a
> instância apaga o volume de boot, e com ele os dois.

Cópia consistente do banco, sem precisar parar nada (o `.backup` do `sqlite3` lida com o
WAL):

```bash
sudo sqlite3 /var/lib/latam-market/market.db ".backup '/home/ubuntu/market-final.db'"
sudo sqlite3 /home/ubuntu/market-final.db 'PRAGMA integrity_check;'   # tem que dizer: ok
sudo tar -czf /home/ubuntu/latam-market-backup.tar.gz -C /var/lib/latam-market backup
sudo chown ubuntu:ubuntu /home/ubuntu/market-final.db /home/ubuntu/latam-market-backup.tar.gz
ls -lh /home/ubuntu/market-final.db /home/ubuntu/latam-market-backup.tar.gz
```

Alternativa sem `sqlite3`: `sudo systemctl stop latam-market` primeiro e aí copiar
`market.db` **junto com** `market.db-wal` e `market.db-shm`, se existirem. Copiar só o
`.db` com o processo de pé pode levar um arquivo sem as últimas escritas.

Na **sua máquina**:

```bash
scp ubuntu@<host>:market-final.db ubuntu@<host>:latam-market-backup.tar.gz .
```

Confira o tamanho contra o `ls -lh` de cima e abra o banco local
(`sqlite3 market-final.db 'select count(*) from sqlite_master;'`) antes de seguir. Guarde
em algum lugar que não seja só este computador (disco externo, nuvem pessoal).

## 7. Parar os serviços — VM, depois Zero Trust

```bash
sudo systemctl disable --now latam-market latam-market-backup.timer cloudflared
systemctl is-active latam-market latam-market-backup.timer cloudflared   # inactive x3
```

Com o domínio já no Pages (passo 5), parar o `cloudflared` não derruba nada público. Se
alguma unit não existir mais (o backup timer pode já ter sido desabilitado antes), o
`systemctl` avisa e segue com as outras.

**Zero Trust** → *Networks* → *Tunnels* (ou **Cloudflare** → *Networking* → *Tunnels*) →
túnel `latam-market` → *Delete*. O painel recusa enquanto houver conector ativo; com o
`cloudflared` parado ele fica *Inactive* em alguns segundos. Apagar o túnel invalida o
token que estava instalado na VM.

## 8. Encerrar a VM e soltar os IPs — OCI

Só depois de o passo 6 estar conferido na sua máquina.

1. *Compute* → *Instances* → `latam-market` → *More actions* → **Terminate**. Marque
   **"Permanently delete the attached boot volume"**.
2. **IPs públicos reservados.** A coleta rodava por 31 IPs públicos *secundários*
   reservados, além do primário. IP **reservado** não morre com a instância: ao terminá-la
   ele só é desassociado, e continua existindo — contando contra a cota da tenancy e,
   passando do que o Free Tier cobre, cobrando. *Networking* → *IP management* →
   **Reserved public IPs**: selecione todos que eram da VM (devem aparecer como
   *Available*, sem VNIC associada) → *Terminate*. Confira que a lista termina vazia, ou só
   com IPs de outra coisa que você reconheça.
3. *Storage* → *Block Storage* → **Boot volumes**: se o da `latam-market` ainda estiver lá
   (a caixa do item 1 desmarcada, ou a exclusão falhou), *Terminate*. Veja também
   *Block volumes* e *Boot volume backups* por sobras com o mesmo nome.
4. Opcional: a VCN, a subnet e as security lists criadas para a VM não custam nada, mas
   podem sair (*Networking* → *Virtual cloud networks* → a VCN → *Terminate*, que leva o
   que está dentro).

## 9. Remover o conector MCP — claude.ai

*Settings* → *Connectors* → remover o que aponta para
`https://mercado.latam-tools.com.br/mcp`. O caminho agora devolve a interface web, e um
agente que ainda o tiver configurado só recebe HTML.

## 10. Apagar os secrets velhos — GitHub

*Settings* → *Secrets and variables* → *Actions*: apagar **`DEPLOY_SSH_KEY`** e
**`DEPLOY_HOST`**. O workflow não os lê mais, e a chave dava SSH numa máquina que não existe
— melhor não deixar credencial órfã. Se o repositório do coletor tiver os seus próprios
(`DEPLOY_*` ou parecidos), apague lá também.

A chave privada correspondente, se ainda estiver guardada em algum lugar local, pode ir
junto.
