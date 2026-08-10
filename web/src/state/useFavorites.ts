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
  /** Devolve `false` quando o id é inválido ou já estava lá. Para o campo "colar um id". */
  add: (itemId: number) => boolean;
  remove: (itemId: number) => void;
}

export function useFavorites(): FavoritesApi {
  const { value: ids, set: write } = usePersistent(FAVORITES_KEY, EMPTY, parseFavorites);

  const asSet = useMemo(() => new Set(ids), [ids]);

  const add = useCallback(
    (itemId: number): boolean => {
      if (!Number.isInteger(itemId) || itemId <= 0) return false;
      let added = false;
      write((prev) => {
        if (prev.includes(itemId)) return prev;
        added = true;
        // No começo: quem acabou de favoritar quer ver o item, não procurá-lo no fim.
        return [itemId, ...prev];
      });
      return added;
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
      else add(itemId);
    },
    [asSet, add, remove],
  );

  const has = useCallback((itemId: number) => asSet.has(itemId), [asSet]);

  return { ids, has, set: asSet, toggle, add, remove };
}
