# Interface web

SPA em React + Vite, e o site inteiro: não há backend. Em produção `web/dist` é publicado no
Cloudflare Pages em `mercado.latam-tools.com.br` como arquivos estáticos — sem API, sem
proxy, sem URL base para configurar.

Três coisas que antes dependiam de servidor moram aqui:

- **Preço.** Buscado no site oficial pelo navegador de quem usa. Os dois lados dessa
  conversa são `src/bridge/` (o código que vira favorito e roda na aba do mercado) e
  `src/lib/market/` (URL, parser, cota e quarentena). O cabeçalho de cada arquivo explica a
  decisão que ele carrega; comece por `src/bridge/bridge.ts` e `src/lib/market/budget.ts`.
- **Replay.** O `.rrf` é lido no navegador com o
  [rrfparser](https://www.npmjs.com/package/rrfparser), em `src/lib/replay/`. O arquivo é
  lido com a File API e nunca é enviado para lugar nenhum.
- **Catálogo.** JSON estático gerado no build, baixado sob demanda (abaixo).

> **"bridge" no código, "conexão" na tela.** Os nomes do código (`src/bridge/`, `BridgeClient`,
> `BridgeInstall`) são de antes de a interface trocar a palavra; na tela, e nos textos para quem
> usa, é sempre "conexão". O script de build do catálogo é `.mjs`, mas roda com `tsx`: ele
> importa a classificação de itens direto de `src/lib/catalogue/taxonomy.ts`.

## Rodando local

```bash
pnpm install            # na raiz; web/ é membro do workspace
pnpm --filter web dev   # http://localhost:5173
```

É só isso: o `predev` gera o catálogo e o Vite serve o resto. Para ver o build como vai
para produção, `pnpm --filter web build && pnpm --filter web preview`.

## Catálogo

`scripts/build-catalogue.mjs` roda antes de `dev`, `build`, `test` e `typecheck`. Ele lê
`../data/latam-items.json` e gera, em `public/generated/` e `src/generated/`:

| Arquivo | Conteúdo |
|---|---|
| `items.<hash>.json` | id, nome, slots, tipo e onde equipa — o que a busca, os favoritos e o replay usam |
| `descriptions.<hash>.json` | `{ "<id>": "<descrição pt-BR>" }` — o maior dos três |
| `untradable.<hash>.json` | ids intransferíveis |
| `src/generated/catalogue.ts` | as URLs, com o hash |

Nenhum dos JSON entra no bundle: a página os baixa sob demanda, na primeira vez que precisa
(uma busca, um replay, uma descrição aberta), e o navegador guarda. Os dois diretórios são
gerados e estão no `.gitignore`. O hash no nome é o que permite o
`Cache-Control: immutable` que `public/_headers` aplica a `/generated/*`.

### Por que "intransferível" sai da descrição, e não do GRF

O `data/itemmoveinfov5.txt` de dentro do `data.grf` tem uma coluna `Trade`, que parece a
fonte certa e não é: ela é herdada do cliente coreano e não descreve as regras deste
servidor. Medido, enquanto a coleta existia, contra os 5.460 itens já vistos à venda:

| Sinal | Marca | Destes, à venda agora |
|---|---|---|
| `Trade=0` no GRF | 3.908 itens | **51,6%** |
| `Kafra=0` no GRF | 5.809 itens | 34,7% |
| "Intransferível" na descrição | 1.215 itens | **1,3%** |
| _(linha de base: 38% do catálogo já apareceu no mercado)_ | | |

Ou seja: a coluna do GRF é pior que chutar. A regra final está em
`scripts/catalogue-rules.mjs`, com teste em `src/lib/__tests__/untradable.test.ts`.

## Deploy

Não tem workflow próprio: `.github/workflows/deploy.yml`, na raiz, roda typecheck, testes e
`pnpm --filter web build`, confere o `dist` e publica com `wrangler pages deploy` no projeto
`latam-market` do Cloudflare Pages. Um push na `main` publica.

Duas coisas do `dist` que o Pages lê por convenção: `_headers` (vem de `public/`, define o
cache) e a **ausência** de `404.html` — sem ele o Pages serve o `index.html` para qualquer
rota desconhecida, e é isso que faz `/favoritos` abrir direto pelo link.
