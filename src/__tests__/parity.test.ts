/**
 * A API e o MCP têm que responder a mesma coisa.
 *
 * Este teste é o que sustenta a regra "api/ e mcp/ só chamam core/". Nada impede alguém
 * de, com pressa, montar uma consulta direto dentro de um handler; o que impede é isto
 * quebrar quando ele fizer.
 *
 * Roda DENTRO do `workerd`, pelo mesmo `worker.ts` que é publicado, com D1 e R2 locais.
 * O andaime (semeadura pela rota de ingestão, chamadas ao MCP, helpers de host) está em
 * `parity-setup.ts`.
 */

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { nextTradingRun } from "../core/schedule.js";
import { config, tradingEveryMinFor } from "../config.js";
import { DEFAULT_SERVER } from "../core/servers.js";
import type { MarketPriceRow, TradingRow } from "../store/rows.js";
import {
  applyMigrations,
  callTool,
  getJson,
  getResponse,
  ingest,
  ingestUnsigned,
  ORIGIN,
  listTools,
  replayFixture,
  statusFromHost,
  toBase64,
  type ToolInfo,
} from "./parity-setup.js";

const ITEM_ID = 501;
/** Visto no mercado um dia, sem anúncio hoje: a diferença entre os dois filtros. */
const SOLD_OUT = 909;
/**
 * Dois itens que só existem no armazém do `storage-test.rrf` — 11568 no do Kafra (100
 * unidades), 12580 no do clã (140).
 *
 * Precisam de anúncio para que "item guardado pode ser candidato a venda" tenha o que
 * provar: sem preço, o filtro de valor mínimo derruba o armazém inteiro e o teste passaria
 * por não ter testado nada. Entram no MESMO snapshot de `trading` que o `ITEM_ID` — cada
 * snapshot é o retrato completo do que está à venda agora, então um segundo snapshot não
 * acrescentaria, substituiria.
 */
const KAFRA_ITEM = 11568;
const CLAN_ITEM = 12580;
/** Poção Laranja: casa com `q=pocao` e tem oferta. */
const CARA = 502;
/** Poção Amarela: casa com a busca, foi vista no mercado, e não tem oferta agora. */
const SEM_OFERTA = 503;

const anuncio = (
  itemId: number,
  itemName: string,
  price: number,
  i: number,
  prefix = "ssi",
): TradingRow => ({
  itemId,
  mapId: 1,
  ssi: `${prefix}-${itemId}-${i}`,
  itemName,
  databaseImgPath: null,
  databaseType: "healing",
  storeName: `Loja ${i}`,
  itemPrice: price,
  itemCnt: 10,
  slotMaxCount: "",
  storeTypeName: "BUY",
  itemSellerCharName: `Vendedor${i}`,
});

/**
 * O mundo dos testes, montado pela rota real de ingestão.
 *
 * A ordem importa e é a de produção: primeiro o agregado do site (`market-price`), depois
 * os anúncios (`trading`). O `SOLD_OUT` entra num crawl de anúncios ANTERIOR e não aparece
 * no atual — é assim que ele fica "já visto no mercado, sem oferta agora" sem precisar de
 * nenhuma escrita fora do caminho normal, porque `inMarket` é carregado adiante de um
 * retrato para o outro.
 */
beforeAll(async () => {
  await applyMigrations();

  await ingest({
    dataset: "market-price",
    server: "FREYA",
    startedAt: 1_700_000_000,
    crawlId: "seed-market-freya",
    rows: [
      {
        itemId: ITEM_ID,
        itemName: "Poção Vermelha",
        databaseImgPath: null,
        databaseType: "healing",
        totalItemCnt: 5000,
        minItemPrice: 40,
        maxItemPrice: 120,
        avgItemPrice: 60,
      } satisfies MarketPriceRow,
    ],
  });

  // Coleta antiga: é só aqui que o esgotado aparece à venda.
  await ingest({
    dataset: "trading",
    server: "FREYA",
    startedAt: 1_700_000_050,
    crawlId: "seed-trading-freya-antigo",
    rows: [
      anuncio(SOLD_OUT, "Jellopy", 30, 0, "velho"),
      // Entra aqui e some da coleta seguinte: é assim que ele fica "já visto no mercado,
      // sem oferta agora" sem nenhuma escrita fora do caminho normal de ingestão.
      anuncio(SEM_OFERTA, "Poção Amarela", 70, 1, "velho"),
    ],
  });

  await ingest({
    dataset: "trading",
    server: "FREYA",
    startedAt: 1_700_000_100,
    crawlId: "seed-trading-freya",
    rows: [
      ...[50, 55, 70, 90].map((price, i) => anuncio(ITEM_ID, "Poção Vermelha", price, i)),
      ...[KAFRA_ITEM, CLAN_ITEM].flatMap((itemId) =>
        [500, 550].map((price, i) => ({
          ...anuncio(itemId, `Item ${itemId}`, price, i, "arm"),
          databaseType: "etc",
          itemCnt: 20,
        })),
      ),
    ],
  });

  /** O mesmo item, com outro preço, em NIDHOGG — para provar que os dois não se misturam. */
  await ingest({
    dataset: "trading",
    server: "NIDHOGG",
    startedAt: 1_700_000_200,
    crawlId: "seed-trading-nidhogg",
    rows: [900, 950].map((price, i) => anuncio(ITEM_ID, "Poção Vermelha", price, i, "nid")),
  });
});

describe("paridade entre API e MCP", () => {
  it("get_price devolve o mesmo que GET /items/:id", async () => {
    const [rest, mcp] = await Promise.all([
      getJson(`/api/v1/items/${ITEM_ID}?offers=5`),
      callTool("get_price", { item: ITEM_ID, ofertas: 5 }),
    ]);
    expect(mcp).toEqual(rest);
  });

  it("appraise_price devolve o mesmo que GET /items/:id/appraise", async () => {
    const [rest, mcp] = await Promise.all([
      getJson(`/api/v1/items/${ITEM_ID}/appraise?price=60`),
      callTool("appraise_price", { item: ITEM_ID, preco: 60 }),
    ]);
    expect(mcp).toEqual(rest);
  });

  it("data_status devolve o mesmo que GET /snapshots", async () => {
    const [rest, mcp] = await Promise.all([
      getJson("/api/v1/snapshots?limit=3"),
      callTool("data_status", { coletas: 3 }),
    ]);
    expect(mcp).toEqual(rest);
  });

  it("resolve o item por nome nos dois canais", async () => {
    const rest = (await getJson("/api/v1/items/Po%C3%A7%C3%A3o%20Vermelha")) as { itemId: number };
    const mcp = (await callTool("get_price", { item: "pocao vermelha" })) as { itemId: number };
    expect(rest.itemId).toBe(ITEM_ID);
    expect(mcp.itemId).toBe(ITEM_ID);
  });

  /**
   * Buscar pelo id só funcionava nas rotas que passam por `resolveItem`; a busca
   * varria apenas o nome e devolvia vazio. Quem digita um id no campo de busca — na
   * interface ou pelo agente — estava sendo mandado embora de mãos vazias.
   */
  it("busca pelo id do item nos dois canais", async () => {
    const rest = (await getJson(`/api/v1/items?q=${ITEM_ID}`)) as {
      total: number;
      items: { itemId: number }[];
    };
    // O envelope do MCP usa `itens`, em português, como as demais listas paginadas.
    const mcp = (await callTool("search_items", { query: String(ITEM_ID) })) as {
      itens: { itemId: number }[];
    };
    expect(rest.total).toBeGreaterThan(0);
    expect(rest.items[0]?.itemId).toBe(ITEM_ID);
    expect(mcp.itens[0]?.itemId).toBe(ITEM_ID);
  });
});

describe("números do mercado", () => {
  it("separa o agregado do site das ofertas de agora", async () => {
    const price = (await getJson(`/api/v1/items/${ITEM_ID}`)) as {
      market: { min: number; avg: number };
      offers: { stores: number; min: number; median: number; max: number; units: number };
      cheapest: Array<{ price: number }>;
    };
    // Do market-price: o histórico que o site publica.
    expect(price.market).toMatchObject({ min: 40, avg: 60 });
    // Das lojas: 50, 55, 70, 90 — mediana por posição é o índice (4-1)/2 = 1.
    expect(price.offers).toMatchObject({ stores: 4, min: 50, median: 55, max: 90, units: 40 });
    expect(price.cheapest[0]!.price).toBe(50);
  });

  it("conta a concorrência corretamente na avaliação", async () => {
    const a = (await getJson(`/api/v1/items/${ITEM_ID}/appraise?price=71`)) as {
      verdict: string;
      competition: { cheaperStores: number; undercutPrice: number };
    };
    // 50, 55 e 70 são mais baratos que 71.
    expect(a.competition.cheaperStores).toBe(3);
    expect(a.competition.undercutPrice).toBe(49);
    expect(a.verdict).toBe("caro");

    const best = (await getJson(`/api/v1/items/${ITEM_ID}/appraise?price=45`)) as {
      verdict: string;
      competition: { cheaperStores: number };
    };
    expect(best.competition.cheaperStores).toBe(0);
    expect(best.verdict).toBe("barato");
  });
});

describe("higiene do HTTP", () => {
  it("recusa Host fora da allowlist (DNS rebinding)", async () => {
    expect(await statusFromHost("/api/v1/status", "evil.example.com")).toBe(403);
  });

  it("/healthz responde sem passar pela allowlist", async () => {
    // O systemd e o workflow de deploy batem no health check por IP, sem o nome de
    // domínio, então ele tem que responder antes da allowlist.
    expect(await statusFromHost("/healthz", "evil.example.com")).toBe(200);
  });

  it("MCP só aceita POST", async () => {
    expect((await SELF.fetch(`${ORIGIN}/mcp`)).status).toBe(405);
  });

  /**
   * Uma coleta de agregado não pode apagar os anúncios.
   *
   * Substitui o teste do snapshot `source = 'live'`: aquele guardava a escolha do snapshot
   * corrente numa consulta que não existe mais — hoje quem manda é o ponteiro no R2. O
   * risco equivalente no desenho novo é este: o retrato é a UNIÃO de dois datasets, e cada
   * ingestão reescreve só a metade dela. Se a metade errada fosse zerada, o mercado
   * apareceria vazio entre uma coleta de `market-price` e a próxima de `trading`.
   */
  it("uma coleta de market-price preserva os anúncios do retrato", async () => {
    await ingest({
      dataset: "market-price",
      server: "FREYA",
      startedAt: 1_800_000_000,
      crawlId: "market-freya-posterior",
      rows: [
        {
          itemId: ITEM_ID, itemName: "Poção Vermelha",
          databaseImgPath: null, databaseType: "healing",
          // Só o total muda: `min` e `avg` são conferidos por testes adiante, e uma
          // coleta de market-price reescreve o agregado INTEIRO do servidor.
          totalItemCnt: 6000, minItemPrice: 40, maxItemPrice: 120, avgItemPrice: 60,
        } satisfies MarketPriceRow,
      ],
    });

    const item = (await getJson(`/api/v1/items/${ITEM_ID}?offers=5`)) as {
      cheapest: { price: number }[];
      offers: { stores: number; min: number } | null;
      market: { totalSold: number | null } | null;
    };
    expect(item.cheapest).toHaveLength(4);
    expect(item.cheapest[0]!.price).toBe(50);
    expect(item.offers?.stores).toBe(4);
    // E o agregado novo entrou: a metade que MUDOU foi trocada, a outra ficou.
    expect(item.market?.totalSold).toBe(6000);
  });
});

/** Sanidade: o fixture do replay continua decodificando pelo caminho da API. */
describe("replay pela API", () => {
  it("aceita upload do .rrf e devolve os três containers", async () => {
    const file = replayFixture("equip-test-2.rrf");
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    const body = (await res.json()) as {
      inventory: { items: unknown[] };
      cart: { items: unknown[] };
      equipped: { items: unknown[] };
    };
    expect(res.status).toBe(200);
    expect(body.inventory.items).toHaveLength(34);
    expect(body.cart.items).toHaveLength(17);
    expect(body.equipped.items).toHaveLength(8);
  });

  /**
   * Os campos de mercado saem do cache, não do replay — some um deles e o item some
   * junto, calado, com a contagem acima ainda passando. A interface web monta a tabela
   * em cima deles, então a presença é parte do contrato.
   */
  it("cada item traz slot, unidades e o agregado do site", async () => {
    const file = replayFixture("equip-test-2.rrf");
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    const body = (await res.json()) as {
      inventory: { items: { slot: number; units: number | null; market: unknown }[] };
    };

    for (const item of body.inventory.items) {
      expect(item).toHaveProperty("slot");
      expect(item).toHaveProperty("units");
      expect(item).toHaveProperty("market");
      expect(typeof item.slot).toBe("number");
    }
  });

  it("recusa um arquivo que não é replay", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(200).fill(7),
    });
    expect(res.status).toBe(422);
  });
});

/**
 * Os armazéns atravessam as DUAS superfícies, ou não valem nada.
 *
 * `decode.test.ts` prova que eles saem do arquivo; isto prova que chegam a quem pergunta.
 * É o mesmo furo do teste de `slot`/`units` acima — um campo que some entre o core e o
 * JSON não quebra nada, só faz o armazém desaparecer sem aviso, e a interface (as duas
 * cifras novas do cabeçalho) e o agente montam em cima deles.
 */
describe("armazém pela API e pelo MCP", () => {
  const fixture = (): Uint8Array => replayFixture("storage-test.rrf");

  interface StorageBody {
    storage: { items: unknown[]; value: number; usedSlots: number; maxSlots: number } | null;
    guildStorage: { items: unknown[]; value: number; maxSlots: number } | null;
    totalValue: number;
    inventory: { value: number };
    cart: { value: number };
    equipped: { value: number };
  }

  async function viaApi(): Promise<StorageBody & { sellCandidates: { origin: string }[] }> {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: fixture(),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as StorageBody & { sellCandidates: { origin: string }[] };
  }

  it("a API devolve os dois armazéns com a ocupação do servidor", async () => {
    const body = await viaApi();
    expect(body.storage?.items).toHaveLength(35);
    expect(body.storage?.maxSlots).toBe(300);
    expect(body.guildStorage?.items).toHaveLength(2);
    expect(body.guildStorage?.maxSlots).toBe(200);
  });

  it("os armazéns entram no totalValue", async () => {
    const body = await viaApi();
    const storages = (body.storage?.value ?? 0) + (body.guildStorage?.value ?? 0);
    // > 0 para o teste não passar por os dois armazéns valerem zero, caso em que a soma
    // abaixo fecharia sozinha sem provar nada.
    expect(storages).toBeGreaterThan(0);
    expect(body.totalValue).toBe(
      body.inventory.value + body.cart.value + body.equipped.value + storages,
    );
  });

  it("todo candidato a venda diz de onde o item saiu", async () => {
    const body = await viaApi();
    // Sem `origin` a sugestão não é acionável, e a do armazém do clã não avisaria que o
    // item é compartilhado.
    for (const c of body.sellCandidates) expect(typeof c.origin).toBe("string");
    const origins = new Set(body.sellCandidates.map((c) => c.origin));
    expect(origins.has("storage")).toBe(true);
    expect(origins.has("guildStorage")).toBe(true);
  });

  it("um replay sem armazém aberto devolve null, e não vazio", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: replayFixture("equip-test-2.rrf"),
    });
    const body = (await res.json()) as StorageBody & { notes: string[] };
    // `null` é "ninguém abriu"; uma lista vazia seria a afirmação de que está vazio.
    expect(body.storage).toBeNull();
    expect(body.guildStorage).toBeNull();
    // Faltam os dois, então a nota vem no plural — pinça a concordância junto com a
    // afirmação que importa, a de que ausência não é armazém vazio.
    expect(body.notes.some((n) => n.includes("não foram abertos"))).toBe(true);
    expect(body.notes.some((n) => n.includes("não é o mesmo que estar vazio"))).toBe(true);
  });

  it("o MCP responde o mesmo que a API", async () => {
    const api = await viaApi();
    const mcp = (await callTool("value_inventory", {
      dados: toBase64(fixture()),
    })) as StorageBody & { candidatosAVenda: { origin: string }[] };

    expect(mcp.storage?.items).toHaveLength(api.storage?.items.length ?? -1);
    expect(mcp.guildStorage?.maxSlots).toBe(api.guildStorage?.maxSlots);
    expect(mcp.totalValue).toBe(api.totalValue);
    expect(mcp.candidatosAVenda.map((c) => c.origin)).toEqual(
      api.sellCandidates.map((c) => c.origin),
    );
  });
});

/**
 * O `.rrf` em base64 gasta dezenas de milhares de tokens do contexto do agente para
 * um arquivo que ele já tem em disco. A ferramenta precisa dizer isso — e a rota da
 * API precisa existir de verdade, senão o conselho manda o agente para o vazio.
 */
describe("desvio do replay para a API", () => {
  it("a ferramenta aponta para a rota binária", async () => {
    const tool = (await listTools()).find((t) => t.name === "value_inventory")!;
    expect(tool.description).toContain("/api/v1/replay");
    expect(tool.description).toMatch(/tokens/i);
  });

  it("a rota que a ferramenta recomenda responde de verdade", async () => {
    const file = replayFixture("equip-test-2.rrf");
    const res = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { cart: { items: unknown[] } }).cart.items).toHaveLength(17);
  });
});

/**
 * O motivo de existir a coluna `server` nas tabelas de rollup.
 *
 * Antes da v3 elas tinham chave `(item_id, ts)`, então o segundo servidor não conviveria
 * com o primeiro — sobrescreveria. Aqui o mesmo item tem preços bem diferentes nos dois,
 * e cada canal precisa devolver o do servidor que foi pedido.
 */
describe("isolamento entre servidores", () => {

  it("o preço de cada servidor é o seu", async () => {
    const freya = (await getJson(`/api/v1/items/${ITEM_ID}`)) as {
      offers: { min: number; stores: number };
    };
    const nidhogg = (await getJson(`/api/v1/items/${ITEM_ID}?server=NIDHOGG`)) as {
      offers: { min: number; stores: number };
    };

    expect(freya.offers.min).toBe(50);
    expect(freya.offers.stores).toBe(4);
    expect(nidhogg.offers.min).toBe(900);
    expect(nidhogg.offers.stores).toBe(2);
  });

  it("o MCP concorda com o REST em cada servidor", async () => {
    for (const server of ["FREYA", "NIDHOGG"]) {
      const [rest, mcp] = await Promise.all([
        getJson(`/api/v1/items/${ITEM_ID}?server=${server}&offers=5`),
        callTool("get_price", { item: ITEM_ID, ofertas: 5, servidor: server }),
      ]);
      expect(mcp).toEqual(rest);
    }
  });

  it("ausência de servidor continua significando FREYA", async () => {
    const semParam = (await getJson(`/api/v1/items/${ITEM_ID}`)) as { offers: { min: number } };
    const explicito = (await getJson(`/api/v1/items/${ITEM_ID}?server=FREYA`)) as {
      offers: { min: number };
    };
    expect(semParam.offers.min).toBe(explicito.offers.min);
  });

  it("o link do mercado aponta para o servidor pedido", async () => {
    const nidhogg = (await getJson(`/api/v1/items/${ITEM_ID}?server=NIDHOGG`)) as {
      links: { market: string };
    };
    expect(new URL(nidhogg.links.market).searchParams.get("serverType")).toBe("NIDHOGG");
  });

  it("servidor inexistente é 400, e não o padrão em silêncio", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/items/${ITEM_ID}?server=NIDOGG`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { erro: string }).erro).toContain("NIDOGG");
  });
});

/**
 * "Já apareceu no mercado" e "está à venda agora" são perguntas diferentes.
 *
 * O fixture tem a Poção Vermelha com anúncios ativos em FREYA e um item marcado como
 * visto no mercado que não tem anúncio nenhum — é a diferença entre os dois filtros, e
 * sem teste ela sumiria no dia em que alguém achasse que um implica o outro.
 */
describe("filtro à venda agora", () => {
  it("sem o filtro, o esgotado aparece", async () => {
    const r = (await getJson("/api/v1/items?q=jellopy")) as { items: { itemId: number }[] };
    expect(r.items.map((i) => i.itemId)).toContain(SOLD_OUT);
  });

  it("com o filtro, some — ninguém está vendendo", async () => {
    const r = (await getJson("/api/v1/items?q=jellopy&for_sale=1")) as {
      total: number;
      items: unknown[];
    };
    expect(r.total).toBe(0);
  });

  it("quem tem anúncio ativo continua aparecendo", async () => {
    const r = (await getJson(`/api/v1/items?q=pocao&for_sale=1`)) as {
      items: { itemId: number }[];
    };
    expect(r.items.map((i) => i.itemId)).toContain(ITEM_ID);
  });

  it("um id exato ignora o filtro — foi pedido pelo nome próprio", async () => {
    const r = (await getJson(`/api/v1/items?q=${SOLD_OUT}&for_sale=1`)) as {
      items: { itemId: number }[];
    };
    expect(r.items[0]?.itemId).toBe(SOLD_OUT);
  });

  it("REST e MCP concordam no recorte", async () => {
    const rest = (await getJson("/api/v1/items?q=jellopy&for_sale=1")) as { total: number };
    const mcp = (await callTool("search_items", {
      query: "zargao",
      aVendaAgora: true,
    })) as { total: number };
    expect(mcp.total).toBe(rest.total);
  });
});

/**
 * Leitura em lote, para a aba Favoritos não gastar uma requisição por item vigiado.
 *
 * O primeiro teste é o que mais importa: em lote a resposta tem que ser *idêntica* à
 * individual. É o que impede alguém, mais adiante, "otimizar" a rota com uma consulta
 * própria e fazer as duas divergirem em silêncio — exatamente o acidente que este
 * arquivo existe para pegar.
 */
describe("preços em lote", () => {
  it("um item em lote é igual ao mesmo item sozinho", async () => {
    const [lote, sozinho] = (await Promise.all([
      getJson(`/api/v1/prices?items=${ITEM_ID}&offers=5`),
      getJson(`/api/v1/items/${ITEM_ID}?offers=5`),
    ])) as [{ prices: unknown[] }, Record<string, unknown>];

    const { freshness: _ignorado, ...esperado } = sozinho;
    expect(lote.prices[0]).toEqual(esperado);
  });

  /**
   * O lote existe nos dois canais, e responde a mesma coisa.
   *
   * Menos o `nextTradingAt`: ele serve para um cliente dormir até a próxima coleta, e o
   * agente não fica acordado esperando. É a única diferença permitida entre os dois.
   */
  it("get_prices devolve o mesmo que GET /prices", async () => {
    const [rest, mcp] = await Promise.all([
      getJson(`/api/v1/prices?items=${ITEM_ID}&offers=5`),
      callTool("get_prices", { itens: [ITEM_ID], ofertas: 5 }),
    ]);
    const { nextTradingAt: _semRelogio, ...esperado } = rest as Record<string, unknown>;
    expect(mcp).toEqual(esperado);
  });

  /**
   * Uma referência ruim no meio da lista não derruba as outras.
   *
   * O `get_price` sozinho pode lançar — a chamada era sobre aquele item e mais nada. No
   * lote, lançar por causa de um nome errado jogaria fora as noventa e nove resoluções
   * boas que vieram junto, e o agente pagaria a chamada inteira de novo.
   */
  it("aceita nome no lote e reporta o que não resolveu, sem perder o resto", async () => {
    const r = (await callTool("get_prices", {
      itens: ["pocao vermelha", "isso nao existe"],
    })) as {
      prices: { itemId: number }[];
      naoResolvidos: { item: string; motivo: string }[];
    };
    expect(r.prices.map((p) => p.itemId)).toEqual([ITEM_ID]);
    expect(r.naoResolvidos).toHaveLength(1);
    expect(r.naoResolvidos[0]!.item).toBe("isso nao existe");
  });

  it("id desconhecido vai para 'missing' em vez de sumir", async () => {
    const r = (await getJson(`/api/v1/prices?items=${ITEM_ID},999999`)) as {
      prices: { itemId: number }[];
      missing: number[];
    };
    expect(r.prices.map((p) => p.itemId)).toEqual([ITEM_ID]);
    expect(r.missing).toEqual([999999]);
  });

  it("id repetido é lido uma vez só", async () => {
    const r = (await getJson(`/api/v1/prices?items=${ITEM_ID},${ITEM_ID},${ITEM_ID}`)) as {
      prices: unknown[];
    };
    expect(r.prices).toHaveLength(1);
  });

  it("cada servidor devolve o seu preço", async () => {
    const [freya, nidhogg] = (await Promise.all([
      getJson(`/api/v1/prices?items=${ITEM_ID}`),
      getJson(`/api/v1/prices?items=${ITEM_ID}&server=NIDHOGG`),
    ])) as [{ prices: { offers: { min: number } }[] }, { prices: { offers: { min: number } }[] }];

    expect(freya.prices[0]?.offers.min).toBe(50);
    expect(nidhogg.prices[0]?.offers.min).toBe(900);
  });

  it("sem 'items' é 400 — pedir tudo não é uma pergunta", async () => {
    expect((await SELF.fetch(`${ORIGIN}/api/v1/prices`)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/v1/prices?items=`)).status).toBe(400);
    expect((await SELF.fetch(`${ORIGIN}/api/v1/prices?items=abc,-1,0`)).status).toBe(400);
  });

  /**
   * Passar do teto é 400, e não corte silencioso como no `limit` das buscas.
   *
   * Cortar uma lista de resultados devolve menos resultados; cortar uma lista de ids
   * PEDIDOS deixaria o alerta do 101º favorito sem avaliação, sem ninguém saber.
   */
  it("mais de 100 ids é 400, não uma lista cortada", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    const res = await SELF.fetch(`${ORIGIN}/api/v1/prices?items=${ids}`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { pedidos: number }).toMatchObject({ pedidos: 101 });

    const noTeto = Array.from({ length: 100 }, (_, i) => i + 1).join(",");
    expect((await SELF.fetch(`${ORIGIN}/api/v1/prices?items=${noTeto}`)).status).toBe(200);
  });

  /**
   * Sem agendador no processo, a resposta ESTIMA a próxima coleta a partir da última mais a
   * cadência configurada.
   *
   * É o que permite ao cliente dormir até o dado novo em vez de escolher um intervalo no
   * escuro — e por isso a aba Favoritos não tem (nem precisa de) um campo de intervalo.
   */
  it("'nextTradingAt' é a última coleta mais a cadência", async () => {
    const r = (await getJson(`/api/v1/prices?items=${ITEM_ID}`)) as {
      nextTradingAt: number;
      freshness: { tradingAt: number };
    };
    // Pela cadência DO SERVIDOR consultado, não pela global: a rota não passa `server`,
    // então responde pelo padrão — e é a cadência dele que vira o `max-age` que faz a aba
    // dormir. Com FREYA e NIDHOGG em cadências diferentes, comparar com a global passaria
    // a reprovar sem nada estar errado.
    expect(r.nextTradingAt).toBe(
      r.freshness.tradingAt + tradingEveryMinFor(DEFAULT_SERVER) * 60,
    );
  });

  it("a hora exata do agendador manda mais que a estimativa", () => {
    expect(nextTradingRun(12_345, 1_000, 30)).toBe(12_345);
  });

  it("sem agendador, estima; sem coleta nenhuma, não há o que estimar", async () => {
    expect(nextTradingRun(null, 1_000, 30)).toBe(1_000 + 1_800);
    expect(nextTradingRun(null, null, 30)).toBeNull();
  });
});

/**
 * A busca ordena o CONJUNTO, não a página.
 *
 * A tabela do site pagina de cinquenta em cinquenta sobre um total que pode ser mil.
 * Ordenar no navegador responderia "o mais barato destes cinquenta" com cara de "o mais
 * barato" — por isso a ordem sai daqui, junto com o preço de cada linha.
 *
 * Fica por último de propósito: o `beforeAll` publica uma coleta de anúncios nova, e o
 * cache só enxerga a mais recente.
 */
describe("ordenação e lista de ids na busca", () => {

  const anuncio = (itemId: number, itemName: string, price: number, i: number): TradingRow => ({
    itemId, mapId: 1, ssi: `ord-${itemId}-${i}`, itemName,
    databaseImgPath: null, databaseType: "healing",
    storeName: `Loja ${i}`, itemPrice: price, itemCnt: 10, slotMaxCount: "",
    storeTypeName: "BUY", itemSellerCharName: `Vendedor${i}`,
  });

  beforeAll(async () => {
    // Os anúncios da Poção Vermelha vão junto: o retrato guarda só a coleta de trading
    // MAIS RECENTE, e deixá-los de fora mudaria o fixture por baixo de quem já rodou.
    // `SEM_OFERTA` entra sem anúncio nenhum de propósito — ele existe no catálogo e já
    // passou pelo mercado, mas não está à venda.
    await ingest({
      dataset: "trading",
      server: "FREYA",
      startedAt: 1_700_000_300,
      crawlId: "trading-freya-com-cara",
      rows: [
        ...[50, 55, 70, 90].map((price, i) => anuncio(ITEM_ID, "Poção Vermelha", price, i)),
        ...[300, 320].map((price, i) => anuncio(CARA, "Poção Laranja", price, i)),
      ],
    });
  });

  /**
   * Os itens que este bloco controla.
   *
   * A busca corre sobre o catálogo real (13.846 itens), então `q=pocao` casa outras poções
   * além das semeadas — `[Evento] Poção Vermelha Compacta`, por exemplo. Filtrar preserva a
   * asserção de ORDEM, que é o que estes testes existem para provar, sem depender de o
   * catálogo do jogo não ganhar mais uma poção amanhã.
   */
  const watched = new Set([ITEM_ID, CARA, SEM_OFERTA]);
  const orderOf = async (query: string): Promise<number[]> =>
    (await idsOf(query)).filter((id) => watched.has(id));

  const idsOf = async (query: string): Promise<number[]> =>
    ((await getJson(`/api/v1/items?${query}`)) as { items: { itemId: number }[] }).items.map(
      (i) => i.itemId,
    );

  it("ordena pelo preço de agora", async () => {
    expect(await orderOf("q=pocao&sort=price")).toEqual([ITEM_ID, CARA, SEM_OFERTA]);
  });

  /**
   * O item sem oferta fica no fim NOS DOIS SENTIDOS.
   *
   * Inverter o comparador inteiro no decrescente jogaria os travessões para o topo — a
   * mesma armadilha que o `sortUndefined` da tabela descreve, e a razão de a ausência ser
   * decidida antes da inversão.
   */
  it("decrescente inverte os preços, mas não sobe quem não tem preço", async () => {
    expect(await orderOf("q=pocao&sort=price&dir=desc")).toEqual([CARA, ITEM_ID, SEM_OFERTA]);
  });

  /**
   * A ordem é a mesma nos dois canais.
   *
   * O MCP não devolve as colunas de preço — o agente pagaria contexto por números que não
   * pediu — mas ORDENAR é outra coisa: sem isto, "quais são as poções mais baratas?" não
   * tinha resposta pelo agente, porque reordenar a página que ele recebeu responderia "a
   * mais barata destas vinte".
   */
  it("o MCP ordena igual ao REST, nos dois sentidos", async () => {
    const idsMcp = async (args: Record<string, unknown>): Promise<number[]> =>
      ((await callTool("search_items", { query: "pocao", ...args })) as {
        itens: { itemId: number }[];
      }).itens.map((i) => i.itemId);

    expect(await idsMcp({ ordenar: "price" })).toEqual(await idsOf("q=pocao&sort=price"));

    const invertido = await idsMcp({ ordenar: "price", decrescente: true });
    expect(invertido).toEqual(await idsOf("q=pocao&sort=price&dir=desc"));
    // E o item sem oferta não sobe ao topo quando inverte.
    expect(invertido.filter((id) => watched.has(id)).at(-1)).toBe(SEM_OFERTA);
  });

  it("ordenação desconhecida é 400 com a lista de válidas", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/items?q=pocao&sort=xpto`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { erro: string; ordenacoes: string[] };
    expect(body.erro).toContain("xpto");
    expect(body.ordenacoes).toContain("price");
  });

  it("uma lista de ids devolve os itens na ordem digitada", async () => {
    expect(await idsOf(`q=${CARA},${ITEM_ID}`)).toEqual([CARA, ITEM_ID]);
    // Espaço serve tanto quanto vírgula: é o que sai de um copiar-e-colar.
    expect(await idsOf(`q=${ITEM_ID}%20${CARA}`)).toEqual([ITEM_ID, CARA]);
  });

  it("a lista de ids ignora o filtro à venda, como um id sozinho", async () => {
    expect(await idsOf(`q=${SEM_OFERTA},${ITEM_ID}&for_sale=1`)).toEqual([SEM_OFERTA, ITEM_ID]);
  });

  it("a lista chega inteira ao MCP também", async () => {
    const mcp = (await callTool("search_items", { query: `${CARA},${ITEM_ID}` })) as {
      itens: { itemId: number }[];
    };
    expect(mcp.itens.map((i) => i.itemId)).toEqual([CARA, ITEM_ID]);
  });

  /**
   * E o schema anuncia a forma — capacidade que ninguém documenta é capacidade que não
   * existe. A lista funcionava desde sempre, mas o `describe` dizia "id exato", no
   * singular, então nenhum agente tinha por que tentar.
   */
  it("o schema da busca conta que aceita lista de ids", async () => {
    const busca = (await listTools()).find((t) => t.name === "search_items")!;
    expect(busca.inputSchema.properties["query"]?.description).toMatch(/lista de ids/i);
  });

  /**
   * A busca do site vem com preço; a do agente, não.
   *
   * São dois consumidores com custos opostos: a tabela precisa das colunas para ordenar e
   * comparar, e o agente pagaria contexto por um preço que ele não pediu.
   */
  it("a rota traz preço em cada linha, o MCP continua enxuto", async () => {
    const rest = (await getJson(`/api/v1/items?q=pocao&sort=price`)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(rest.items[0]).toMatchObject({
      itemId: ITEM_ID,
      offers: { min: 50, stores: 4 },
      market: { avg: 60 },
    });

    const mcp = (await callTool("search_items", { query: "pocao" })) as {
      itens: Array<Record<string, unknown>>;
    };
    expect(mcp.itens[0]).not.toHaveProperty("offers");
  });
});

/**
 * Os dois conjuntos crus, para um catálogo de fora se filtrar sozinho.
 *
 * O simulador de visuais tem os 1.494 visuais do cliente e só quer saber quais o
 * mercado já viu e quais estão à venda. Este teste roda no fim do arquivo de propósito:
 * a essa altura o fixture já tem o esgotado (visto, sem anúncio) e o NIDHOGG semeado,
 * que é justamente o que separa as duas listas uma da outra.
 */
describe("ids do mercado", () => {
  const idsOfServer = async (
    query = "",
  ): Promise<{ inMarket: number[]; forSale: number[]; nextTradingAt: number | null }> =>
    (await getJson(`/api/v1/ids${query}`)) as {
      inMarket: number[];
      forSale: number[];
      nextTradingAt: number | null;
    };

  it("separa 'já visto' de 'à venda agora'", async () => {
    const { inMarket, forSale } = await idsOfServer();
    expect(inMarket).toContain(ITEM_ID);
    expect(inMarket).toContain(SOLD_OUT);
    expect(forSale).toContain(ITEM_ID);
    // O esgotado é a diferença entre as duas perguntas: visto um dia, sem anúncio hoje.
    expect(forSale).not.toContain(SOLD_OUT);
  });

  it("vem em ordem crescente, para não mudar de forma a cada coleta", async () => {
    const { inMarket, forSale } = await idsOfServer();
    expect(inMarket).toEqual([...inMarket].sort((a, b) => a - b));
    expect(forSale).toEqual([...forSale].sort((a, b) => a - b));
  });

  it("cada servidor tem os seus", async () => {
    const nidhogg = await idsOfServer("?server=NIDHOGG");
    expect(nidhogg.forSale).toContain(ITEM_ID);
    // `item_market` é por servidor: o esgotado só foi visto em FREYA.
    expect(nidhogg.inMarket).not.toContain(SOLD_OUT);
  });

  it("concorda com o lote sobre quem está à venda", async () => {
    const [ids, lote] = await Promise.all([
      idsOfServer(),
      getJson(`/api/v1/prices?items=${ITEM_ID},${SOLD_OUT}`) as Promise<{
        prices: Array<{ itemId: number; inMarket: boolean; offers: unknown }>;
        nextTradingAt: number | null;
      }>,
    ]);
    for (const price of lote.prices) {
      expect(ids.inMarket.includes(price.itemId)).toBe(price.inMarket);
      expect(ids.forSale.includes(price.itemId)).toBe(price.offers !== null);
    }
    // O mesmo relógio das duas rotas — o cliente dorme até lá em vez de perguntar em
    // intervalo fixo, e uma discordância aqui o faria acordar cedo ou tarde demais.
    expect(ids.nextTradingAt).toBe(lote.nextTradingAt);
  });

  it("servidor inexistente é 400 aqui também", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/ids?server=NIDOGG`);
    expect(res.status).toBe(400);
  });

  it("market_ids devolve o mesmo que GET /ids", async () => {
    const [rest, mcp] = await Promise.all([getJson("/api/v1/ids"), callTool("market_ids", {})]);
    const { nextTradingAt: _semRelogio, ...esperado } = rest as Record<string, unknown>;
    expect(mcp).toEqual(esperado);
  });
});

/**
 * Cache não é enfeite aqui — é o mecanismo de leitura.
 *
 * O D1 mais próximo fica em `enam`, a uns 120 ms de um usuário brasileiro, e um acerto de
 * cache é servido do POP de São Paulo SEM executar o Worker. Ou seja: cabeçalho errado não
 * deixa a resposta lenta, deixa a resposta CARA — requisição, CPU e linha lida cobradas
 * onde não precisava. Na EC2 a API não mandava cabeçalho nenhum, então isto é a diferença
 * inteira.
 */
describe("cabeçalhos de cache", () => {
  const headers = async (path: string): Promise<Headers> => (await getResponse(path)).headers;

  it("as rotas de mercado dizem ao navegador e à borda, separadamente", async () => {
    const h = await headers(`/api/v1/items/${ITEM_ID}`);
    expect(h.get("cache-control")).toMatch(/public, max-age=\d+/);
    // A borda tem o próprio cabeçalho: a Cloudflare o consome e não o repassa, então o
    // cliente nunca vê um TTL que não é dele.
    expect(h.get("cloudflare-cdn-cache-control")).toMatch(/s-maxage=\d+/);
  });

  /**
   * O teto de 300 s existe por causa do `tradingAgeMin`.
   *
   * Esse campo é calculado ao montar a resposta e vai ASSADO no corpo. Uma resposta
   * cacheada em T e servida em T+280s subestima a idade em 280 s. Com o teto, o erro fica
   * limitado a cinco minutos — e o `Age` que a Cloudflare acrescenta nos acertos permite
   * corrigir. Sem ele, um agente diria "coletado há 2 minutos" sobre um dado de meia hora.
   */
  it("nenhuma rota com freshness passa de 300s na borda", async () => {
    for (const path of [
      `/api/v1/items?q=pocao`,
      `/api/v1/items/${ITEM_ID}`,
      `/api/v1/items/${ITEM_ID}/offers`,
      `/api/v1/ids`,
      `/api/v1/prices?items=${ITEM_ID}`,
    ]) {
      const edge = (await headers(path)).get("cloudflare-cdn-cache-control") ?? "";
      const sMaxAge = Number(/s-maxage=(\d+)/.exec(edge)?.[1]);
      expect(sMaxAge, path).toBeLessThanOrEqual(300);
    }
  });

  it("o histórico diário pode durar mais que o de hora", async () => {
    const dia = (await headers(`/api/v1/items/${ITEM_ID}/history?days=30&bucket=day`)).get(
      "cloudflare-cdn-cache-control",
    );
    const hora = (await headers(`/api/v1/items/${ITEM_ID}/history?days=2&bucket=hour`)).get(
      "cloudflare-cdn-cache-control",
    );
    expect(Number(/s-maxage=(\d+)/.exec(dia ?? "")?.[1])).toBeGreaterThan(300);
    expect(Number(/s-maxage=(\d+)/.exec(hora ?? "")?.[1])).toBeLessThanOrEqual(300);
  });

  it("o que não pode ser cacheado diz no-store", async () => {
    expect((await headers("/healthz")).get("cache-control")).toBe("no-store");
    const replay = await SELF.fetch(`${ORIGIN}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: replayFixture("equip-test-2.rrf"),
    });
    expect(replay.headers.get("cache-control")).toBe("no-store");
  });

  it("/ids e /prices devolvem 304 para quem já tem a versão", async () => {
    for (const path of [`/api/v1/ids`, `/api/v1/prices?items=${ITEM_ID}`]) {
      const first = await getResponse(path);
      const etag = first.headers.get("etag");
      expect(etag, path).toMatch(/^W\//);

      const again = await SELF.fetch(`${ORIGIN}${path}`, { headers: { "if-none-match": etag! } });
      expect(again.status, path).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  /**
   * O ETag identifica a PERGUNTA, não só o snapshot.
   *
   * Sem a consulta na chave, dois pedidos diferentes dentro da mesma coleta compartilhariam
   * o ETag — e o segundo receberia 304 para um corpo que nunca viu.
   */
  it("perguntas diferentes têm ETags diferentes", async () => {
    const um = (await getResponse(`/api/v1/prices?items=${ITEM_ID}`)).headers.get("etag");
    const dois = (await getResponse(`/api/v1/prices?items=${CARA}`)).headers.get("etag");
    expect(um).not.toBe(dois);
  });

  it("a leitura pública é aberta, sem fragmentar o cache por origem", async () => {
    const h = await headers(`/api/v1/ids`);
    // `*` em vez da origem ecoada: o dado é público e sem autenticação, e `Vary: Origin`
    // faria a SPA, o site de visuais e o claude.ai manterem três cópias da mesma resposta.
    expect(h.get("access-control-allow-origin")).toBe("*");
    expect(h.get("vary")).toBeNull();
  });
});

/**
 * A segunda camada de cache não pode responder o retrato errado.
 *
 * Ela guarda por id de snapshot, e os dois erros abaixo foram encontrados justamente ao
 * ligá-la — os dois serviam dado velho ou de outro servidor com cara de resposta correta.
 */
describe("cache interno por snapshot", () => {
  it("o segundo pedido idêntico vem do cache", async () => {
    // Consulta exclusiva deste teste: qualquer uma já usada acima entraria já quente.
    const path = `/api/v1/items?q=pocao&sort=median&limit=7`;
    expect((await getResponse(path)).headers.get("x-snapshot-cache")).toBe("miss");
    expect((await getResponse(path)).headers.get("x-snapshot-cache")).toBe("hit");
  });

  it("a ordem dos parâmetros não cria duas entradas", async () => {
    await getResponse(`/api/v1/items?q=elixir&limit=5`);
    // A borda chavearia pela URL crua e trataria isto como outra pergunta.
    const invertido = await getResponse(`/api/v1/items?limit=5&q=elixir`);
    expect(invertido.headers.get("x-snapshot-cache")).toBe("hit");
  });

  it("um acerto devolve os cabeçalhos públicos, não os internos", async () => {
    const path = `/api/v1/items/${ITEM_ID}/offers`;
    const primeiro = await getResponse(path);
    const segundo = await getResponse(path);
    expect(segundo.headers.get("x-snapshot-cache")).toBe("hit");
    // O TTL interno é do cache, não do cliente: sem restaurar, o navegador herdaria os
    // 300 s da entrada e a borda ficaria sem diretiva nenhuma.
    expect(segundo.headers.get("cache-control")).toBe(primeiro.headers.get("cache-control"));
    expect(segundo.headers.get("cloudflare-cdn-cache-control")).toBe(
      primeiro.headers.get("cloudflare-cdn-cache-control"),
    );
  });

  /**
   * Uma coleta de `market-price` invalida o cache, mesmo sem tocar nos anúncios.
   *
   * O retrato é a união de dois datasets com sequências independentes. Com só o snapshot de
   * `trading` na chave, o agregado novo ficava invisível até a coleta de lojas seguinte —
   * meia hora servindo o preço médio anterior como se fosse o atual.
   */
  it("coleta de market-price invalida o que estava guardado", async () => {
    const path = `/api/v1/items/${ITEM_ID}`;
    await getResponse(path);
    expect((await getResponse(path)).headers.get("x-snapshot-cache")).toBe("hit");

    await ingest({
      dataset: "market-price",
      server: "FREYA",
      startedAt: 1_850_000_000,
      crawlId: "market-freya-invalida-cache",
      rows: [
        {
          itemId: ITEM_ID, itemName: "Poção Vermelha",
          databaseImgPath: null, databaseType: "healing",
          totalItemCnt: 7000, minItemPrice: 40, maxItemPrice: 120, avgItemPrice: 60,
        } satisfies MarketPriceRow,
      ],
    });

    const depois = await getResponse(path);
    expect(depois.headers.get("x-snapshot-cache")).toBe("miss");
    const corpo = (await depois.json()) as { market: { totalSold: number } };
    expect(corpo.market.totalSold).toBe(7000);
  });

  /**
   * Um `?server=` inválido continua sendo 400.
   *
   * A chave tira `server` dos parâmetros de propósito (ausente e explícito são a mesma
   * pergunta). Sem validar antes, "NIDOGG" caía na chave do padrão e recebia a resposta de
   * FREYA com status 200 — exatamente o erro silencioso que `serverOf` existe para evitar.
   */
  it("servidor inválido não é servido do cache do padrão", async () => {
    const res = await getResponse(`/api/v1/items/${ITEM_ID}?server=NIDOGG`);
    expect(res.status).toBe(400);
    expect(res.headers.get("x-snapshot-cache")).toBeNull();
  });

  it("os dois servidores não compartilham entrada", async () => {
    const freya = (await getJson(`/api/v1/items/${ITEM_ID}?server=FREYA`)) as {
      offers: { min: number };
    };
    const nidhogg = (await getJson(`/api/v1/items/${ITEM_ID}?server=NIDHOGG`)) as {
      offers: { min: number };
    };
    expect(freya.offers.min).toBe(50);
    expect(nidhogg.offers.min).toBe(900);
  });
});

describe("HEAD", () => {
  /**
   * HEAD é GET sem corpo.
   *
   * O router casava só `method === "GET"`, então um HEAD numa rota válida caía no 404 do
   * fim. Passou despercebido porque nada no caminho de teste usava HEAD — apareceu no
   * primeiro `curl -I` do smoke, que é exatamente como um monitor de uptime pergunta.
   */
  it("responde como o GET, sem corpo", async () => {
    const get = await getResponse(`/api/v1/items/${ITEM_ID}`);
    const head = await SELF.fetch(`${ORIGIN}/api/v1/items/${ITEM_ID}`, { method: "HEAD" });

    expect(head.status).toBe(get.status);
    expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
    expect(await head.text()).toBe("");
  });

  it("uma rota que não existe continua 404 no HEAD", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/v1/nao-existe`, { method: "HEAD" });
    expect(res.status).toBe(404);
  });
});
