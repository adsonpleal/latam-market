# latam-market

Ferramentas para o mercado de jogadores do Ragnarok Online LATAM (**FREYA** e **NIDHOGG**):
o inventário inteiro de um personagem a partir de um replay, uma busca no catálogo do jogo e
uma lista de favoritos com preço e alerta consultados direto no site oficial.

🔗 **https://mercado.latam-tools.com.br**

Sem cadastro, sem login, sem servidor. Licença MIT.

## O que é

Um site estático. Tudo roda no navegador de quem usa:

- **Inventário de replay** — escolha o `.rrf` e a própria página lê inventário, carrinho de
  mercador, equipamento e, quando a janela foi aberta durante a gravação, os armazéns do
  Kafra e do clã. **O arquivo nunca sai do seu computador**: a leitura é feita com o
  [rrfparser](https://www.npmjs.com/package/rrfparser) ali mesmo, sem upload. Cada item vem
  com nome, slots e categoria do catálogo do jogo, que é baixado uma vez e fica em cache.
- **Busca no catálogo** — o catálogo inteiro do jogo, por nome ou ID, com filtro por tipo e
  por onde equipa. Favorite item por item ou todos os resultados de uma vez. Não consulta o
  site do mercado.
- **Favoritos com preço e alerta** — a lista mora no navegador, e a consulta de preço
  também: uma aba auxiliar aberta no site oficial do mercado, acionada por um bookmarklet
  (o favorito **Conectar latam-market**), consulta os itens **do seu navegador e do seu IP**.
  - **Atualizar todos os preços** consulta a lista inteira; itens de nome parecido saem numa
    consulta só (uma busca por "Zangão" traz as três cartas de Zangão).
  - Os itens com alerta são checados sozinhos a cada 5, 10, 15, 30 ou 60 minutos, e o aviso
    chega no celular pelo [ntfy](https://ntfy.sh).
  - As consultas respeitam o limite por IP do site: uma por vez, 5 s entre elas, no máximo 30
    a cada 15 minutos. Se o site bloquear (HTTP 429) ou pedir a verificação do Cloudflare, a
    tela mostra na hora e as consultas param sozinhas até poder voltar.
  - **Limpar favoritos** esvazia a lista, com a opção de manter os itens que têm alerta.

  Instruções detalhadas moram na interface, no "i" ao lado do título de cada aba.

Ninguém do outro lado guarda preço, replay ou lista de favoritos: não existe outro lado.

## API e MCP: aposentados em 2026-09-15

Até essa data um servidor coletava o mercado do site oficial a cada 10 minutos, guardava o
histórico e respondia preço por uma API REST e por um servidor MCP. O site oficial pôs
proteção contra robôs da Cloudflare na frente do mercado, e a coleta feita por servidor
ficou bloqueada de vez.

**A API pública (`/api/v1/*`) e o MCP foram desligados** e não voltam. A busca no catálogo
e a leitura de replay, que ainda eram rotas do servidor, passaram para o navegador, e o
servidor deixou de existir. Quem integrava com eles não tem substituto aqui; o catálogo em
pt-BR continua publicado pelo [ragassets](https://github.com/adsonpleal/ragassets).

O roteiro manual da migração (projeto no Pages, domínio, arquivamento do histórico e
desligamento da VM) está em [`infra/DESLIGAMENTO.md`](infra/DESLIGAMENTO.md).

## Rodando localmente

Precisa de **Node 22** e **pnpm**.

```bash
pnpm install              # na raiz; web/ é membro do workspace
pnpm --filter web dev     # a interface em http://localhost:5173
```

Não há backend para subir: o `predev` gera o catálogo a partir de `data/latam-items.json` e
o Vite serve o resto.

| Comando | O que faz |
|---|---|
| `pnpm --filter web dev` | Interface com recarga automática |
| `pnpm --filter web build` | Build de produção em `web/dist` |
| `pnpm --filter web test` | Testes da interface |
| `pnpm --filter web typecheck` | Tipos |
| `pnpm test` | Testes de `tools/` |
| `pnpm sync:items` | Atualiza `data/latam-items.json` a partir do ragassets |

Rode `pnpm sync:items` depois de uma atualização do cliente do jogo, quando um item novo
não aparece na busca. O arquivo é versionado: o diff dele é a revisão da atualização.

## Estrutura

```
web/     o site inteiro (React + Vite): interface, leitura de replay, conexão com o mercado
         e o gerador do catálogo — detalhes em web/README.md
data/    latam-items.json, o catálogo do cliente do jogo em pt-BR (fonte do build)
tools/   scripts de manutenção: sync do catálogo e anúncio de novidades no Discord
infra/   o roteiro do desligamento da VM
```

## Deploy

Push na `main` → GitHub Actions (`.github/workflows/deploy.yml`) → **Cloudflare Pages**.

O workflow roda typecheck, testes da raiz e do `web/`, o build (que gera o catálogo),
confere que o `dist` tem `index.html`, `_headers` e os três JSON do catálogo, e publica com
`wrangler pages deploy` no projeto `latam-market`. Os cabeçalhos de cache moram em
[`web/public/_headers`](web/public/_headers). Quando a versão do `package.json` muda, o
mesmo workflow anuncia as novidades no Discord.

A migração da VM para o Pages teve passos manuais únicos, registrados em
[`infra/DESLIGAMENTO.md`](infra/DESLIGAMENTO.md).

## Limites conhecidos

- **O retrato de um replay é do início da gravação.** Itens pegos ou gastos durante a
  gravação não aparecem.
- **O armazém só existe no replay se a janela foi aberta durante a gravação.** Ele não
  está no arquivo: o servidor do jogo manda a listagem no instante em que a janela abre.
  Sem isso, o armazém aparece como "não aberto" — que não é o mesmo que "vazio".
- Alguns containers de item do `.rrf` ainda não foram identificados e aparecem à parte.
  Já se supôs que fossem o armazém; não são — numa gravação com as duas janelas de armazém
  abertas eles vêm vazios do mesmo jeito.
- **O alerta de preço depende do navegador.** A checagem roda enquanto a aba Favoritos e a
  aba do mercado estão abertas (podem ficar em segundo plano). Fechou uma, parou.
- **A consulta usa o seu IP.** O limite do site é por IP, e a sua própria navegação no
  mercado gasta da mesma cota. Um bloqueio (429) vale também para o site no seu navegador.
- **O agrupamento de consultas supõe que a busca do site casa por trecho do nome**, como
  sempre casou. Se um grupo vier com a página cortada, o item é consultado sozinho em seguida.
- **O preço é do item base.** O site não expõe refino, cartas nem encantamentos dos anúncios.

## Créditos

Catálogo de itens em pt-BR extraído do cliente do jogo pelo
[ragassets](https://github.com/adsonpleal/ragassets), que publica as tabelas do cliente em
`assets.latam-tools.com.br/raw/`. A leitura de `.rrf` usa o
[rrfparser](https://www.npmjs.com/package/rrfparser), portado do projeto irmão
[latam-ro-calc](https://github.com/adsonpleal/latam-ro-calc) (simulador de dano), que por
sua vez segue o [Rrf-Parser do Tokeiburu](https://github.com/Tokeiburu).

Projeto não-oficial, feito para a comunidade. Sem vínculo com a Gravity ou a Gnjoy.

## Licença

[MIT](LICENSE).
