/**
 * O catálogo de itens, visto pelo React.
 *
 * A cache é a de `lib/catalogue/catalogue.ts`; aqui só se re-renderiza quando ele chega (ou
 * falha). Toda tela que precisa de nome, tipo ou busca usa este hook, em vez de cada uma
 * montar o próprio efeito de carregar.
 */

import { useEffect, useState } from "react";

import { loadItems, loadedItems, type ItemIndex } from "../lib/catalogue/catalogue.js";

export interface ItemIndexState {
  /** `null` enquanto não chegou. */
  index: ItemIndex | null;
  /** O download falhou; quem depende dele precisa avisar. */
  failed: boolean;
}

export function useItemIndex(): ItemIndexState {
  const [index, setIndex] = useState(loadedItems);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (index) return;
    let alive = true;
    loadItems()
      .then((loaded) => alive && setIndex(loaded))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [index]);

  return { index, failed };
}
