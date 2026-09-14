# latam-market

API e servidor **MCP** para o mercado de jogadores do Ragnarok Online LATAM
(**FREYA** e **NIDHOGG**). Os mesmos dados por dois canais: HTTP para aplicações, MCP
para agentes de IA.

🔗 **https://mercado.latam-tools.com.br**

```
Interface  →  https://mercado.latam-tools.com.br
API REST   →  https://mercado.latam-tools.com.br/api/v1
MCP        →  https://mercado.latam-tools.com.br/mcp
```

Sem cadastro, sem chave de API, sem login. Licença MIT.

## O que dá para perguntar

Conectado a um agente (Claude, por exemplo), o MCP responde coisas assim:

> "Quanto custa um Elixir Dourado?"
> "Quero comprar uma Boina — me lista quem está vendendo e por quanto."
> "Vender minha Escama Invertida por 500 mil é bom negócio?"
> "O preço da Ração Luxuosa subiu esse mês?"
> "Tem alguma pechincha no mercado agora?"
> "Toma meu replay: quanto vale tudo que eu tenho? O que dá para vender com lucro?"

## Recursos

- **Preço de qualquer item** — a faixa histórica publicada pelo site e o resumo das
  lojas abertas na última coleta, que são coisas diferentes e vêm separadas.
- **Ofertas ativas** — quem está vendendo, por quanto, em que loja e em que mapa.
- **Histórico próprio** — construído acumulando nossas coletas, com retenção em
  camadas (anúncio cru por um dia, resumo por 30 dias, resumo diário para sempre).
- **Avaliação de preço** — quantas lojas estão mais baratas, quanto pedir para ser o
  mais barato, e como o preço se compara à média dos últimos dias.
- **Pechinchas e maiores variações** — varreduras sobre o mercado inteiro.
- **Leitura de replay `.rrf`** — inventário, carrinho de mercador, equipamento e os
  armazéns do Kafra e do clã, com preço de mercado em cada item.
- **Links prontos** — todo item vem com a página no
  [Divine Pride](https://www.divine-pride.net) e a busca no site oficial, já ordenada do
  mais barato para o mais caro. É para lá que se vai quando a pergunta é "e agora, neste
  instante?" — o serviço responde a partir das coletas, não do site ao vivo.

## Interface web

Em **https://mercado.latam-tools.com.br** dá para usar tudo isso sem escrever uma linha
de comando: sobe o `.rrf`, e a tabela mostra item por item o que ele vale, com ícone,
descrição no hover, filtro por origem (mochila, carrinho, equipado), botão para esconder
os intransferíveis, exportação em CSV e links para o Divine Pride e para o mercado
oficial. Tem também busca, pechinchas, maiores variações e o estado das coletas.

A interface é servida pelo mesmo processo e domínio da API, `/mcp` e `/healthz`. Código
e instruções de desenvolvimento em [`web/`](web/README.md).

## Usando a API

Toda rota aceita `?server=FREYA|NIDHOGG`. Sem o parâmetro, responde FREYA; um valor
desconhecido é 400, e não o padrão em silêncio.

```bash
# buscar um item
curl 'https://mercado.latam-tools.com.br/api/v1/items?q=elixir'

# o mesmo item no outro servidor
curl 'https://mercado.latam-tools.com.br/api/v1/items/501?server=NIDHOGG'

# preço (aceita id ou nome)
curl 'https://mercado.latam-tools.com.br/api/v1/items/Elixir%20Dourado'

# quem está vendendo
curl 'https://mercado.latam-tools.com.br/api/v1/items/1100005/offers?limit=10'

# vale a pena vender a 2600?
curl 'https://mercado.latam-tools.com.br/api/v1/items/1100005/appraise?price=2600'

# avaliar um replay
curl -X POST --data-binary @replay.rrf \
  -H 'content-type: application/octet-stream' \
  https://mercado.latam-tools.com.br/api/v1/replay
```

| Rota | O que faz |
|---|---|
| `GET /api/v1/items?q=` | Busca por nome (sem acento, sem caixa) |
| `GET /api/v1/items/:item` | Preço, ofertas e resumo. `:item` é id ou nome |
| `GET /api/v1/items/:item/offers` | Lojas vendendo agora, da mais barata para a mais cara |
| `GET /api/v1/items/:item/history?days=30` | Série histórica |
| `GET /api/v1/items/:item/appraise?price=N` | Avaliação de um preço |
| `GET /api/v1/prices?items=501,1201` | Preço de vários itens numa chamada (só ids, no máximo 100) |
| `GET /api/v1/ids` | Só os ids: `inMarket` (já visto) e `forSale` (à venda agora) |
| `GET /api/v1/movers?days=7&dir=up` | Maiores variações |
| `GET /api/v1/deals?min_discount=25` | Itens bem abaixo do usual |
| `GET /api/v1/snapshots` | Coletas recentes |
| `GET /api/v1/status` | Idade dos dados |
| `POST /api/v1/replay` | Envie o `.rrf` no corpo; devolve os itens precificados |
| `GET /healthz` | Saúde do serviço |

Quando um nome casa com vários itens, a resposta é **300** com a lista de candidatos —
o serviço não escolhe por você.

`/prices` é a única rota que não aceita nome: um nome ambíguo viraria 300 e derrubaria a
leitura dos outros itens da lista. Ids que não existem voltam em `missing`, e
`nextTradingAt` diz quando sai a próxima coleta — é o que deixa um cliente dormir até o
dado novo chegar em vez de perguntar de minuto em minuto.

`/ids` responde a mesma pergunta de graça para quem já tem catálogo próprio: dois vetores
de ids, sem preço, sem paginação e com o mesmo `nextTradingAt`. É o que o
[simulador de visuais](https://visuais.latam-tools.com.br) usa para marcar, entre os
visuais do jogo, quais dá para comprar — pela busca seriam dezenas de páginas.

## Conectando o MCP

Em clientes com suporte a MCP remoto (Claude Desktop, Claude Code):

```json
{
  "mcpServers": {
    "mercado-ro": {
      "type": "http",
      "url": "https://mercado.latam-tools.com.br/mcp"
    }
  }
}
```

| Ferramenta | Para quê |
|---|---|
| `search_items` | Achar o id de um item pelo nome (ou vários de uma vez: `502,501`), com ordenação |
| `get_price` | Quanto custa |
| `get_prices` | Quanto custa uma lista de itens, numa chamada só |
| `list_offers` | Quem está vendendo |
| `price_history` | Como o preço se comportou |
| `appraise_price` | Se um preço é bom |
| `top_movers` | O que subiu ou caiu |
| `find_deals` | Pechinchas |
| `value_inventory` | Precificar um replay `.rrf` (envie em base64) |
| `market_ids` | Todos os ids vistos e à venda, para cruzar com uma lista sua |
| `data_status` | De quando são os dados |

> Todas respondem a partir das coletas, que costumam ter poucos minutos — `data_status`
> diz a idade exata. Não há consulta ao vivo: para o mercado deste instante, o link do site
> oficial vem em `links.market` de qualquer item.

## Como funciona

```
  Cloudflare (TLS + cache de borda)
          │  túnel (cloudflared)
          ▼
  ┌─────────────────────── VM ───────────────────────┐
  │  node:http :8788                                 │
  │    API REST ─┐                                   │
  │              ├─→ core/ ─→ cache do mercado       │
  │    MCP ──────┘              ↑ (memória)          │
  │    interface (estática)     │                    │
  │                             │                    │
  │  SQLite (WAL) ←── ingest/ ←─┘                    │
  │                     ↑ itens completos            │
  │               worker thread ── coletor           │
  │                                (privado)         │
  └──────────────────────────────────────────────────┘
```

Um processo só, numa VM, atrás de um túnel da Cloudflare. `api/` e `mcp/` são casca fina
sobre `core/` e **não podem** ler o banco direto — é isso que garante que os dois canais
respondam a mesma coisa, e há um teste de paridade que quebra se alguém contornar.

O mercado corrente cabe na memória (~6 mil itens, dezenas de milhares de anúncios), então
nenhuma leitura de preço ou oferta toca o disco. O SQLite guarda o histórico e as ofertas
atuais, para o processo subir de novo com o mercado inteiro. A borda da Cloudflare segura as
leituras repetidas: as rotas de mercado ficam 60 s em cache e a VM só vê as que expiram.

### Coleta

A cada 10 minutos, para cada servidor, o agendador abre uma worker thread e carrega nela o
coletor. Ele não entrega a coleta no fim: **cada item sai assim que está completo**, ou seja,
assim que algum termo de busca que o contém teve todas as páginas lidas. A busca do site é por
substring, então esse termo trouxe todos os anúncios do item.

A thread principal recebe esses lotes e grava cada um em transações curtas: as ofertas do
item, as estatísticas do dia e o ponto de preço. No mesmo instante publica o item no cache,
com uma nova revisão que muda o ETag. Um item que o coletor confirma sem anúncios sai do
mercado. Um item que nenhuma coleta confirma há duas horas expira.

O relógio de "dados de quando" só avança quando pelo menos 80% dos termos fecharam. Uma
coleta ruim não apaga nada e não finge ser recente: o que ela completou é publicado, e o
resto continua como estava.

Quem fala com o site é um **componente à parte, mantido em repositório privado**, carregado
em tempo de execução pelo caminho em `COLLECTOR_PATH`. A interface entre os dois é
[`src/collect/port.ts`](src/collect/port.ts), e é bem pequena: o coletor sabe como buscar,
este serviço sabe o que fazer com o resultado.

**Sem coletor instalado o serviço funciona** — sobe, avisa no log e responde a partir do que
já houver no banco. É como um clone deste repositório roda.

## Rodando localmente

Precisa de **Node 22.13+** (por causa do `node:sqlite` sem flag) e **pnpm**.

```bash
pnpm install
pnpm --filter web build
pnpm dev     # sobe em http://127.0.0.1:8788
```

O serviço não coleta nada sozinho aqui: sem `COLLECTOR_PATH` ele avisa no log e responde a
partir do banco em `DB_PATH` (padrão `data/market.db`, criado vazio na primeira vez). Sem
dados, sobe com o mercado vazio — funciona, só não responde preço.

| Comando | O que faz |
|---|---|
| `pnpm dev` | Servidor com recarga automática |
| `pnpm test` | Testes (tudo em processo, sobre SQLite em memória) |
| `pnpm typecheck` | Tipos |
| `pnpm build` | Bundle de produção em `dist/` |
| `pnpm sync:items` | Atualiza o catálogo a partir do ragassets |

Variáveis úteis: `PORT`, `HOST`, `DB_PATH`, `STATIC_DIR`, `COLLECTOR_PATH`, `CRAWL_ENABLED`,
`CRAWL_TRADING_MIN`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS` (veja `src/config.ts`).

## Estrutura

```
src/
  core/      a lógica de mercado — a única camada que API e MCP enxergam
  api/       rotas REST
  mcp/       ferramentas MCP
  app.ts     o roteamento de uma requisição, sem saber de Node
  node/      o processo: HTTP, arquivos estáticos, agendador, manutenção
  ingest/    grava e publica o que a coleta entrega
  store/     SQLite, migrações e o cache do mercado
  collect/   a porta do coletor e a worker thread que o carrega
  replay/    leitura de arquivos .rrf (inventário, carrinho, equipamento, armazéns)
  cli/       comandos de linha
migrations/  o esquema do banco, aplicado no boot
web/         interface web (React + Vite), servida pelo próprio processo
infra/       systemd, scripts da VM e o roteiro da virada
```

## Deploy

Um fluxo só, por push na `main` (`deploy.yml`): typecheck, testes, build da interface, bundle
com esbuild, envio por `scp` para a VM, `rsync` em `/opt/latam-market`, instalação das units e
reinício. A verificação roda o [`infra/smoke.sh`](infra/smoke.sh) contra o processo local.

O banco fica em `/var/lib/latam-market/market.db`, **fora** de `/opt`, porque o deploy usa
`rsync --delete` e levaria o histórico junto. Uma cópia diária sai pelo
`latam-market-backup.timer`, com as últimas sete guardadas.

O coletor tem deploy próprio, a partir do seu repositório, para um diretório vizinho — fora
do alcance daquele `--delete`. Ele traz o próprio drop-in do systemd, então os dois lados
sobem sem editar a unit um do outro.

A saída da Cloudflare Workers para a VM está em [`infra/CUTOVER.md`](infra/CUTOVER.md).

## Limites conhecidos

- **Só o lado de quem está vendendo** — o site não preenche o outro. FREYA e NIDHOGG são
  coletados na mesma cadência.
- **Nada é ao vivo.** Toda resposta vem da última coleta, com a idade declarada. Para o
  mercado deste instante, o link do site oficial vem junto de cada item.
- **O histórico de NIDHOGG começa agora.** FREYA acumula desde o início do projeto; o
  outro servidor entrou depois, então pechinchas e variações só ficam úteis lá quando
  houver alguns dias de coleta.
- **Refino, cartas e bônus aleatórios não são precificados.** O mercado agrega por id
  de item, então uma arma +9 encantada aparece com o preço da arma base — as respostas
  avisam quando é o caso, em vez de fingir precisão.
- **O histórico começa quando começamos a coletar.** O site não publica série
  temporal; o que ele dá é um agregado acumulado, e o resto é medição nossa.
- **O retrato de um replay é do início da gravação.** Itens pegos ou gastos durante a
  gravação não aparecem.
- **O armazém só existe no replay se a janela foi aberta durante a gravação.** Ele não
  está no arquivo: o servidor manda a listagem no instante em que a janela abre. Sem
  isso, `storage` e `guildStorage` vêm `null` — que é "ninguém abriu", e não "está
  vazio". Como eles entram em `totalValue`, **o total não é comparável entre um replay
  que passou no Kafra e um que não passou.**
- Alguns containers de item do `.rrf` ainda não foram identificados. Eles vêm à parte, em
  `unidentified`, e não entram no total. Já se supôs que fossem o armazém; não são — numa
  gravação com as duas janelas de armazém abertas eles vêm vazios do mesmo jeito.

## Créditos

Catálogo de itens em pt-BR extraído do cliente do jogo pelo
[ragassets](https://github.com/adsonpleal/ragassets), que publica as tabelas do cliente em
`assets.latam-tools.com.br/raw/`. A leitura de `.rrf` é portada do projeto irmão
[latam-ro-calc](https://github.com/adsonpleal/latam-ro-calc) (simulador de dano), que por
sua vez segue o [Rrf-Parser do Tokeiburu](https://github.com/Tokeiburu).

Projeto não-oficial, feito para a comunidade. Sem vínculo com a Gravity ou a Gnjoy.

## Licença

[MIT](LICENSE).
