/**
 * A costura por onde o dado entra.
 *
 * O coletor continua fora daqui — é um componente à parte, e a migração dele é assunto de
 * outro dia. O que muda é o destino: em vez de gravar SQLite no disco ao lado, ele (ou o
 * shipper que o carrega) manda o crawl inteiro para cá, e o Worker é quem abre o snapshot,
 * calcula os percentis, grava no D1 e publica o retrato no R2.
 *
 * Manter a escrita DESTE lado é o ponto: o fechamento de snapshot e o rollup continuam
 * neste repositório, cobertos pelos testes daqui, e nenhuma credencial do D1 precisa
 * existir na máquina do coletor.
 *
 * **A ordem de publicação é o contrato:**
 *   1. blob novo no R2, com nome próprio — existe, mas ninguém aponta para ele;
 *   2. `batch()` no D1 — uma transação, tudo ou nada;
 *   3. ponteiro no R2 — **é aqui que o mercado novo passa a existir** para os leitores.
 *
 * Uma queda entre 1 e 3 deixa um blob órfão (que a retenção varre) e nada visível pela
 * metade. É a mesma garantia que o `refreshCache` dava trocando uma referência, agora
 * entre processos.
 */

import type { Dataset } from "../core/datasets.js";
import { parseServer, type Server } from "../core/servers.js";
import {
  decodeBlob,
  encodeBlob,
  listingsByItem,
  pricesByItem,
  toBlob,
  type SnapshotBlob,
} from "../store/blob.js";
import { d1Db } from "../store/d1.js";
import {
  closeSnapshot,
  insertStats,
  openSnapshot,
  upsertItemMarket,
  upsertItems,
  upsertPricePoints,
} from "../store/d1-write.js";
import { blobKey, pointerKey } from "../store/hydrate.js";
import type { SqlStatement } from "../store/port.js";
import type { ListingRow, PricePoint } from "../store/read.js";
import type { MarketPriceRow, Row, TradingRow } from "../store/rows.js";
import { groupByItem, rollupStats } from "../store/rollup.js";
import { normalizeName, stripSlotSuffix } from "../util/text.js";
import { json } from "./respond.js";

/** Cabeçalho do lote: a primeira linha do NDJSON. */
export interface IngestHeader {
  dataset: Dataset;
  server: Server;
  startedAt: number;
  crawlId: string;
  /** Próxima coleta, com o jitter que só o agendador conhece. Alimenta `nextTradingAt`. */
  nextRunAt?: number;
  /**
   * Ids que já passaram pelo mercado, para semear o retrato.
   *
   * `inMarket` normalmente é carregado adiante de um retrato para o outro, então uma coleta
   * só precisa acrescentar o que viu. Mas o PRIMEIRO retrato não tem de onde carregar: uma
   * carga inicial que dependesse só das duas coletas do bootstrap perderia todo item já
   * visto no mercado que não está anunciado hoje — ~850 itens, que sumiriam da busca em
   * silêncio, porque o filtro `onlyInMarket` é ligado por padrão.
   *
   * Só o bootstrap manda. O shipper não precisa: a partir do segundo retrato o conjunto se
   * mantém sozinho.
   */
  inMarketSeed?: number[];
}

/** Tolerância do carimbo de tempo, contra reenvio de um lote capturado. */
const CLOCK_SKEW_SEC = 300;

const hex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));

/**
 * Confere a assinatura do lote.
 *
 * `crypto.subtle.verify` compara em tempo constante por construção — comparar os hexes
 * com `===` vazaria o prefixo correto byte a byte, um caractere por tentativa.
 */
async function signatureValid(
  secret: string,
  signature: string,
  payload: string,
): Promise<boolean> {
  const provided = signature.replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(provided.match(/../g)!, (b) => parseInt(b, 16));
  return crypto.subtle.verify(
    "HMAC",
    key,
    bytes as BufferSource,
    new TextEncoder().encode(payload),
  );
}

function parseNdjson(text: string): [IngestHeader, Row[]] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) throw new Error("nenhuma linha no lote");

  const header = JSON.parse(lines[0]!) as IngestHeader;
  if (parseServer(header.server) === null) {
    throw new Error(`servidor inválido: ${String(header.server)}`);
  }
  if (header.dataset !== "trading" && header.dataset !== "market-price") {
    throw new Error(`dataset inválido: ${String(header.dataset)}`);
  }
  return [header, lines.slice(1).map((line) => JSON.parse(line) as Row)];
}

/** O blob corrente, ou `null` quando este servidor ainda não coletou nada. */
async function currentBlob(env: Env, server: Server): Promise<SnapshotBlob | null> {
  const pointer = await env.SNAPSHOTS.get(pointerKey(server));
  if (!pointer) return null;
  const object = await env.SNAPSHOTS.get(blobKey(server, Number(await pointer.text())));
  if (!object) return null;
  return decodeBlob(new Uint8Array(await object.arrayBuffer()));
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json(405, { erro: "use POST" });

  const secret = (env as unknown as { INGEST_SECRET?: string }).INGEST_SECRET;
  // Sem segredo configurado a rota não existe. Nunca "passa direto": um deploy que
  // esqueceu o secret tem que falhar FECHADO, não abrir a escrita para a internet.
  if (!secret) return json(503, { erro: "ingestão não configurada" });

  const signature = request.headers.get("x-ingest-signature");
  const crawlId = request.headers.get("x-ingest-crawl-id");
  const timestamp = Number(request.headers.get("x-ingest-timestamp"));
  if (!signature || !crawlId || !Number.isFinite(timestamp)) {
    return json(401, { erro: "lote sem assinatura" });
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > CLOCK_SKEW_SEC) {
    return json(401, { erro: "carimbo de tempo fora da janela" });
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  const payload = `${timestamp}\n${crawlId}\n${await sha256Hex(raw)}`;
  if (!(await signatureValid(secret, signature, payload))) {
    return json(401, { erro: "assinatura inválida" });
  }

  const text =
    request.headers.get("content-encoding") === "gzip"
      ? await new Response(
          new Blob([raw as unknown as ArrayBuffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip")),
        ).text()
      : new TextDecoder().decode(raw);

  const [header, rows] = parseNdjson(text);
  if (header.crawlId !== crawlId) {
    return json(400, { erro: "crawlId do corpo não bate com o do cabeçalho" });
  }

  const db = d1Db(env.DB);
  const snapshot = await openSnapshot(db, {
    dataset: header.dataset,
    server: header.server,
    startedAt: header.startedAt,
    crawlId,
  });
  // Reenvio depois de timeout: o snapshot já existe, e nada aqui se repete.
  if (snapshot.duplicate) {
    return json(200, { snapshotId: snapshot.id, duplicate: true, rows: 0 });
  }

  const previous = await currentBlob(env, header.server);
  const statements: SqlStatement[] = [];

  // Catálogo e "já visto" são por item DISTINTO, não por anúncio — ver `d1-write.ts`.
  const distinct = new Map<number, Row>();
  for (const row of rows) if (!distinct.has(row.itemId)) distinct.set(row.itemId, row);

  statements.push(
    ...upsertItems(
      [...distinct.values()].map((row) => {
        const name = stripSlotSuffix(row.itemName);
        return {
          itemId: row.itemId,
          name,
          nameNorm: normalizeName(name),
          imgPath: row.databaseImgPath,
          dbType: row.databaseType,
        };
      }),
    ),
    ...upsertItemMarket(header.server, [...distinct.keys()], header.startedAt),
  );

  const inMarket = new Set(previous?.inMarket ?? []);
  for (const itemId of header.inMarketSeed ?? []) inMarket.add(itemId);
  for (const itemId of distinct.keys()) inMarket.add(itemId);

  let blob: SnapshotBlob;
  if (header.dataset === "trading") {
    const listings: ListingRow[] = (rows as TradingRow[]).map((row) => ({
      ssi: row.ssi,
      itemId: row.itemId,
      price: row.itemPrice,
      cnt: row.itemCnt,
      // O site manda `""` quando o item não tem slot, e isso é NULL, não string vazia.
      slotMax: row.slotMaxCount || null,
      storeName: row.storeName,
      seller: row.itemSellerCharName,
      mapId: row.mapId,
    }));
    statements.push(
      ...insertStats(header.server, header.startedAt, rollupStats(groupByItem(listings))),
    );
    blob = toBlob({
      server: header.server,
      snapshotId: snapshot.id,
      startedAt: header.startedAt,
      // Uma coleta de anúncios não mexe no agregado publicado pelo site: carrega adiante.
      marketSnapshotId: previous?.marketSnapshotId ?? null,
      marketAt: previous?.marketAt ?? null,
      inMarket,
      prices: previous ? [...pricesByItem(previous).values()] : [],
      listings,
    });
  } else {
    const points: PricePoint[] = (rows as MarketPriceRow[]).map((row) => ({
      itemId: row.itemId,
      ts: header.startedAt,
      totalCnt: row.totalItemCnt,
      minPrice: row.minItemPrice,
      maxPrice: row.maxItemPrice,
      avgPrice: row.avgItemPrice,
    }));
    statements.push(...upsertPricePoints(header.server, snapshot.id, header.startedAt, points));
    blob = toBlob({
      server: header.server,
      // E o contrário: uma coleta de market-price não muda os anúncios, então o retrato
      // mantém o snapshot de trading que já estava publicado.
      snapshotId: previous?.snapshotId ?? snapshot.id,
      startedAt: previous?.startedAt ?? header.startedAt,
      marketSnapshotId: snapshot.id,
      marketAt: header.startedAt,
      inMarket,
      prices: points,
      listings: previous ? [...listingsByItem(previous).values()].flat() : [],
    });
  }

  statements.push(closeSnapshot(snapshot.id, rows.length, Math.floor(Date.now() / 1000)));

  const encoded = await encodeBlob(blob);
  // 1. o blob, com nome próprio: existe, mas ninguém aponta para ele ainda.
  await env.SNAPSHOTS.put(blobKey(header.server, snapshot.id), encoded as unknown as ArrayBuffer);
  // 2. o D1, numa transação só.
  await db.batch(statements);
  // 3. o ponteiro — daqui em diante o mercado novo existe para os leitores.
  await env.SNAPSHOTS.put(pointerKey(header.server), String(snapshot.id));

  return json(200, {
    snapshotId: snapshot.id,
    duplicate: false,
    rows: rows.length,
    itens: distinct.size,
  });
}
