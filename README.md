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
- **Leitura de replay `.rrf`** — inventário, carrinho de mercador e equipamento, com
  preço de mercado em cada item.
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

A interface é servida pelo mesmo domínio da API — arquivos estáticos pelo Caddy, com
`/api/*`, `/mcp` e `/healthz` indo para o serviço Node. Código e instruções de
desenvolvimento em [`web/`](web/README.md).

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
| `search_items` | Achar o id de um item pelo nome |
| `get_price` | Quanto custa |
| `list_offers` | Quem está vendendo |
| `price_history` | Como o preço se comportou |
| `appraise_price` | Se um preço é bom |
| `top_movers` | O que subiu ou caiu |
| `find_deals` | Pechinchas |
| `value_inventory` | Precificar um replay `.rrf` (envie em base64) |
| `data_status` | De quando são os dados |

> Todas respondem a partir das coletas, que costumam ter menos de uma hora — `data_status`
> diz a idade exata. Não há consulta ao vivo: para o mercado deste instante, o link do site
> oficial vem em `links.market` de qualquer item.

## Como funciona

```
                      ┌──────────────────────────────────┐
   Caddy ──── :8788 ──│  API REST  ─┐                    │
                      │             ├─→  core/  ─→ cache │
                      │  MCP       ─┘         ↑          │
                      └───────────────────────│──────────┘
                                              │
                          SQLite  ←──── worker do crawl
                                              │
                                       collect/port.ts
                                              │
                                    coletor (componente
                                       à parte, privado)
```

Um processo só. `api/` e `mcp/` são casca fina sobre `core/` e **não podem** ler o
banco direto — é isso que garante que os dois canais respondam a mesma coisa, e há um
teste de paridade que quebra se alguém contornar.

O mercado inteiro cabe na memória (~5 mil itens com preço, ~20 mil anúncios), então
nenhuma leitura toca o disco. O SQLite existe para o histórico e para sobreviver a
reinício.

### Coleta

De hora em hora um worker abre um snapshot, pede as linhas ao coletor, grava cada lote na
sua própria transação curta (é isso que deixa a API ler durante a coleta), faz os rollups e
fecha o snapshot. Nada disso fica visível pela metade: as leituras filtram
`snapshot.ok = 1`, então uma coleta interrompida é invisível em vez de ser um mercado com
buracos. Uma coleta com mais de 20% de falhas é descartada pelo mesmo motivo.

Quem fala com o site é um **componente à parte, mantido em repositório privado**, carregado
em tempo de execução pelo caminho em `COLLECTOR_PATH`. A interface entre os dois é
[`src/collect/port.ts`](src/collect/port.ts), e é bem pequena: o coletor sabe como buscar,
este serviço sabe o que fazer com o resultado.

**Sem coletor instalado o serviço funciona** — sobe, avisa no log e responde a partir do que
já houver no banco. É como um clone deste repositório roda, e é também o que acontece em
produção se o coletor falhar em carregar: o histórico responde a maior parte das perguntas,
então degradar é melhor que cair.

## Rodando localmente

Precisa de **Node 22.5+** (por causa do `node:sqlite`) e **pnpm**.

```bash
pnpm install
pnpm dev     # sobe em http://127.0.0.1:8788
```

O serviço não coleta nada sozinho aqui: sem `COLLECTOR_PATH` ele avisa no log e responde a
partir do banco. Para ter dados com que brincar, há dois caminhos:

- **um banco pronto**: aponte `DB_PATH` para um `market.db` existente;
- **NDJSON seu**: coloque em `data/raw/<run>/<dataset>.<servidor>.ndjson` e rode
  `pnpm import --run-id <run>` (uma linha JSON por anúncio, no formato de
  [`src/store/rows.ts`](src/store/rows.ts)).

Sem nenhum dos dois o serviço sobe com o mercado vazio — funciona, só não responde preço.

| Comando | O que faz |
|---|---|
| `pnpm dev` | Servidor com recarga automática |
| `pnpm import` | Importa NDJSON para o SQLite |
| `pnpm test` | Testes |
| `pnpm typecheck` | Tipos |
| `pnpm build` | Bundle de produção em `dist/` |
| `pnpm sync:items` | Atualiza o catálogo a partir do latam-ro-calc |

Variáveis úteis: `PORT`, `DB_PATH`, `DATA_DIR`, `COLLECTOR_PATH`, `CRAWL_ENABLED`,
`ALLOWED_HOSTS`, `ALLOWED_ORIGINS` (veja `src/server/config.ts`).

## Estrutura

```
src/
  store/     SQLite, cache quente e retenção
  replay/    leitura de arquivos .rrf (inventário, carrinho, equipamento)
  core/      a lógica de mercado — a única camada que API e MCP enxergam
  api/       rotas REST
  mcp/       ferramentas MCP
  server/    processo HTTP
  worker/    coleta periódica e retenção, em worker thread
  collect/   a porta do coletor: a interface e o carregamento
  cli/       comandos de linha
web/         interface web (React + Vite), servida estática pelo Caddy
infra/       systemd e Caddy
```

## Deploy

São dois fluxos, um por push na `main`.

**Serviço** (`deploy.yml`, sem filtro de caminho): typecheck, testes, bundle com
esbuild, envio por `scp` para o EC2, `rsync` em `/opt/latam-market` e reinício do
systemd. A verificação bate no `/healthz`, faz uma chamada MCP real e uma consulta
REST — se qualquer uma falhar, o deploy falha.

**Interface** (`web-deploy.yml`, disparado por `web/**` e pelo catálogo): typecheck,
testes, build do Vite e `rsync` em `/opt/latam-market-web`. Não reinicia nem recarrega
nada — arquivo estático não é configuração. A verificação confere que a interface subiu
**e** que a API, o MCP e o `/healthz` continuam respondendo, porque os dois dividem o
mesmo bloco do Caddy.

O banco fica em `/var/lib/latam-market/market.db`, **fora** de `/opt`, porque o deploy
usa `rsync --delete` e levaria o histórico junto.

O coletor tem deploy próprio, a partir do seu repositório, para um diretório vizinho — fora
do alcance daquele `--delete`. Ele traz o próprio drop-in do systemd, então os dois lados
sobem sem editar a unit um do outro.

Arquivos de infraestrutura em [`infra/`](infra/), com o provisionamento manual
necessário documentado no topo de cada um.

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
- Alguns containers de item do `.rrf` ainda não foram identificados (provavelmente
  armazém da Kafra). Eles vêm à parte, em `unidentified`, e não entram no total.

## Créditos

Catálogo de itens em pt-BR do projeto irmão
[latam-ro-calc](https://github.com/adsonpleal/latam-ro-calc) (simulador de dano). A leitura
de `.rrf` é portada de lá, que por sua vez segue o
[Rrf-Parser do Tokeiburu](https://github.com/Tokeiburu).

Projeto não-oficial, feito para a comunidade. Sem vínculo com a Gravity ou a Gnjoy.

## Licença

[MIT](LICENSE).
