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

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { appraise } from "../core/appraise.js";
import { resolveItem, searchItems } from "../core/items.js";
import { findDeals, topMovers } from "../core/movers.js";
import { cheapestOffers, freshness, history, itemPrice } from "../core/prices.js";
import { sellCandidates, valueReplay } from "../core/replay.js";
import type { Server } from "../core/servers.js";
import { serviceStatus } from "../core/status.js";
import { EQUIP_SLOTS, ITEM_CATEGORIES } from "../core/taxonomy.js";

import { config } from "../server/config.js";
import { json, paged, registerJsonTool } from "./helpers.js";

/** Rota que recebe o `.rrf` binário, sem o custo do base64. */
const API_REPLAY_URL = `${config.publicUrl}/api/v1/replay`;

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
  .describe("Id numérico do item ou parte do nome (acentos e maiúsculas são ignorados).");

const days = (fallback: number) =>
  z.number().int().min(1).max(365).optional().default(fallback);

const limit = (fallback: number, max = 100) =>
  z.number().int().min(1).max(max).optional().default(fallback);

const SCHEMAS = {
  search: {
    query: z
      .string()
      .optional()
      .describe('Texto livre ou id exato. "pocao" acha "Poção"; "501" acha o item 501. Opcional quando há `tipo` ou `slot`.'),
    tipo: z
      .enum(ITEM_CATEGORIES.map((c) => c.id) as [string, ...string[]])
      .optional()
      .describe("Categoria do item. Combine com `slot` para restringir mais."),
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
  listOffers: { item: itemRef, limit: limit(20) },
  history: {
    item: itemRef,
    dias: days(30),
    agrupamento: z.enum(["hour", "day"]).optional(),
  },
  appraise: {
    item: itemRef,
    preco: z.number().int().positive().describe("Preço em zeny que se quer avaliar."),
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
      .describe("Ignora itens com menos lojas que isso — variação de item ilíquido é ruído."),
    minPreco: z.number().int().min(0).optional().default(1000),
    limit: limit(20),
  },
  deals: {
    dias: days(14),
    minDesconto: z.number().int().min(1).max(99).optional().default(25),
    minPreco: z.number().int().min(0).optional().default(5000),
    limit: limit(20),
  },
  status: {},
  valueInventory: {
    dados: z.string().describe("Conteúdo do arquivo .rrf codificado em base64."),
    incluirEquipados: z
      .boolean()
      .optional()
      .default(false)
      .describe("Considera o equipamento em uso entre os candidatos a venda."),
    minValor: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(10_000)
      .describe("Valor mínimo para um item entrar na lista de candidatos a venda."),
  },
} as const;

/** Resolve a referência ou lança com os candidatos — o agente lê e repergunta. */
function resolveOrThrow(server: Server, ref: string | number): number {
  const resolved = resolveItem(server, ref);
  if (resolved.kind === "found") return resolved.item.itemId;
  if (resolved.kind === "ambiguous") {
    throw new Error(
      `"${ref}" casa com vários itens. Escolha um: ` +
        resolved.candidates.map((c) => `${c.name} (id ${c.itemId})`).join(", "),
    );
  }
  throw new Error(`Nenhum item encontrado para "${ref}". Tente search_items primeiro.`);
}

export function registerTools(server: McpServer, db: DatabaseSync): void {
  // ---------------------------------------------------------------- busca

  registerJsonTool<{
    query?: string;
    tipo?: string;
    slot?: string;
    incluirForaDoMercado?: boolean;
    aVendaAgora?: boolean;
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
        "que o item não esteja à venda no momento.",
      inputSchema: SCHEMAS.search,
    },
    (args, market) => {
      const result = searchItems({
        server: market,
        query: args.query,
        type: args.tipo,
        slot: args.slot,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        onlyInMarket: !args.incluirForaDoMercado,
        onlyForSale: args.aVendaAgora ?? false,
      });
      return json({
        ...paged("itens", result.total, result.items, args.offset ?? 0, (i) => i),
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
      json({ ...itemPrice(market, resolveOrThrow(market, args.item), args.ofertas ?? 5), freshness: freshness(market) }),
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

  registerJsonTool<{ item: string | number; dias?: number; agrupamento?: "hour" | "day" }>(
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
    (args, market) => {
      const itemId = resolveOrThrow(market, args.item);
      const points = history(db, market, { itemId, days: args.dias ?? 30, bucket: args.agrupamento });
      return json({
        item: itemPrice(market, itemId, 0),
        pontos: points,
        ...(points.length <= 1
          ? { aviso: "Ainda não há coletas suficientes para mostrar tendência." }
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
    (args, market) =>
      json({ ...appraise(db, market, resolveOrThrow(market, args.item), args.preco), freshness: freshness(market) }),
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
    (args, market) =>
      json({
        variacoes: topMovers(db, market, {
          days: args.dias,
          direction: args.direcao,
          minStores: args.minLojas,
          minPrice: args.minPreco,
          limit: args.limit,
        }),
        freshness: freshness(market),
      }),
  );

  registerJsonTool<{ dias?: number; minDesconto?: number; minPreco?: number; limit?: number }>(
    server,
    "find_deals",
    {
      title: "Achar pechinchas",
      description:
        "Itens anunciados bem abaixo do que costumam custar. Responde 'tem alguma barganha?'. " +
        "Compara a oferta mais barata de agora com a mediana histórica do item.",
      inputSchema: SCHEMAS.deals,
    },
    (args, market) =>
      json({
        pechinchas: findDeals(db, market, {
          days: args.dias,
          minDiscountPct: args.minDesconto,
          minPrice: args.minPreco,
          limit: args.limit,
        }),
        freshness: freshness(market),
      }),
  );

  registerJsonTool<Record<string, never>>(
    server,
    "data_status",
    {
      title: "Estado dos dados",
      description:
        "Quando foi a última coleta e quantas existem. Consulte antes de afirmar um preço " +
        "como se fosse o de agora — e sempre que a pessoa perguntar se o dado está atualizado.",
      inputSchema: SCHEMAS.status,
    },
    (args, market) => json(serviceStatus(db, market, 10)),
  );

  // ---------------------------------------------------------------- replay

  registerJsonTool<{ dados: string; incluirEquipados?: boolean; minValor?: number }>(
    server,
    "value_inventory",
    {
      title: "Avaliar inventário de um replay (prefira a API)",
      description:
        "Lê um arquivo de replay (.rrf) do Ragnarok e devolve inventário, carrinho e equipamento " +
        "com o preço de mercado de cada item. Responde 'quanto vale o que eu tenho?', " +
        "'mostra o preço dos meus itens', 'o que dá para vender com lucro?'.\n\n" +
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
        "Refino e cartas não são precificados: o mercado agrega por item, então um +9 sai " +
        "com o preço do item base e vem com um aviso.",
      inputSchema: SCHEMAS.valueInventory,
    },
    (args, market) => {
      const bytes = Buffer.from(args.dados, "base64");
      if (bytes.length < 112) {
        throw new Error("base64 não contém um replay válido (arquivo pequeno demais).");
      }
      const valuation = valueReplay(market, 
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
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
