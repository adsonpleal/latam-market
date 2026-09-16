/**
 * Os itens do jogo: id, nome, slots, tipo e onde equipa.
 *
 * Vem de um asset estático gerado no build (`scripts/build-catalogue.mjs` →
 * `public/generated/items.<hash>.json`), a partir do mesmo `data/latam-items.json` que dá as
 * descrições. O tipo e as posições já vêm classificados de lá (`taxonomy.ts`).
 *
 * São ~14 mil itens e poucas centenas de KB comprimidos: menos que as descrições, e a busca
 * inteira numa lista em memória custa um milissegundo. Não compensa índice nem servidor.
 *
 * **Uma cache só, a daqui.** A página inteira — busca, favoritos, laço, inventário, painel de
 * item — lê o mesmo índice por `loadItems` (assíncrono) ou `loadedItems` (síncrono, depois de
 * carregado). O React enxerga isso por `useItemIndex`.
 */

import { ITEMS_URL } from "../../generated/catalogue.js";
import { normalizeName } from "./normalize.js";

/** O que qualquer tela precisa para nomear um item. */
export interface ItemBrief {
  itemId: number;
  name: string;
  slots: number | null;
}

/** Um item do catálogo. É um `ItemBrief`: quem só quer o nome recebe a entrada direto. */
export interface CatalogueEntry extends ItemBrief {
  /** O nome como a busca compara: sem acento, sem caixa. */
  nameNorm: string;
  /** Id de `ITEM_CATEGORIES`, ou `null` quando a descrição não permite classificar. */
  type: string | null;
  /** Ids de `EQUIP_SLOTS`. Vazio quando não é equipamento. */
  equipSlots: readonly string[];
}

/** Os itens por id. */
export type ItemIndex = ReadonlyMap<number, CatalogueEntry>;

/** O formato do asset: uma linha por item, colunar para pesar menos que uma lista de objetos. */
export type ItemRows = ReadonlyArray<
  readonly [itemId: number, name: string, slots: number | null, type?: string | null, equipSlots?: string | null]
>;

export function indexItems(rows: ItemRows): ItemIndex {
  const index = new Map<number, CatalogueEntry>();
  for (const [itemId, name, slots, type, equipSlots] of rows) {
    index.set(itemId, {
      itemId,
      name,
      slots,
      nameNorm: normalizeName(name),
      type: type ?? null,
      equipSlots: equipSlots ? equipSlots.split(",") : [],
    });
  }
  return index;
}

/** `fetch` de JSON que rejeita em status de erro, em vez de tentar analisar a página de erro. */
export const fetchJson = <T,>(url: string): Promise<T> =>
  fetch(url).then((res) => (res.ok ? (res.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${res.status}`))));

let loading: Promise<ItemIndex> | null = null;
let loaded: ItemIndex | null = null;

/**
 * Baixa e indexa o catálogo, uma vez por página.
 *
 * A promessa fica guardada, e não só o resultado: a busca, os favoritos e o replay pedem ao
 * mesmo tempo na primeira pintura, e três downloads do mesmo arquivo seriam puro
 * desperdício. Uma falha libera a próxima tentativa.
 */
export function loadItems(): Promise<ItemIndex> {
  loading ??= fetchJson<ItemRows>(ITEMS_URL)
    .then((rows) => (loaded = indexItems(rows)))
    .catch((err: unknown) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** O índice, se já chegou. Para quem precisa responder na hora e aceita "ainda não". */
export const loadedItems = (): ItemIndex | null => loaded;
