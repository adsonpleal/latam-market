/**
 * O catálogo de itens, do asset gerado no build.
 *
 * `src/cli/build-catalogue-asset.ts` gera `web/dist/generated/catalogue.<hash>.json` a
 * partir de `data/latam-items.json`, já classificado. O servidor lê o MESMO arquivo que a
 * interface baixa — uma fonte só para o que a busca e a tela chamam de item.
 */

import type { ItemRow } from "./read.js";
import { indexCatalogue, type CatalogueIndex } from "./cache.js";

export interface CatalogueAsset {
  v: number;
  cols: readonly string[];
  rows: ReadonlyArray<[number, string, string, number | null, string | null, string | null]>;
}

export function toItems(asset: CatalogueAsset): ItemRow[] {
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

export function catalogueFromAsset(asset: CatalogueAsset): CatalogueIndex {
  return indexCatalogue(toItems(asset));
}
