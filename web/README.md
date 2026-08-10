# Interface web

SPA em React + Vite que consome a API deste mesmo repositório. Em produção o Caddy
serve os arquivos estáticos na raiz de `mercado.latam-tools.com.br` e faz proxy de
`/api/*`, `/mcp` e `/healthz` para o serviço Node — **mesma origem**, então não existe
CORS nem URL base para configurar.

## Rodando local

```bash
pnpm install            # na raiz; web/ é membro do workspace
pnpm start              # o backend, na 8788
pnpm --filter web dev   # a interface, na 5173
```

> **Aponte o proxy para o backend LOCAL, não para produção.**
>
> `src/server/config.ts` traz `http://localhost:5173` no `ALLOWED_ORIGINS` padrão, mas
> `infra/latam-market.service` sobrescreve a variável em produção com apenas
> `https://claude.ai,https://mercado.latam-tools.com.br`. O proxy do Vite repassa o
> cabeçalho `Origin` intacto (`changeOrigin` mexe no `Host`, não nele), então apontar
> para produção devolve `403 origem não autorizada` em toda requisição.

Sem um `.rrf` à mão, o fixture versionado serve:

```bash
curl -s --data-binary @src/replay/__tests__/fixtures/equip-test-2.rrf -X POST http://127.0.0.1:8788/api/v1/replay
```

## Catálogo

`scripts/build-catalogue.mjs` roda antes de `dev`, `build`, `test` e `typecheck`. Ele lê
`../data/latam-items.json` (6,6 MB) e gera, em `public/generated/` e `src/generated/`:

| Arquivo | Conteúdo | Tamanho |
|---|---|---|
| `descriptions.<hash>.json` | `{ "<id>": "<descrição pt-BR>" }` | 5,4 MB → 489 KB brotli |
| `untradable.<hash>.json` | ids intransferíveis | 7 KB |
| `src/generated/catalogue.ts` | as URLs, com o hash | — |

Os dois diretórios são gerados e estão no `.gitignore`. O hash no nome é o que permite
`Cache-Control: immutable`.

### Por que "intransferível" sai da descrição, e não do GRF

O `data/itemmoveinfov5.txt` de dentro do `data.grf` tem uma coluna `Trade`, que parece a
fonte certa e não é: ela é herdada do cliente coreano e não descreve as regras deste
servidor. Medido contra os 5.460 itens que o coletor já viu à venda:

| Sinal | Marca | Destes, à venda agora |
|---|---|---|
| `Trade=0` no GRF | 3.908 itens | **51,6%** |
| `Kafra=0` no GRF | 5.809 itens | 34,7% |
| "Intransferível" na descrição | 1.215 itens | **1,3%** |
| _(linha de base: 38% do catálogo já apareceu no mercado)_ | | |

Ou seja: a coluna do GRF é pior que chutar. A regra final está em
`scripts/catalogue-rules.mjs`, com teste em `src/lib/__tests__/untradable.test.ts`.

## Tipos

`src/api/types.ts` é o único arquivo que alcança `../src/`, e só por `import type`. Um
arquivo espelho divergiria calado; assim o `tsc --noEmit` daqui quebra junto com o
backend. `src/__tests__/layering.test.ts` (na raiz) garante que nenhum import de valor
atravesse — se atravessasse, o Vite tentaria empacotar `node:sqlite`.

## Deploy

`.github/workflows/web-deploy.yml`, disparado por mudanças em `web/**` e no catálogo.
Manda o `dist/` para `/opt/latam-market-web` e **não** recarrega o Caddy — arquivo
estático não é configuração. A verificação final bate na API, no MCP e no `/healthz`
depois de publicar: é o teste de regressão da ordem dos `handle` no Caddy.
