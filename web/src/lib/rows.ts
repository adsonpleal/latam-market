/** A avaliação vem em containers; a tabela quer uma lista só, com a origem marcada. */

import type { ItemOrigin, ReplayResponse, ValuedItem } from "../api/types.js";

/**
 * As origens do backend mais a que só existe aqui.
 *
 * `ItemOrigin` vem de `core/replay.ts` em vez de ser reescrita: é a mesma lista que
 * `sellCandidates` carimba em cada item, e uma cópia à mão erraria calada — um container
 * novo lá viraria um erro de tipo em `ORIGIN_LABEL[candidate.origin]`, longe da tabela de
 * rótulos que é o que de fato precisa da entrada nova. `unidentified` fica de fora de
 * `ItemOrigin` de propósito: nada ali é candidato a venda, então o backend não a inclui.
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

export interface Row extends ValuedItem {
  origin: Origin;
  /** Identidade estável da linha: o mesmo item pode ocupar dois slots. */
  key: string;
}

export function flatten(valuation: ReplayResponse): Row[] {
  const rows: Row[] = [];

  const add = (items: ValuedItem[], origin: Origin, containerId?: number): void => {
    for (const item of items) {
      rows.push({
        ...item,
        origin,
        key: `${origin}-${containerId ?? ""}-${item.slot}-${item.item.itemId}`,
      });
    }
  };

  add(valuation.inventory.items, "inventory");
  add(valuation.cart.items, "cart");
  add(valuation.equipped.items, "equipped");
  // Os armazéns são `null` quando a janela não foi aberta na gravação — aí não há linha
  // para mostrar, o que é diferente de mostrar um armazém vazio.
  add(valuation.storage?.items ?? [], "storage");
  add(valuation.guildStorage?.items ?? [], "guildStorage");
  // Containers que o decodificador ainda não sabe o que são. Aparecem porque a pessoa tem
  // os itens, mas o backend os deixa fora do total e a interface segue essa regra: só
  // entram se a origem for escolhida.
  for (const [chunkId, items] of Object.entries(valuation.unidentified)) {
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
 * A mesma lista alimenta a tabela, o CSV e os totais do cabeçalho. Se "origem" e
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

export const sumValue = (rows: Row[]): number =>
  rows.reduce((total, row) => total + (row.total ?? 0), 0);

export const countUnpriced = (rows: Row[]): number =>
  rows.reduce((n, row) => n + (row.total === null ? 1 : 0), 0);
