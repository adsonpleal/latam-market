/**
 * As ferramentas do MCP.
 *
 * Todas são casca fina sobre `core/` — a mesma função que a rota REST chama. Nenhuma
 * delas monta consulta, faz conta ou remodela resultado; se precisasse, a lógica
 * estaria no lugar errado e os dois canais acabariam divergindo.
 *
 * Duas convenções que valem para o conjunto:
 *
 *  - **Nome do item aceito no lugar do id.** O agente recebe "quanto custa um Elixir
 *    Dourado?", não um número. `resolveItem` devolve candidatos quando há dúvida, e a
 *    ferramenta repassa a dúvida em vez de escolher.
 *  - **Toda resposta com preço leva `freshness`.** Sem saber de quando é o dado, o
 *    agente afirma "custa X" com uma confiança que o dado não tem.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import type { Db } from "../store/port.js";
import { z } from "zod";

import { appraise } from "../core/appraise.js";
import {
  type Resolution,
  SEARCH_SORTS,
  type SearchSort,
  marketedIds,
  resolveItem,
  resolveItems,
  searchItems,
} from "../core/items.js";
import { findDeals, topMovers } from "../core/movers.js";
import {
  DEFAULT_CHEAPEST,
  cheapestOffers,
  freshness,
  history,
  itemPrice,
  itemPrices,
} from "../core/prices.js";
import { sellCandidates, valueReplay } from "../core/replay.js";
import type { Server } from "../core/servers.js";
import { serviceStatus } from "../core/status.js";
import { EQUIP_SLOTS, ITEM_CATEGORIES } from "../core/taxonomy.js";

import { config } from "../config.js";
import { json, jsonCompact, paged, registerJsonTool } from "./helpers.js";

/**
 * Rota que recebe o `.rrf` binário, sem o custo do base64.
 *
 * Função, e não constante de módulo: `config.publicUrl` só existe depois de `applyEnv`,
 * que no Worker roda dentro do `fetch` — muito depois de este módulo ser avaliado.
 */
export const replayUrl = (): string => `${config.publicUrl}/api/v1/replay`;

/**
 * TODOS os schemas ficam no escopo do módulo.
 *
 * O `McpServer` é reconstruído a cada POST — o transporte é stateless — então tudo que
 * for montado dentro de `registerTools` é montado de novo a cada requisição. Medido:
 * as cadeias zod declaradas em linha custavam 0,95 ms dos 1,67 ms de construção do
 * servidor, contra 0,0007 ms do corpo de uma ferramenta como `get_price`. Ou seja, a
 * maior parte do custo de uma chamada MCP era remontar validação idêntica.
 */

/**
 * Aceita número e string porque o agente manda os dois: `1100005` quando já viu o id
 * numa resposta anterior, `"Elixir Dourado"` quando está repetindo o que a pessoa
 * escreveu. Exigir string fazia a chamada com id falhar na validação.
 */
const itemRef = z
  .union([z.string(), z.number().int().positive()])
  .describe(
    "Id numérico do item ou parte do nome (acentos e maiúsculas são ignorados).",
  );

const days = (fallback: number) =>
  z.number().int().min(1).max(365).optional().default(fallback);

const limit = (fallback: number, max = 100) =>
  z.number().int().min(1).max(max).optional().default(fallback);

function buildSchemas() {
  return {
    search: {
      query: z
        .string()
        .optional()
        .describe(
          'Texto livre, um id exato, ou uma lista de ids. "pocao" acha "Poção"; "501" acha ' +
            'o item 501; "502,501" (vírgula ou espaço) devolve os dois na ordem digitada, ' +
            "que é como comparar um punhado de itens sem uma chamada para cada. Id sempre " +
            "aparece mesmo fora do mercado. Opcional quando há `tipo` ou `slot`.",
        ),
      tipo: z
        .enum(ITEM_CATEGORIES.map((c) => c.id) as [string, ...string[]])
        .optional()
        .describe(
          "Categoria do item. Combine com `slot` para restringir mais.",
        ),
      slot: z
        .enum(EQUIP_SLOTS.map((s) => s.id) as [string, ...string[]])
        .optional()
        .describe("Onde a peça é equipada. Só faz sentido para equipamento."),
      incluirForaDoMercado: z
        .boolean()
        .optional()
        .default(false)
        .describe("Inclui itens do catálogo que nunca apareceram no mercado."),
      aVendaAgora: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Só itens com anúncio ativo na coleta mais recente. Mais estreito que o " +
            "anterior: aquele é 'já apareceu alguma vez', este é 'dá para comprar agora'.",
        ),
      // Quem ordena é o servidor, sobre o CONJUNTO — ordenar a página devolvida responderia
      // "o mais barato destes vinte" com cara de "o mais barato". Por isso a opção existe
      // aqui e não fica a cargo do agente reordenar o que recebeu.
      ordenar: z
        .enum(SEARCH_SORTS)
        .optional()
        .default("relevance")
        .describe(
          "Ordem do conjunto inteiro. `relevance` (padrão) é o casamento com o texto; " +
            "`price` é a oferta mais barata de agora, `median` a mediana das lojas, " +
            "`stores` quantas vendem, `units` quantas unidades há, `discount` o quanto a " +
            "oferta está abaixo do histórico, `sold`/`market_avg`/`market_min`/`market_max` " +
            "vêm do agregado do site, e `name`/`id` são a ordem óbvia. A resposta continua " +
            "sem preço: peça os ids aqui e passe-os a `get_prices` se precisar dos números.",
        ),
      decrescente: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Inverte a ordem. Item sem o dado pedido fica no fim NOS DOIS SENTIDOS — o mais " +
            "caro é o mais caro que alguém vende, não uma página de itens sem oferta.",
        ),
      limit: limit(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    getPrice: {
      item: itemRef,
      ofertas: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(5)
        .describe("Quantas ofertas mais baratas incluir."),
    },
    getPrices: {
      itens: z
        .array(itemRef)
        .min(1)
        .max(
          config.limits.maxBatchItems,
          `no máximo ${config.limits.maxBatchItems} itens por chamada`,
        )
        .describe(
          "Ids ou nomes. Cada um resolvido como em `get_price`; repetido conta uma vez.",
        ),
      // Zero por padrão, ao contrário do `get_price`: cinco ofertas para um item cabem na
      // resposta, cinco vezes cem não — o lote existe para caber, e quem quiser as lojas de
      // um item específico chama `list_offers`. O teto acompanha o da rota REST.
      ofertas: z
        .number()
        .int()
        .min(0)
        .max(DEFAULT_CHEAPEST)
        .optional()
        .default(0)
        .describe(
          "Quantas ofertas mais baratas incluir POR ITEM. Multiplica o tamanho da resposta.",
        ),
    },
    listOffers: { item: itemRef, limit: limit(20) },
    history: {
      item: itemRef,
      dias: days(30),
      agrupamento: z.enum(["hour", "day"]).optional(),
    },
    appraise: {
      item: itemRef,
      preco: z
        .number()
        .int()
        .positive()
        .describe("Preço em zeny que se quer avaliar."),
    },
    movers: {
      dias: days(7),
      direcao: z.enum(["up", "down", "both"]).optional().default("both"),
      minLojas: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe(
          "Ignora itens com menos lojas que isso — variação de item ilíquido é ruído.",
        ),
      minPreco: z.number().int().min(0).optional().default(1000),
      limit: limit(20),
    },
    deals: {
      dias: days(14),
      minDesconto: z.number().int().min(1).max(99).optional().default(25),
      minPreco: z.number().int().min(0).optional().default(5000),
      limit: limit(20),
    },
    // O equivalente do `limit` de `GET /api/v1/snapshots`: a rota deixa escolher quantas
    // coletas listar, e não havia motivo para o agente ficar preso num número fixo.
    status: {
      coletas: limit(10, 50).describe("Quantas coletas recentes listar."),
    },
    marketIds: {},
    valueInventory: {
      dados: z
        .string()
        .describe("Conteúdo do arquivo .rrf codificado em base64."),
      incluirEquipados: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "Considera o equipamento em uso entre os candidatos a venda.",
        ),
      minValor: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(10_000)
        .describe(
          "Valor mínimo para um item entrar na lista de candidatos a venda.",
        ),
    },
  } as const;
}

/**
 * Montados uma vez por isolate, na primeira chamada.
 *
 * Continuam fora de `registerTools` pelo motivo medido acima, mas não podem mais ser
 * uma constante de módulo: `getPrices` dimensiona o `.max()` por
 * `config.limits.maxBatchItems`, e no Worker a configuração ainda não foi lida quando o
 * módulo é avaliado. O memo preserva o ganho e conserta a ordem.
 */
let schemas: ReturnType<typeof buildSchemas> | null = null;
const getSchemas = (): ReturnType<typeof buildSchemas> =>
  (schemas ??= buildSchemas());

/**
 * A mensagem de uma referência que não virou um item só.
 *
 * Separada do `resolveOrThrow` porque o lote não pode lançar: um nome ambíguo entre cem
 * derrubaria as outras noventa e nove resoluções boas. Lá ela vai numa lista ao lado dos
 * preços; aqui, na exceção. O texto é o mesmo nos dois — é o mesmo problema.
 */
function resolutionProblem(
  ref: string | number,
  resolved: Exclude<Resolution, { kind: "found" }>,
): string {
  if (resolved.kind === "ambiguous") {
    return (
      `"${ref}" casa com vários itens. Escolha um: ` +
      resolved.candidates.map((c) => `${c.name} (id ${c.itemId})`).join(", ")
    );
  }
  return `Nenhum item encontrado para "${ref}". Tente search_items primeiro.`;
}

/** Resolve a referência ou lança com os candidatos — o agente lê e repergunta. */
function resolveOrThrow(server: Server, ref: string | number): number {
  const resolved = resolveItem(server, ref);
  if (resolved.kind === "found") return resolved.item.itemId;
  throw new Error(resolutionProblem(ref, resolved));
}

export function registerTools(server: McpServer, db: Db): void {
  const SCHEMAS = getSchemas();
  const API_REPLAY_URL = replayUrl();

  // ---------------------------------------------------------------- busca

  registerJsonTool<{
    query?: string;
    tipo?: string;
    slot?: string;
    incluirForaDoMercado?: boolean;
    aVendaAgora?: boolean;
    ordenar?: SearchSort;
    decrescente?: boolean;
    limit?: number;
    offset?: number;
  }>(
    server,
    "search_items",
    {
      title: "Buscar itens",
      description:
        "Busca itens pelo nome, ou pelo id exato, e devolve o id de cada um. Use quando " +
        "não souber o id — as outras ferramentas também aceitam nome, então só é " +
        "necessário quando a busca é ampla. Um id exato vem primeiro e aparece mesmo " +
        "que o item não esteja à venda no momento. Com `ordenar` responde também " +
        "'quais são os mais baratos?' — a ordem sai do conjunto inteiro, não da página.",
      inputSchema: SCHEMAS.search,
    },
    (args, market) => {
      const result = searchItems({
        server: market,
        query: args.query,
        type: args.tipo,
        slot: args.slot,
        sort: args.ordenar,
        desc: args.decrescente,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        onlyInMarket: !args.incluirForaDoMercado,
        onlyForSale: args.aVendaAgora ?? false,
      });
      return json({
        ...paged(
          "itens",
          result.total,
          result.items,
          args.offset ?? 0,
          (i) => i,
        ),
        freshness: freshness(market),
      });
    },
  );

  // ---------------------------------------------------------------- preço

  registerJsonTool<{ item: string | number; ofertas?: number }>(
    server,
    "get_price",
    {
      title: "Preço de um item",
      description:
        "Quanto custa um item: a faixa histórica que o site publica e o resumo das lojas " +
        "abertas na última coleta. Responde 'quanto custa X?'. " +
        "Os dois números medem coisas diferentes e não devem ser somados: `market` é o " +
        "histórico de vendas do site, `offers` é o que dá para comprar agora.",
      inputSchema: SCHEMAS.getPrice,
    },
    (args, market) =>
      json({
        ...itemPrice(
          market,
          resolveOrThrow(market, args.item),
          args.ofertas ?? 5,
        ),
        freshness: freshness(market),
      }),
  );

  registerJsonTool<{ itens: Array<string | number>; ofertas?: number }>(
    server,
    "get_prices",
    {
      title: "Preço de vários itens de uma vez",
      description:
        "O mesmo que `get_price`, para uma lista de itens numa chamada só. Use quando já " +
        "tiver os ids — comparar uma lista, precificar um inventário, conferir favoritos. " +
        "Cada preço vem idêntico ao que `get_price` devolveria; id que o mercado não " +
        "conhece sai em `missing`, e referência que não resolveu (nome ambíguo ou " +
        "inexistente) sai em `naoResolvidos`, com o motivo — o lote nunca cai por causa " +
        "de uma linha.",
      inputSchema: SCHEMAS.getPrices,
    },
    (args, market) => {
      const { ids, unresolved } = resolveItems(market, args.itens);

      // Sem o `nextTradingAt` que a rota devolve: aquilo é para um cliente dormir até a
      // próxima coleta, e um agente não fica acordado esperando — ele pergunta quando
      // perguntam a ele. `data_status` responde a mesma coisa quando a pergunta aparece.
      return json({
        ...itemPrices(market, ids, args.ofertas ?? 0),
        ...(unresolved.length > 0
          ? {
              naoResolvidos: unresolved.map(({ ref, resolution }) => ({
                item: ref,
                motivo: resolutionProblem(ref, resolution),
              })),
            }
          : {}),
        freshness: freshness(market),
      });
    },
  );

  registerJsonTool<{ item: string | number; limit?: number }>(
    server,
    "list_offers",
    {
      title: "Listar ofertas",
      description:
        "Lojas vendendo um item agora, da mais barata para a mais cara, com vendedor e mapa. " +
        "Responde 'quero comprar X, me lista os preços'.",
      inputSchema: SCHEMAS.listOffers,
    },
    (args, market) => {
      const itemId = resolveOrThrow(market, args.item);
      const offers = cheapestOffers(market, itemId, args.limit ?? 20);
      return json({
        item: itemPrice(market, itemId, 0),
        ofertas: offers,
        freshness: freshness(market),
        ...(offers.length === 0
          ? { aviso: "Ninguém está vendendo este item na última coleta." }
          : {}),
      });
    },
  );

  registerJsonTool<{
    item: string | number;
    dias?: number;
    agrupamento?: "hour" | "day";
  }>(
    server,
    "price_history",
    {
      title: "Histórico de preço",
      description:
        "Série do preço ao longo do tempo. Responde 'subiu ou caiu?', 'quanto custava mês passado?'. " +
        "O histórico é construído a partir das nossas coletas, então começa quando o " +
        "serviço começou a coletar — não é o histórico completo do jogo.",
      inputSchema: SCHEMAS.history,
    },
    async (args, market) => {
      const itemId = resolveOrThrow(market, args.item);
      const points = await history(db, market, {
        itemId,
        days: args.dias ?? 30,
        bucket: args.agrupamento,
      });
      return json({
        item: itemPrice(market, itemId, 0),
        pontos: points,
        ...(points.length <= 1
          ? {
              aviso: "Ainda não há coletas suficientes para mostrar tendência.",
            }
          : {}),
      });
    },
  );

  registerJsonTool<{ item: string | number; preco: number }>(
    server,
    "appraise_price",
    {
      title: "Avaliar um preço",
      description:
        "Diz se um preço é bom para vender ou comprar. Responde 'vender isso por X é bom negócio?'. " +
        "Devolve quantas lojas estão mais baratas, o preço para ser o mais barato de todos, " +
        "e a comparação com a média dos últimos dias. " +
        "Não é previsão: os dados são do que está anunciado, não de vendas fechadas.",
      inputSchema: SCHEMAS.appraise,
    },
    async (args, market) =>
      json({
        ...(await appraise(
          db,
          market,
          resolveOrThrow(market, args.item),
          args.preco,
        )),
        freshness: freshness(market),
      }),
  );

  // ---------------------------------------------------------------- mercado

  registerJsonTool<{
    dias?: number;
    direcao?: "up" | "down" | "both";
    minLojas?: number;
    minPreco?: number;
    limit?: number;
  }>(
    server,
    "top_movers",
    {
      title: "Maiores variações",
      description:
        "Itens que mais subiram ou caíram de preço na janela. Responde 'o que está subindo?'. " +
        "Exige histórico acumulado; num banco recém-criado devolve lista vazia.",
      inputSchema: SCHEMAS.movers,
    },
    async (args, market) =>
      json({
        variacoes: await topMovers(db, market, {
          days: args.dias,
          direction: args.direcao,
          minStores: args.minLojas,
          minPrice: args.minPreco,
          limit: args.limit,
        }),
        freshness: freshness(market),
      }),
  );

  registerJsonTool<{
    dias?: number;
    minDesconto?: number;
    minPreco?: number;
    limit?: number;
  }>(
    server,
    "find_deals",
    {
      title: "Achar pechinchas",
      description:
        "Itens anunciados bem abaixo do que costumam custar. Responde 'tem alguma barganha?'. " +
        "Compara a oferta mais barata de agora com a mediana histórica do item.",
      inputSchema: SCHEMAS.deals,
    },
    async (args, market) =>
      json({
        pechinchas: await findDeals(db, market, {
          days: args.dias,
          minDiscountPct: args.minDesconto,
          minPrice: args.minPreco,
          limit: args.limit,
        }),
        freshness: freshness(market),
      }),
  );

  registerJsonTool<{ coletas?: number }>(
    server,
    "data_status",
    {
      title: "Estado dos dados",
      description:
        "Quando foi a última coleta e quantas existem. Consulte antes de afirmar um preço " +
        "como se fosse o de agora — e sempre que a pessoa perguntar se o dado está atualizado.",
      inputSchema: SCHEMAS.status,
    },
    async (args, market) =>
      json(await serviceStatus(db, market, args.coletas ?? 10)),
  );

  registerJsonTool<Record<string, never>>(
    server,
    "market_ids",
    {
      title: "Todos os ids do mercado (resposta grande)",
      description:
        "Dois vetores de ids: `inMarket`, tudo que já passou pelo mercado, e `forSale`, o " +
        "que tem anúncio ativo agora. Serve para cruzar com uma lista sua de itens — um " +
        "catálogo, um inventário, uma lista de desejos — e descobrir de uma vez o que dá " +
        "para comprar.\n\n" +
        "⚠ São alguns milhares de números, e você paga todos em contexto. Antes de pedir, " +
        "veja se a pergunta não é uma destas: para saber o que está à venda dentro de um " +
        "assunto, `search_items` com `aVendaAgora`; para conferir itens que você já sabe " +
        "quais são, `get_prices` — ele diz quem tem oferta e por quanto, na mesma chamada. " +
        "Esta ferramenta só ganha quando a lista do outro lado é grande e você a tem inteira.",
      inputSchema: SCHEMAS.marketIds,
    },
    // Sem `nextTradingAt`, como no `get_prices`: o campo é para um cliente dormir até a
    // coleta seguinte, e o agente não fica esperando — `data_status` responde a mesma
    // pergunta na hora em que ela é feita.
    (args, market) =>
      jsonCompact({ ...marketedIds(market), freshness: freshness(market) }),
  );

  // ---------------------------------------------------------------- replay

  registerJsonTool<{
    dados: string;
    incluirEquipados?: boolean;
    minValor?: number;
  }>(
    server,
    "value_inventory",
    {
      title: "Avaliar inventário de um replay (prefira a API)",
      description:
        "Lê um arquivo de replay (.rrf) do Ragnarok e devolve inventário, carrinho, equipamento " +
        "e os armazéns do Kafra e do clã, com o preço de mercado de cada item. Responde " +
        "'quanto vale o que eu tenho?', 'mostra o preço dos meus itens', " +
        "'o que dá para vender com lucro?', 'quanto vale meu armazém?'.\n\n" +
        "Os armazéns só aparecem se a janela foi aberta durante a gravação — o arquivo não " +
        "os guarda, o servidor os manda quando a janela abre. Vêm como `null` quando ninguém " +
        "abriu, que é diferente de um armazém vazio; nesse caso, para incluí-los, peça um " +
        "replay novo gravado com o armazém aberto. Quando existem, entram em `totalValue` — " +
        "então o total NÃO é comparável entre um replay que passou no Kafra e um que não.\n\n" +
        `⚠ PREFIRA A API SE VOCÊ CONSEGUE EXECUTAR COMANDOS. Mandar o arquivo por aqui ` +
        `exige codificá-lo em base64 dentro da chamada: um replay comum vira ~120 KB de ` +
        `texto, ou seja, dezenas de milhares de tokens do seu contexto — para um arquivo ` +
        `que você já tem em disco. A API recebe o binário direto e devolve o mesmo JSON:\n` +
        `  curl -X POST --data-binary @replay.rrf \\\n` +
        `    -H 'content-type: application/octet-stream' \\\n` +
        `    ${API_REPLAY_URL}\n` +
        `Use esta ferramenta apenas quando não houver como fazer a requisição — por ` +
        `exemplo, num cliente sem acesso a shell ou a rede.\n\n` +
        "Itens sem ninguém vendendo saem com preço nulo e não entram no total — o total nunca é chutado. " +
        "Refino, grau e cartas não são precificados: o mercado agrega por item, então um +9 sai " +
        "com o preço do item base e vem com um aviso.\n\n" +
        "Cada candidato a venda traz `origin`, dizendo de onde o item saiu (mochila, carrinho, " +
        "equipado, armazém do Kafra ou do clã). Vale repassar: sugerir a venda de algo que está " +
        "no armazém do clã, que é compartilhado, sem dizer que está lá, é enganoso.",
      inputSchema: SCHEMAS.valueInventory,
    },
    (args, market) => {
      const bytes = Buffer.from(args.dados, "base64");
      if (bytes.length < 112) {
        throw new Error(
          "base64 não contém um replay válido (arquivo pequeno demais).",
        );
      }
      const valuation = valueReplay(
        market,
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      );
      return json({
        ...valuation,
        candidatosAVenda: sellCandidates(valuation, {
          minValue: args.minValor,
          includeEquipped: args.incluirEquipados,
        }),
        // O aviso vai no resultado, e não só na descrição, porque a descrição é lida
        // antes de decidir e esta mensagem chega depois de o custo ter sido pago —
        // que é justamente quando ela é concreta.
        notes: [
          ...valuation.notes,
          `Este replay custou ${Math.round(args.dados.length / 1024)} KB de base64 no seu contexto. ` +
            `Da próxima vez, se puder fazer requisições HTTP, mande o arquivo binário para ` +
            `${API_REPLAY_URL} e receba o mesmo resultado sem esse custo.`,
        ],
      });
    },
  );
}
