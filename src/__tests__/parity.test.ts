/**
 * A API e o MCP têm que responder a mesma coisa.
 *
 * Este teste é o que sustenta a regra "api/ e mcp/ só chamam core/". Nada impede
 * alguém de, com pressa, montar uma consulta direto dentro de um handler; o que
 * impede é isto quebrar quando ele fizer.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, transact } from "../store/db.js";
import { refreshCache } from "../store/cache.js";
import { beginSnapshot, finishSnapshot, rollupListings, writeRows } from "../store/write.js";
import { createHttpServer } from "../server/http.js";
import { config } from "../server/config.js";
import { nextTradingRun } from "../core/schedule.js";
import type { MarketPriceRow, TradingRow } from "../store/rows.js";

const dir = mkdtempSync(resolve(tmpdir(), "latam-market-test-"));
const dbPath = resolve(dir, "test.db");
const db = openDb({ path: dbPath });

let baseUrl: string;
let server: ReturnType<typeof createHttpServer>;

const ITEM_ID = 501;
/** Visto no mercado um dia, sem anúncio hoje: a diferença entre os dois filtros. */
const SOLD_OUT = 909;

function seed(): void {
  // O catálogo é do jogo; "visto no mercado" é por servidor (schema v3).
  db.prepare(`INSERT INTO item (item_id, name, name_norm) VALUES (?, ?, ?)`).run(
    ITEM_ID,
    "Poção Vermelha",
    "pocao vermelha",
  );
  db.prepare(
    `INSERT INTO item_market (item_id, server, in_market) VALUES (?, 'FREYA', 1)`,
  ).run(ITEM_ID);

  const market = beginSnapshot(db, "market-price", "FREYA", "import", 1_700_000_000);
  writeRows(db, market, [
    {
      itemId: ITEM_ID, itemName: "Poção Vermelha",
      databaseImgPath: null, databaseType: "healing",
      totalItemCnt: 5000, minItemPrice: 40, maxItemPrice: 120, avgItemPrice: 60,
    } satisfies MarketPriceRow,
  ]);
  finishSnapshot(db, market.id, "market-price");

  const trading = beginSnapshot(db, "trading", "FREYA", "import", 1_700_000_100);
  writeRows(
    db,
    trading,
    [50, 55, 70, 90].map(
      (price, i) =>
        ({
          itemId: ITEM_ID, mapId: 1, ssi: `ssi-${i}`, itemName: "Poção Vermelha",
          databaseImgPath: null, databaseType: "healing",
          storeName: `Loja ${i}`, itemPrice: price, itemCnt: 10, slotMaxCount: "",
          storeTypeName: "BUY", itemSellerCharName: `Vendedor${i}`,
        }) satisfies TradingRow,
    ),
  );
  rollupListings(db, trading);
  transact(db, () => finishSnapshot(db, trading.id, "trading"));
  refreshCache(db, "FREYA");
}

/** O mesmo item, com outro preço, em NIDHOGG — para provar que os dois não se misturam. */
function seedNidhogg(): void {
  db.prepare(
    `INSERT INTO item_market (item_id, server, in_market) VALUES (?, 'NIDHOGG', 1)`,
  ).run(ITEM_ID);

  const trading = beginSnapshot(db, "trading", "NIDHOGG", "import", 1_700_000_200);
  writeRows(
    db,
    trading,
    [900, 950].map(
      (price, i) =>
        ({
          itemId: ITEM_ID, mapId: 1, ssi: `nid-${i}`, itemName: "Poção Vermelha",
          databaseImgPath: null, databaseType: "healing",
          storeName: `Loja N${i}`, itemPrice: price, itemCnt: 3, slotMaxCount: "",
          storeTypeName: "BUY", itemSellerCharName: `VendedorN${i}`,
        }) satisfies TradingRow,
    ),
  );
  rollupListings(db, trading);
  transact(db, () => finishSnapshot(db, trading.id, "trading"));
  refreshCache(db, "NIDHOGG");
}

/** Chama uma ferramenta do MCP e devolve o JSON que ela produziu. */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { content: Array<{ text: string }> } };
  if (!body.result) throw new Error(`chamada a ${name} falhou: ${JSON.stringify(body)}`);
  return JSON.parse(body.result.content[0]!.text);
}

interface ToolInfo {
  name: string;
  description: string;
  inputSchema: { properties: Record<string, { description?: string }> };
}

/** O catálogo de ferramentas que o MCP publica — nomes, descrições e schemas. */
async function listTools(): Promise<ToolInfo[]> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = (await res.json()) as { result: { tools: ToolInfo[] } };
  return body.result.tools;
}

const getJson = async (path: string): Promise<unknown> =>
  (await fetch(`${baseUrl}${path}`)).json();

/**
 * Requisição crua, só para poder forjar o cabeçalho `Host`.
 *
 * `fetch` trata `host` como cabeçalho proibido e o sobrescreve em silêncio, então
 * testar a defesa contra DNS rebinding por ele daria sempre verde sem testar nada.
 */
function rawStatus(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = httpRequest(
      { host: "127.0.0.1", port, path, headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  seed();
  server = createHttpServer(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  rmSync(dir, { recursive: true, force: true });
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
    expect(await rawStatus("/api/v1/status", "evil.example.com")).toBe(403);
  });

  it("/healthz responde sem passar pela allowlist", async () => {
    // O systemd e o workflow de deploy batem no health check por IP, sem o nome de
    // domínio, então ele tem que responder antes da allowlist.
    expect(await rawStatus("/healthz", "evil.example.com")).toBe(200);
  });

  it("MCP só aceita POST", async () => {
    expect((await fetch(`${baseUrl}/mcp`)).status).toBe(405);
  });

  it("um snapshot 'live' de banco antigo não vira o retrato mais recente", () => {
    // A consulta ao vivo saiu na 0.6.0 e nada mais grava `source = 'live'` — mas o
    // histórico em produção tem essas linhas, e cada uma cobria um item só. Se uma
    // entrasse como snapshot corrente, o cache passaria a enxergar um mercado com um
    // item e mais nada. Este teste é a guarda para os bancos que já existem.
    const live = beginSnapshot(db, "trading", "FREYA", "live", 1_900_000_000);
    writeRows(db, live, [
      {
        itemId: ITEM_ID, mapId: 1, ssi: "ao-vivo", itemName: "Poção Vermelha",
        databaseImgPath: null, databaseType: "healing", storeName: "X", itemPrice: 1,
        itemCnt: 1, slotMaxCount: "", storeTypeName: "BUY", itemSellerCharName: "Y",
      } satisfies TradingRow,
    ]);
    finishSnapshot(db, live.id, "trading");

    const cache = refreshCache(db, "FREYA");
    expect(cache.listings.get(ITEM_ID)).toHaveLength(4);
    expect(cache.listings.get(ITEM_ID)![0]!.price).toBe(50);
  });
});

/** Sanidade: o fixture do replay continua decodificando pelo caminho da API. */
describe("replay pela API", () => {
  it("aceita upload do .rrf e devolve os três containers", async () => {
    const file = readFileSync(
      resolve(import.meta.dirname, "../replay/__tests__/fixtures/equip-test-2.rrf"),
    );
    const res = await fetch(`${baseUrl}/api/v1/replay`, {
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
    const file = readFileSync(
      resolve(import.meta.dirname, "../replay/__tests__/fixtures/equip-test-2.rrf"),
    );
    const res = await fetch(`${baseUrl}/api/v1/replay`, {
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
    const res = await fetch(`${baseUrl}/api/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(200, 7),
    });
    expect(res.status).toBe(422);
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
    const file = readFileSync(
      resolve(import.meta.dirname, "../replay/__tests__/fixtures/equip-test-2.rrf"),
    );
    const res = await fetch(`${baseUrl}/api/v1/replay`, {
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
  beforeAll(() => seedNidhogg());

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
    const res = await fetch(`${baseUrl}/api/v1/items/${ITEM_ID}?server=NIDOGG`);
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
  beforeAll(() => {
    db.prepare(`INSERT INTO item (item_id, name, name_norm) VALUES (?, ?, ?)`).run(
      SOLD_OUT,
      "Zargão Esgotado",
      "zargao esgotado",
    );
    // Já foi visto alguma vez, mas não está em nenhuma coleta de anúncios.
    db.prepare(
      `INSERT INTO item_market (item_id, server, in_market) VALUES (?, 'FREYA', 1)`,
    ).run(SOLD_OUT);
    refreshCache(db, "FREYA");
  });

  it("sem o filtro, o esgotado aparece", async () => {
    const r = (await getJson("/api/v1/items?q=zargao")) as { items: { itemId: number }[] };
    expect(r.items.map((i) => i.itemId)).toContain(SOLD_OUT);
  });

  it("com o filtro, some — ninguém está vendendo", async () => {
    const r = (await getJson("/api/v1/items?q=zargao&for_sale=1")) as {
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
    const rest = (await getJson("/api/v1/items?q=zargao&for_sale=1")) as { total: number };
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
    expect((await fetch(`${baseUrl}/api/v1/prices`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/prices?items=`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/v1/prices?items=abc,-1,0`)).status).toBe(400);
  });

  /**
   * Passar do teto é 400, e não corte silencioso como no `limit` das buscas.
   *
   * Cortar uma lista de resultados devolve menos resultados; cortar uma lista de ids
   * PEDIDOS deixaria o alerta do 101º favorito sem avaliação, sem ninguém saber.
   */
  it("mais de 100 ids é 400, não uma lista cortada", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(",");
    const res = await fetch(`${baseUrl}/api/v1/prices?items=${ids}`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { pedidos: number }).toMatchObject({ pedidos: 101 });

    const noTeto = Array.from({ length: 100 }, (_, i) => i + 1).join(",");
    expect((await fetch(`${baseUrl}/api/v1/prices?items=${noTeto}`)).status).toBe(200);
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
    expect(r.nextTradingAt).toBe(
      r.freshness.tradingAt + config.crawl.tradingEveryMin * 60,
    );
  });

  it("a hora exata do agendador manda mais que a estimativa", () => {
    expect(nextTradingRun(12_345, 1_000, 30)).toBe(12_345);
  });

  it("sem agendador, estima; sem coleta nenhuma, não há o que estimar", () => {
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
  const CARA = 502;
  const SEM_OFERTA = 903;

  const anuncio = (itemId: number, itemName: string, price: number, i: number): TradingRow => ({
    itemId, mapId: 1, ssi: `ord-${itemId}-${i}`, itemName,
    databaseImgPath: null, databaseType: "healing",
    storeName: `Loja ${i}`, itemPrice: price, itemCnt: 10, slotMaxCount: "",
    storeTypeName: "BUY", itemSellerCharName: `Vendedor${i}`,
  });

  beforeAll(() => {
    const novos = [
      [CARA, "Poção Azul", "pocao azul"],
      [SEM_OFERTA, "Poção Fantasma", "pocao fantasma"],
    ] as const;
    for (const [itemId, name, norm] of novos) {
      db.prepare(`INSERT INTO item (item_id, name, name_norm) VALUES (?, ?, ?)`).run(
        itemId,
        name,
        norm,
      );
      db.prepare(
        `INSERT INTO item_market (item_id, server, in_market) VALUES (?, 'FREYA', 1)`,
      ).run(itemId);
    }

    // Os anúncios da Poção Vermelha vão junto: o cache guarda só o último snapshot de
    // trading, e deixá-los de fora mudaria o fixture por baixo de quem já rodou.
    const trading = beginSnapshot(db, "trading", "FREYA", "import", 1_700_000_300);
    writeRows(db, trading, [
      ...[50, 55, 70, 90].map((price, i) => anuncio(ITEM_ID, "Poção Vermelha", price, i)),
      ...[300, 320].map((price, i) => anuncio(CARA, "Poção Azul", price, i)),
    ]);
    rollupListings(db, trading);
    transact(db, () => finishSnapshot(db, trading.id, "trading"));
    refreshCache(db, "FREYA");
  });

  const idsOf = async (query: string): Promise<number[]> =>
    ((await getJson(`/api/v1/items?${query}`)) as { items: { itemId: number }[] }).items.map(
      (i) => i.itemId,
    );

  it("ordena pelo preço de agora", async () => {
    expect(await idsOf("q=pocao&sort=price")).toEqual([ITEM_ID, CARA, SEM_OFERTA]);
  });

  /**
   * O item sem oferta fica no fim NOS DOIS SENTIDOS.
   *
   * Inverter o comparador inteiro no decrescente jogaria os travessões para o topo — a
   * mesma armadilha que o `sortUndefined` da tabela descreve, e a razão de a ausência ser
   * decidida antes da inversão.
   */
  it("decrescente inverte os preços, mas não sobe quem não tem preço", async () => {
    expect(await idsOf("q=pocao&sort=price&dir=desc")).toEqual([CARA, ITEM_ID, SEM_OFERTA]);
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
    expect(invertido.at(-1)).toBe(SEM_OFERTA);
  });

  it("ordenação desconhecida é 400 com a lista de válidas", async () => {
    const res = await fetch(`${baseUrl}/api/v1/items?q=pocao&sort=xpto`);
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
    const res = await fetch(`${baseUrl}/api/v1/ids?server=NIDOGG`);
    expect(res.status).toBe(400);
  });

  it("market_ids devolve o mesmo que GET /ids", async () => {
    const [rest, mcp] = await Promise.all([getJson("/api/v1/ids"), callTool("market_ids", {})]);
    const { nextTradingAt: _semRelogio, ...esperado } = rest as Record<string, unknown>;
    expect(mcp).toEqual(esperado);
  });
});
