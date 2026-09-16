/** O inventário vem em containers; a tabela quer uma lista só, com a origem marcada. */

import type { InventoryItem, ItemOrigin, ReplayInventory } from "./replay/inventory.js";

/**
 * As origens do inventário mais a que só existe aqui.
 *
 * `ItemOrigin` vem de `replay/inventory.ts` em vez de ser reescrita: uma cópia à mão erraria
 * calada — um container novo lá não ganharia rótulo aqui. `unidentified` fica de fora de
 * `ItemOrigin` de propósito: são containers que o decodificador ainda não sabe o que são.
 */
export type Origin = ItemOrigin | "unidentified";

export const ORIGIN_LABEL: Record<Origin, string> = {
  inventory: "Mochila",
  cart: "Carrinho",
  equipped: "Equipado",
  storage: "Armazém",
  guildStorage: "Armazém do clã",
  unidentified: "Não identificado",
};

export const ALL_ORIGINS = Object.keys(ORIGIN_LABEL) as Origin[];

export interface Row extends InventoryItem {
  origin: Origin;
  /** Identidade estável da linha: o mesmo item pode ocupar dois slots. */
  key: string;
}

export function flatten(inventory: ReplayInventory): Row[] {
  const rows: Row[] = [];

  const add = (items: InventoryItem[], origin: Origin, containerId?: number): void => {
    for (const item of items) {
      rows.push({
        ...item,
        origin,
        key: `${origin}-${containerId ?? ""}-${item.slot}-${item.item.itemId}`,
      });
    }
  };

  add(inventory.inventory.items, "inventory");
  add(inventory.cart.items, "cart");
  add(inventory.equipped.items, "equipped");
  // Os armazéns são `null` quando a janela não foi aberta na gravação — aí não há linha
  // para mostrar, o que é diferente de mostrar um armazém vazio.
  add(inventory.storage?.items ?? [], "storage");
  add(inventory.guildStorage?.items ?? [], "guildStorage");
  // Containers que o decodificador ainda não sabe o que são. Aparecem porque a pessoa tem
  // os itens, mas só entram se a origem for escolhida.
  for (const [chunkId, items] of Object.entries(inventory.unidentified)) {
    add(items, "unidentified", Number(chunkId));
  }

  return rows;
}

export interface Filters {
  origins: Set<Origin>;
  hideUntradable: boolean;
  search: string;
}

/**
 * Filtra fora da TanStack Table de propósito.
 *
 * A mesma lista alimenta a tabela, o CSV e as contagens do cabeçalho. Se "origem" e
 * "intransferível" fossem filtros de coluna, o CSV exportaria uma coisa e a tela
 * mostraria outra — que é exatamente o erro que importa evitar aqui.
 */
export function applyFilters(
  rows: Row[],
  filters: Filters,
  isUntradable: (row: Row) => boolean,
): Row[] {
  const needle = filters.search.trim().toLowerCase();

  return rows.filter((row) => {
    if (!filters.origins.has(row.origin)) return false;
    if (filters.hideUntradable && isUntradable(row)) return false;
    if (needle.length > 0 && !row.item.name.toLowerCase().includes(needle)) return false;
    return true;
  });
}
