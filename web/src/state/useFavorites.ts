/**
 * A lista de favoritos, compartilhada entre os dois servidores.
 *
 * Um item é o mesmo objeto do jogo em FREYA e em NIDHOGG, então favoritar vale para os
 * dois. O que é por servidor é o ALVO do alerta, porque os preços não se parecem — isso
 * mora em `useAlerts`.
 *
 * Cada componente chama este hook por conta própria, sem prop drilling: o evento
 * intra-janela do `usePersistent` é justamente o que mantém todas as estrelas da tela em
 * sincronia.
 */

import { useCallback, useMemo } from "react";

import { FAVORITES_KEY, parseFavorites } from "../lib/persist.js";
import { usePersistent } from "./usePersistent.js";

const EMPTY: number[] = [];

export interface FavoritesApi {
  /** Para a tabela e a ordem de exibição — o mais recente primeiro. */
  ids: number[];
  has: (itemId: number) => boolean;
  set: Set<number>;
  toggle: (itemId: number) => void;
  /** Vários de uma vez, numa escrita só. */
  addMany: (itemIds: readonly number[]) => void;
  remove: (itemId: number) => void;
  /** Tira todos os que `keep` não segurar, numa escrita só. */
  removeAllExcept: (keep: (itemId: number) => boolean) => void;
}

export function useFavorites(): FavoritesApi {
  const { value: ids, set: write } = usePersistent(FAVORITES_KEY, EMPTY, parseFavorites);

  const asSet = useMemo(() => new Set(ids), [ids]);

  /**
   * Uma escrita só, e não uma por item: "favoritar todos" numa busca de mil resultados seriam
   * mil gravações no `localStorage` e mil eventos para cada estrela da tela.
   */
  const addMany = useCallback(
    (itemIds: readonly number[]) => {
      write((prev) => {
        const present = new Set(prev);
        const fresh = [...new Set(itemIds)].filter((id) => Number.isInteger(id) && id > 0 && !present.has(id));
        // No começo: quem acabou de favoritar quer ver o item, não procurá-lo no fim.
        return fresh.length === 0 ? prev : [...fresh, ...prev];
      });
    },
    [write],
  );

  const removeAllExcept = useCallback(
    (keep: (itemId: number) => boolean) => {
      write((prev) => {
        const next = prev.filter(keep);
        return next.length === prev.length ? prev : next;
      });
    },
    [write],
  );

  const remove = useCallback(
    (itemId: number) => {
      // Devolver `prev` quando não há nada a tirar evita gravação e re-render inúteis.
      write((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : prev));
    },
    [write],
  );

  // Delegado, para a regra "o novo entra no começo" viver num lugar só.
  const toggle = useCallback(
    (itemId: number) => {
      if (asSet.has(itemId)) remove(itemId);
      else addMany([itemId]);
    },
    [asSet, addMany, remove],
  );

  const has = useCallback((itemId: number) => asSet.has(itemId), [asSet]);

  return { ids, has, set: asSet, toggle, addMany, remove, removeAllExcept };
}
