/**
 * O retrato do mercado corrente, como um objeto só.
 *
 * No EC2 o `MarketCache` era remontado do SQLite a cada coleta, num processo que vivia
 * para sempre. No Worker não existe processo: cada isolate começa vazio e pode morrer a
 * qualquer momento. Reconstruir o cache com consultas ao D1 a cada isolate seria varrer
 * dezenas de milhares de linhas — em rows read, o caminho mais caro que existe; e como o
 * D1 fica em outra região, também o mais lento.
 *
 * Então quem escreve monta o retrato UMA vez, na ingestão, e o publica como blob imutável
 * no R2. Quem lê baixa um objeto e pronto. É a mesma "publicação atômica" que o
 * `refreshCache` fazia com uma atribuição, agora entre processos: o blob é escrito com o
 * id do snapshot no nome e só passa a existir para os leitores quando o ponteiro
 * `current.txt` muda.
 *
 * O formato é colunar (tuplas, não objetos) pelo mesmo motivo do catálogo: com ~20 mil
 * anúncios, repetir oito nomes de campo em cada um custa mais que o dado.
 */

import type { Server } from "../core/servers.js";
import type { ListingRow, PricePoint } from "./read.js";

/** Sobe junto com qualquer mudança de forma — o leitor recusa o que não conhece. */
export const BLOB_VERSION = 1;

type PriceTuple = [
  itemId: number,
  ts: number,
  totalCnt: number | null,
  minPrice: number | null,
  maxPrice: number | null,
  avgPrice: number | null,
];

type ListingTuple = [
  itemId: number,
  price: number,
  cnt: number,
  slotMax: string | null,
  storeName: string,
  seller: string,
  mapId: number | null,
  ssi: string,
];

export interface SnapshotBlob {
  v: number;
  server: Server;
  snapshotId: number;
  /** Quando a coleta de anúncios começou — é o `tradingAt` que o `freshness` publica. */
  startedAt: number;
  marketSnapshotId: number | null;
  marketAt: number | null;
  /** Ids que já passaram pelo mercado. Carregado adiante de coleta em coleta. */
  inMarket: number[];
  prices: PriceTuple[];
  /** ORDENADOS por (itemId, price) — a ordem em que serão servidos. */
  listings: ListingTuple[];
}

export interface SnapshotInput {
  server: Server;
  snapshotId: number;
  startedAt: number;
  marketSnapshotId: number | null;
  marketAt: number | null;
  inMarket: Iterable<number>;
  prices: Iterable<PricePoint>;
  listings: Iterable<ListingRow>;
}

export function toBlob(input: SnapshotInput): SnapshotBlob {
  const listings: ListingTuple[] = [];
  for (const l of input.listings) {
    listings.push([l.itemId, l.price, l.cnt, l.slotMax, l.storeName, l.seller, l.mapId, l.ssi]);
  }
  // A ordem é contrato: `core/prices.ts` assume o balde ordenado por preço, e a busca por
  // "mais barato" lê a posição zero sem conferir. Ordenar aqui, uma vez por coleta, é o
  // que permite ao leitor não ordenar nunca.
  listings.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const prices: PriceTuple[] = [];
  for (const p of input.prices) {
    prices.push([p.itemId, p.ts, p.totalCnt, p.minPrice, p.maxPrice, p.avgPrice]);
  }

  return {
    v: BLOB_VERSION,
    server: input.server,
    snapshotId: input.snapshotId,
    startedAt: input.startedAt,
    marketSnapshotId: input.marketSnapshotId,
    marketAt: input.marketAt,
    inMarket: [...input.inMarket].sort((a, b) => a - b),
    prices,
    listings,
  };
}

/** Os anúncios do blob, já agrupados por item e em ordem de preço. */
export function listingsByItem(blob: SnapshotBlob): Map<number, ListingRow[]> {
  const byItem = new Map<number, ListingRow[]>();
  for (const [itemId, price, cnt, slotMax, storeName, seller, mapId, ssi] of blob.listings) {
    let bucket = byItem.get(itemId);
    if (!bucket) byItem.set(itemId, (bucket = []));
    bucket.push({ ssi, itemId, price, cnt, slotMax, storeName, seller, mapId });
  }
  return byItem;
}

export function pricesByItem(blob: SnapshotBlob): Map<number, PricePoint> {
  const byItem = new Map<number, PricePoint>();
  for (const [itemId, ts, totalCnt, minPrice, maxPrice, avgPrice] of blob.prices) {
    byItem.set(itemId, { itemId, ts, totalCnt, minPrice, maxPrice, avgPrice });
  }
  return byItem;
}

// --------------------------------------------------------------------------
// Serialização
// --------------------------------------------------------------------------

/**
 * Comprimido na ida e na volta.
 *
 * `CompressionStream` existe nos dois runtimes (Workers e Node 18+), então não há
 * biblioteca no meio. São ~2,5 MB de JSON contra ~400 KB comprimidos — e o que importa
 * não é o armazenamento (irrisório), é o tempo de baixar isso num isolate frio.
 */
async function through(
  bytes: Uint8Array,
  // Os dois tipos concretos, e não um `TransformStream<Uint8Array, Uint8Array>`: sob a lib
  // DOM (que o build da `web/` usa, porque a fronteira de tipo alcança este arquivo) o
  // `writable` de um `CompressionStream` é `WritableStream<BufferSource>`, e o genérico
  // estreito compila no Node e quebra na web.
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // Escreve e lê pelo writer/reader em vez de `pipeThrough`. Um `Uint8Array` é um
  // `BufferSource` válido nas duas libs, então esta forma não depende de qual delas está
  // ativa — enquanto o `pipeThrough` exige que os genéricos das duas pontas casem, e eles
  // não casam entre Node e DOM.
  const writer = stream.writable.getWriter();
  // Sem `await` aqui: o escritor só termina quando alguém drena o outro lado, então
  // aguardar antes de ler travaria nos dois.
  const pumped = writer.write(bytes).then(() => writer.close());

  const out = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  await pumped;
  return out;
}

export async function encodeBlob(blob: SnapshotBlob): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(blob));
  return through(json, new CompressionStream("gzip"));
}

export async function decodeBlob(bytes: Uint8Array): Promise<SnapshotBlob> {
  const json = await through(bytes, new DecompressionStream("gzip"));
  const blob = JSON.parse(new TextDecoder().decode(json)) as SnapshotBlob;
  if (blob.v !== BLOB_VERSION) {
    // Recusar é melhor que adivinhar: um blob de formato antigo servido como se fosse o
    // atual viraria um mercado com campos faltando, e o sintoma apareceria como preço
    // ausente em item aleatório.
    throw new Error(`blob do snapshot na versão ${blob.v}, esperada ${BLOB_VERSION}`);
  }
  return blob;
}
