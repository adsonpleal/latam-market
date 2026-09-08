/**
 * Traz o mercado para dentro do isolate.
 *
 * Duas fontes, com vidas bem diferentes:
 *
 *  - **catálogo** — muda só em deploy. Vem de um asset estático (requisição grátis,
 *    comprimida e com cache hierárquico da própria Cloudflare) e é indexado UMA vez por
 *    isolate, compartilhado pelos dois servidores.
 *  - **retrato do mercado** — muda a cada coleta. Vem do R2, num objeto imutável por
 *    snapshot mais um ponteiro minúsculo que diz qual é o corrente.
 *
 * O ponteiro é o que torna a troca atômica entre processos: o blob novo é escrito antes,
 * com outro nome, e só passa a existir para os leitores quando o ponteiro muda. É o mesmo
 * contrato do `refreshCache`, que montava o índice inteiro antes de trocar a referência.
 *
 * Não há invalidação empurrada — ninguém avisa o isolate de que houve coleta. Ele confere
 * o ponteiro no máximo a cada `POINTER_TTL_MS`, e serve o retrato anterior nesse meio
 * tempo. Servir dado 30 segundos mais velho que o disponível não é problema num dado que
 * já nasce com 30 minutos; pagar uma leitura de ponteiro por requisição, sim.
 */

import { indexCatalogue, setCache, type CatalogueIndex, type MarketCache } from "./cache.js";
import { decodeBlob, listingsByItem, pricesByItem, type SnapshotBlob } from "./blob.js";
import type { ItemRow } from "./read.js";
import { CATALOGUE_URL } from "../generated/catalogue.js";
import type { Server } from "../core/servers.js";

/**
 * Monta o cache a partir do retrato publicado no R2.
 *
 * É o caminho do Worker. O do SQLite (`buildCache`, abaixo) continua existindo para o
 * shipper e para os testes; os dois têm que produzir o MESMO objeto, e há um teste que
 * compara os dois lado a lado.
 */
export function cacheFromBlob(catalogue: CatalogueIndex, blob: SnapshotBlob): MarketCache {
  const prices = pricesByItem(blob);
  return {
    builtAt: Math.floor(Date.now() / 1000),
    marketSnapshotId: blob.marketSnapshotId,
    tradingSnapshotId: blob.snapshotId,
    marketAt: blob.marketAt,
    tradingAt: blob.startedAt,
    items: catalogue.items,
    inMarket: new Set(blob.inMarket),
    byNameNorm: catalogue.byNameNorm,
    prices,
    listings: listingsByItem(blob),
  };
}

/** Quanto tempo um isolate confia no ponteiro que já leu. */
const POINTER_TTL_MS = 30_000;

/** Caminhos no R2. O ponteiro é um objeto de poucos bytes com o id do snapshot. */
export const blobKey = (server: Server, snapshotId: number): string =>
  `snap/${server}/${snapshotId}.json`;
export const pointerKey = (server: Server): string => `snap/${server}/current.txt`;

interface CatalogueAsset {
  v: number;
  cols: readonly string[];
  rows: ReadonlyArray<[number, string, string, number | null, string | null, string | null]>;
}

/** Estado por isolate. Módulo, e não `env`, porque é isso que sobrevive entre requisições. */
let catalogue: CatalogueIndex | null = null;
const loaded = new Map<Server, { snapshotId: number; checkedAt: number }>();

function toItems(asset: CatalogueAsset): ItemRow[] {
  return asset.rows.map(([itemId, name, nameNorm, slots, itemType, equipSlots]) => ({
    itemId,
    name,
    nameNorm,
    // O ícone só chega pelo mercado, e o catálogo não o traz.
    imgPath: null,
    dbType: null,
    slots,
    itemType,
    equipSlots: equipSlots === null ? [] : equipSlots.split(","),
  }));
}

async function loadCatalogue(env: Env, origin: string): Promise<CatalogueIndex> {
  const res = await env.ASSETS.fetch(new Request(new URL(CATALOGUE_URL, origin)));
  if (!res.ok) throw new Error(`catálogo não veio do asset (${res.status})`);
  return indexCatalogue(toItems((await res.json()) as CatalogueAsset));
}

/**
 * Garante que `getCache(server)` responde o retrato corrente.
 *
 * Barata no caminho quente: dentro da janela do TTL não faz nenhuma ida à rede, e mesmo
 * fora dela a leitura do ponteiro é um objeto de poucos bytes. O blob só é baixado quando
 * o id mudou de verdade.
 */
export async function hydrate(env: Env, origin: string, server: Server): Promise<void> {
  catalogue ??= await loadCatalogue(env, origin);

  const seen = loaded.get(server);
  const now = Date.now();
  if (seen && now - seen.checkedAt < POINTER_TTL_MS) return;

  const pointer = await env.SNAPSHOTS.get(pointerKey(server));
  if (!pointer) {
    // Servidor sem coleta nenhuma ainda é um estado válido — o serviço sobe e responde
    // um mercado vazio, como fazia sem coletor instalado.
    loaded.set(server, { snapshotId: -1, checkedAt: now });
    return;
  }

  const snapshotId = Number(await pointer.text());
  if (seen?.snapshotId === snapshotId) {
    loaded.set(server, { snapshotId, checkedAt: now });
    return;
  }

  const object = await env.SNAPSHOTS.get(blobKey(server, snapshotId));
  if (!object) {
    // O ponteiro aponta para um blob que não existe: a retenção passou na frente de um
    // isolate lento. Manter o retrato anterior é melhor que esvaziar o mercado.
    throw new Error(`snapshot ${snapshotId} de ${server} não está no R2`);
  }

  setCache(server, cacheFromBlob(catalogue, await decodeBlob(new Uint8Array(await object.arrayBuffer()))));
  loaded.set(server, { snapshotId, checkedAt: now });
}

/** Esquece o que este isolate carregou. Existe para os testes, que trocam de mundo. */
export function resetHydration(): void {
  catalogue = null;
  loaded.clear();
}
