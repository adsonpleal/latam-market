---
name: sync-with-ragassets
description: Atualiza data/latam-items.json a partir das tabelas do cliente publicadas pelo ragassets. Use depois de uma atualização do cliente do RO LATAM, quando um item novo não é encontrado pela busca, ou quando o catálogo parece velho (nome em espanhol, descrição desatualizada).
---

# Sincronizar o catálogo com o ragassets

## Por que isto existe

O serviço busca item por nome, e esse nome vem de `data/latam-items.json` — 14 mil e tantos
itens em pt-BR, versionados no repositório e embarcados no tar do deploy. O arquivo é
vendorizado de propósito: o servidor sobe como um bundle único no EC2 e carrega o catálogo
**antes** de escutar, então buscá-lo na rede no boot amarraria "o mercado está no ar" a "um
segundo host está de pé".

Vendorizar, porém, custa: a cópia envelhece sozinha. A origem é o
[ragassets](https://github.com/adsonpleal/ragassets), que extrai as tabelas do cliente do
jogo e as publica em `https://assets.latam-tools.com.br/raw/`. Uma origem só, sempre atual,
sem checkout vizinho na máquina — antes o catálogo era copiado do checkout do latam-ro-calc
ao lado, o que exigia o irmão presente **e** já atualizado, e deixava o catálogo daqui tão
velho quanto o `git pull` mais antigo dos dois.

## Quando rodar

- Depois de uma atualização do cliente do RO LATAM (itens novos, nomes traduzidos).
- Quando alguém reclamar que a busca não acha um item que existe no jogo.
- Quando um nome sair em espanhol: é sinal de que a tradução chegou ao cliente e não aqui.

Antes de rodar, confira se o ragassets já regerou as tabelas para a versão nova do cliente
— sincronizar contra uma tabela velha não adianta nada.

## Como rodar

```bash
pnpm sync:items
```

Busca `https://assets.latam-tools.com.br/raw/items.json` e reescreve
`data/latam-items.json`. Sem rede, com o ragassets ao lado:

```bash
node tools/sync-items.mjs --input ../ragassets/resources/raw/items.json
```

Também aceita `--url` (outra origem) e `--out` (outro destino). O `LATAM_ITEMS_SOURCE` de
antes saiu: ele apontava para um catálogo já convertido, e a origem agora é a tabela crua
do cliente — o mesmo nome com um conteúdo incompatível daria um erro difícil de entender.

## O que sai

`data/latam-items.json`: um objeto chaveado pelo id do item, JSON compacto, ~6,6 MB.

```json
{"501":{"name":"Poção Vermelha","description":"…","aegisName":"빨간포션"}}
```

`description`, `aegisName` e `slots` são opcionais e **somem** quando vazios (`slots: 0` é
ausência de slot). A ordem das chaves é parte do formato: é ela que faz duas gerações do
mesmo dado saírem byte a byte iguais.

O script imprime a contagem antes e depois, e avisa quando o catálogo novo tem menos itens
que o anterior — o que quase sempre quer dizer que a origem estava pela metade.

## Como conferir

```bash
git diff --stat data/latam-items.json
```

- **Sem diff** é o esperado quando o cliente não mudou desde o último sync. É também o
  teste de que o script não mexeu no formato: se a origem é a mesma e o arquivo mudou, o
  problema é a conversão, não o dado.
- **Com diff**, olhe a contagem que o script imprimiu. Item novo entrando é normal depois
  de uma atualização do cliente; item sumindo em massa não é.

Depois:

```bash
pnpm test        # inclui o teste de formato da conversão
pnpm typecheck
```

Um diff aqui dispara os **dois** deploys: o serviço (que embarca o arquivo no tar) e a
interface (`web-deploy.yml` observa este caminho, porque `web/scripts/build-catalogue.mjs`
gera dele as descrições e a lista de intransferíveis). Vale entrar em commit próprio, para
o `git log` mostrar quando o catálogo andou.
