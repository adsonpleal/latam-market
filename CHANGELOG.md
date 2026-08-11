# Changelog

Mais recente primeiro. A seção do topo é a fonte do post de novidades no Discord
(`tools/post-novidades.mjs`), então escreva pensando em quem vai ler lá.

## 0.7.1 — 2026-08-11

- **O catálogo pegou a atualização de agosto: são 85 itens novos para consultar.** Entre
  eles os Elmos da Fé das classes mais recentes, as 15 cartas da Arena, os equipamentos das
  masmorras de Geffen e do Dirigível, os pacotes de agosto e o Artefato Oval das Flores. O
  catálogo estava parado em 23/07: quem procurasse por qualquer um desses não achava nada, e
  agora acha.
  - Outros 36 itens tiveram nome ou descrição corrigidos no jogo, e a correção veio junto. A
    **Lança Espectral**, cuja descrição ainda saía em espanhol, agora está em português; o
    **Esboço do Cetro** deixou de se chamar Esboço de Varinha; e quatro pergaminhos Adulter
    Fides que estavam com os nomes trocados entre si (Shuriken com Huuma, Cauda de Gato com
    Rabo-de-Gato) voltaram ao lugar.
- **E atualizar isso virou um comando só.** Os nomes dos itens agora vêm direto de uma
  extração do cliente do jogo, publicada num lugar só e sempre na versão que está no ar. Até
  aqui eram uma cópia trazida à mão de outro projeto, que só envelhecia quando ninguém
  lembrava de atualizar — foi por isso que o catálogo ficou três semanas para trás sem
  ninguém notar. Da próxima atualização do jogo em diante, item novo e nome corrigido chegam
  aqui no mesmo dia.

## 0.7.0 — 2026-08-10

- **Novidade: o simulador de visuais agora sabe o que dá para comprar.** O catálogo de lá
  ganhou os filtros "já visto no mercado" e "à venda agora", e cada visual leva direto
  para a página do item aqui. Quem monta um visual descobre na hora o que está numa loja
  neste momento e o que só existe no sonho.
  - Do lado daqui é uma rota nova, `GET /api/v1/ids`: dois vetores de ids — `inMarket` e
    `forSale` — sem preço e sem paginação, com o mesmo `nextTradingAt` do lote. Um
    catálogo de fora se filtra inteiro com uma requisição, em vez das dezenas de páginas
    de busca que isso custava.
  - `visuais.latam-tools.com.br` entrou na allowlist de origens; é o que permite o
    navegador chamar a API de lá.

- **O agente também pergunta o preço de vários itens de uma vez.** O lote existia só na
  API (`GET /api/v1/prices`); agora é a ferramenta `get_prices` do MCP, com o mesmo teto de
  100 itens e resposta idêntica, item por item, à do `get_price` sozinho. Perguntar "quanto
  vale essa lista aqui?" deixou de custar uma chamada por item.
  - Uma referência ruim no meio da lista não derruba o resto: id que o mercado não conhece
    sai em `missing`, nome ambíguo ou inexistente sai em `naoResolvidos` com o motivo.
  - A busca aceita lista de ids (`502,501`) desde a 0.5.0, mas o schema do MCP dizia "id
    exato", no singular — nenhum agente tinha por que tentar. Agora está escrito lá.

- **E pergunte ao agente quais são os mais baratos.** O `search_items` do MCP ganhou
  `ordenar` e `decrescente`, as mesmas ordens que a tabela do site usa (`price`, `median`,
  `stores`, `units`, `discount`, `sold`, `market_*`, `name`, `id`). A ordem sai do conjunto
  inteiro, como no site: "as dez poções mais baratas" são as mais baratas de todas, não as
  mais baratas das dez que couberam na página. A resposta do MCP continua sem as colunas de
  preço — os ids saem ordenados e o `get_prices` traz os números de quem você quiser.
- **`market_ids` fecha a última rota que só a API tinha.** Os dois vetores de ids do
  `GET /api/v1/ids` — o que já passou pelo mercado e o que está à venda agora — agora
  também pelo MCP, para cruzar com uma lista grande de itens de uma vez. São alguns
  milhares de números e a ferramenta avisa disso: para quase toda pergunta, `search_items`
  com `aVendaAgora` ou `get_prices` custam muito menos.
  - No mesmo pente-fino: o `data_status` agora aceita `coletas`, o `limit` que
    `GET /api/v1/snapshots` já tinha e ele não. Com isso o MCP não tem mais nenhuma rota
    nem parâmetro da API sem equivalente.

## 0.6.0 — 2026-08-10

- **Mudança: a consulta ao vivo saiu.** Era uma requisição ao site no meio do seu pedido —
  lenta, limitada a 5 por minuto, e recusada justamente quando o site estava sobrecarregado.
  As coletas costumam ter menos de uma hora, e para o mercado deste instante o link do site
  oficial já vem junto de cada item, ordenado do mais barato para o mais caro. Uma coisa a
  menos que pode falhar sem que ninguém ganhe nada com isso.
  - Saíram a ferramenta `refresh_live` do MCP, a rota `POST /api/v1/live/items/:item/refresh`
    e o campo `liveEnabled` de `GET /api/v1/status`. Quem chamava a rota recebe 404.
  - O histórico daquelas consultas continua no banco e continua fora das leituras, como
    sempre esteve: uma consulta ao vivo cobria um item só e nunca foi retrato de mercado.
- **Mudança: o código do serviço voltou a ser público.** Quem coleta os dados passou a ser
  um componente à parte, atrás de uma interface pequena, e o resto — banco, API, MCP,
  interface, leitura de replay — está aberto de novo em
  [github.com/adsonpleal/latam-market](https://github.com/adsonpleal/latam-market).

## 0.5.1 — 2026-07-31

- **Correção: a descrição do item mostrava a marcação crua dos destinos.** Onde devia
  estar escrito "Leve essa pedra para a [Loja Fashion]", aparecia
  `<NAVI>[Loja Fashion]<INFO>mal_in01,20,107,0,100,0,0</INFO></NAVI>` na tela. São 855
  itens do catálogo com pelo menos um destino desses.
- **Novidade: o nome do lugar virou link, e clicar copia o `/navi` pronto** para colar no
  chat do jogo — no exemplo acima, `/navi mal_in01 20/107`. O nome interno do mapa não
  aparece em canto nenhum da interface do Ragnarok, então é justamente o que ninguém
  consegue digitar de cabeça.
  - Vale no painel de detalhe do item. No cartão que aparece ao passar o mouse o nome sai
    limpo, mas sem link: o cartão fecha assim que o ponteiro sai da linha, e não daria
    tempo de clicar.

## 0.5.0 — 2026-07-30

- **Novidade: a aba Buscar virou tabela, com preço e colunas configuráveis.** Ideia do
  **Shummuy** — obrigado! Antes a busca só dizia o nome e o tipo, e para saber o preço
  era preciso abrir um item de cada vez.
  - Nasce enxuta: estrela, item, tipo e **mais barato**. Em "Colunas" você liga o que
    quiser — mediana, lojas, unidades à venda, vendedor, média vendida, **vs. média
    vendida**, já vendidos, mín./máx. vendido, id — e a escolha fica guardada no seu
    navegador, separada da de "Meu inventário" e da de Favoritos.
  - **Ordenar vale para a busca inteira, não só para o que está na tela.** Clicar em
    "Mais barato" com 300 resultados traz o mais barato dos 300, e não o mais barato dos
    50 carregados: quem ordena é o servidor. "Carregar mais" continua a ordem.
  - Item sem ninguém vendendo fica no fim da lista nos dois sentidos, em vez de ocupar o
    topo do decrescente com uma coluna de travessões.
- **Novidade: dá para buscar vários ids de uma vez** — `502,501` (ou separados por
  espaço) devolve os dois, na ordem em que você digitou. Serve para comparar um punhado
  de itens lado a lado sem buscar um por um. Vale também para o agente, pelo MCP.
- **Novidade:** `GET /api/v1/items` agora aceita `sort` (`price`, `median`, `stores`,
  `units`, `market_avg`, `discount`, `sold`, `market_min`, `market_max`, `name`, `id`) e
  `dir`, e devolve o preço de cada linha junto do resultado. A resposta do MCP continua
  enxuta, sem preço, para não gastar o contexto do agente com o que ele não pediu.

## 0.4.0 — 2026-07-30

- **Novidade: Favoritos, com alerta de preço no celular.** Marque a estrela nos itens que
  você acompanha, defina um alvo e receba um push quando o mercado bater o número.
  - Favorite de onde estiver: na **Buscar**, no painel de detalhe do item, ou colando um
    **ID** direto na aba.
  - O alerta avisa **quando cai** (para quem quer comprar) e **quando sobe** (para quem
    quer vender). Não repete no mesmo preço: só avisa de novo se andar mais na direção
    escolhida, e rearma sozinho quando o preço volta para o outro lado do alvo.
  - A notificação vai pelo **ntfy.sh**, um app gratuito de push. Sem cadastro, sem chave:
    você escolhe um nome de tópico (tem botão para gerar um difícil de adivinhar), assina
    no celular e clica em **Testar**.
  - O push sai **direto do seu navegador** para o ntfy. Nosso servidor nunca vê o seu
    tópico nem a sua lista de itens.
  - Colunas configuráveis como em "Meu inventário", juntando o que Pechinchas e Variações
    mostram — preço agora, usual, desconto, variação, lojas, vendedor — mais a coluna
    **Falta**, que diz o quanto ainda precisa andar até o alvo. Ordenar por ela põe no
    topo o que está quase disparando.
  - A lista de favoritos vale para os dois servidores; o **alvo** é por servidor, porque
    FREYA e NIDHOGG cobram preços bem diferentes pelo mesmo item.
  - Ressalva honesta: os alertas só rodam enquanto a aba estiver aberta.
- **Novidade: as lojas passam a ser coletadas a cada 30 minutos**, e não a cada hora.
  Todos os preços do site ficam na metade da idade.
- **Novidade: os links de "Lojas" abrem já ordenados do mais barato.** Você clica vindo de
  um preço — o menor da tabela, ou o alvo de um alerta que acabou de tocar — e o anúncio
  que você procura está na primeira linha, não perdido no meio da lista. Vale em todas as
  telas e também no link que a notificação do celular abre.
- **Novidade:** a API ganhou `GET /api/v1/prices?items=1,2,3`, que devolve o preço de até
  cem itens numa chamada só. É o que deixa a aba Favoritos acompanhar trinta itens
  gastando uma requisição por ciclo em vez de trinta.
  - A resposta também diz **quando sai a próxima coleta**, então a página dorme até o dado
    novo chegar em vez de perguntar de minuto em minuto. Por isso não existe (nem faz
    falta) um campo de "verificar a cada N segundos": checar mais que uma vez por coleta
    devolveria exatamente os mesmos números.

## 0.3.0 — 2026-07-29

- **Novidade: o mercado agora tem cara.** Em https://mercado.latam-tools.com.br dá para
  subir o seu `.rrf` e ver, numa tabela, quanto vale cada coisa que você tem — sem
  `curl`, sem agente, sem instalar nada.
  - Ícone de cada item e a descrição do jogo ao passar o mouse.
  - Filtro por mochila, carrinho e equipado, e um botão para esconder o que é
    intransferível (ligado por padrão).
  - Colunas separando o que está à venda **agora** do que o site já publicou como
    **vendido** — são medidas diferentes e não se somam.
  - Exportação em CSV que abre no Excel sem estropiar acento.
  - Painel por item com histórico, as lojas mais baratas com nome do vendedor e o
    avaliador ("por quanto devo vender?").
  - E também busca, pechinchas, maiores variações e o estado das coletas.
- **Novidade:** cada item de um replay agora vem com o agregado do site (média, faixa e
  quantas unidades já foram vendidas) e com quantas unidades estão à venda. Antes só
  saía o preço mais barato e a mediana.
- **Novidade:** dá para filtrar a busca por **tipo** (adaga, cajado, equipamento de
  cabeça, carta, visual… 39 categorias) e por **onde a peça é equipada** (topo, meio,
  baixo, armadura, capa, calçado, acessório, arma, escudo).
  - Os filtros funcionam sozinhos: "me mostra todas as katars" não precisa de texto
    nenhum. `q` deixou de ser obrigatório quando há `type` ou `slot`.
  - A classificação sai da descrição do cliente e cobre **98% do que já apareceu no
    mercado**. O `search_items` do MCP ganhou os mesmos filtros.
- **Correção:** buscar pelo id não achava nada — a busca só olhava o nome. Agora um id
  exato vem primeiro, e aparece mesmo que ninguém esteja vendendo o item.
- **Novidade: NIDHOGG entrou.** O seletor no topo troca o servidor e vale para tudo —
  preços, busca, pechinchas, variações e a avaliação do replay. A escolha fica salva
  entre sessões, e trocar reprecifica o replay que já estava na tela, sem pedir o
  arquivo de novo.
  - Na API é `?server=NIDHOGG`; no MCP, o argumento `servidor` em toda ferramenta.
  - Sem o parâmetro, tudo continua respondendo FREYA — nada do que já existia mudou de
    significado. Um servidor escrito errado é erro 400, e não o padrão em silêncio.
- **Mudança:** `GET /` passa a devolver a interface. Antes respondia um 404 em JSON.
- **Mudança:** schema do banco na versão 3. A v2 trouxe `item_type` e `equip_slots`; a
  v3 acrescentou o servidor à chave de `price_point`, `listing_stats` e `listing_daily`
  e moveu "visto no mercado" para `item_market`. Tudo que existia é carimbado como
  FREYA. A migração roda sozinha no boot.

## 0.2.1 — 2026-07-29

- **Novidade:** toda resposta que menciona um item agora traz links — a página do item
  no Divine Pride e a busca ao vivo no site oficial. Dá para conferir sem procurar o
  item na mão.
  - O site recusa caractere especial na busca, então o link usa o maior trecho seguro
    do nome: `Ovo de Abelha-Rainha` vira uma busca por `Ovo de Abelha`, que acha o
    item do mesmo jeito.
- **Correção:** a consulta ao vivo não tinha limite de uso pelo MCP — só pela API.
  Agora o teto vale para os dois.
- **Correção:** a coleta periódica abriria uma transação dentro de outra e morreria na
  primeira página.
- **Desempenho:** consulta MCP ~1,3 ms mais rápida, busca por nome exato 550× mais
  rápida, e a limpeza periódica saiu da thread principal (parava a API por ~1 s a cada
  hora).

## 0.2.0 — 2026-07-29

- **Novidade:** o projeto deixou de ser só um scraper e virou um serviço. Agora tem
  uma API REST e um servidor MCP servindo os mesmos dados, no mesmo processo, em
  `mercado.latam-tools.com.br`.
- **Novidade (MCP):** dez ferramentas para conversar com o mercado — consultar preço,
  listar ofertas, ver histórico, avaliar se um preço é bom, achar pechinchas e
  maiores variações, e conferir a idade dos dados.
- **Novidade (replay):** leitura de arquivos `.rrf` do Ragnarok para precificar
  inventário, carrinho e equipamento de uma vez.
  - O carrinho de mercador foi identificado no chunk 4516 do container de itens, que o
    parser do projeto irmão ignorava.
  - Inventário e carrinho passam a ser lidos separadamente: os dois numeram as
    posições a partir do zero, e o parser antigo fundia tudo num mapa só — item de
    carrinho podia sumir atrás de item da mochila, ou vazar para dentro dela.
- **Novidade (histórico):** os dados passam a ser guardados em SQLite com retenção em
  camadas, então dá para perguntar como o preço estava semana passada. Antes cada
  coleta sobrescrevia a anterior.
- **Novidade (ao vivo):** consulta em tempo real de um item, com limite por IP e cache
  curto. É explicitamente marcada como cara nas ferramentas do MCP, para o agente
  preferir os dados já coletados.
- **Novidade (coleta):** o servidor coleta sozinho — `trading` de hora em hora,
  `market-price` a cada seis, numa worker thread para não travar a API.
- **Mudança:** uma coleta bloqueada pelo site deixou de parar o processo inteiro. Um
  problema na coleta não atrapalha mais quem está consultando.
- **Infra:** licença MIT, repositório versionado, deploy por GitHub Actions para o EC2.
