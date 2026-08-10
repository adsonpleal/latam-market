/**
 * Quais colunas de uma tabela estão à vista, guardado entre sessões.
 *
 * Saiu de dentro de `ItemsTable` quando a tabela de favoritos passou a precisar do mesmo
 * comportamento. Cada tabela tem a SUA chave: esconder uma coluna nos favoritos não pode
 * apagar coluna do inventário.
 *
 * É só um `usePersistent` com o formato certo. A primeira versão reimplementava o
 * try/catch/JSON à mão — o que, além de repetir, deixava a escolha sem sincronia entre
 * abas e confiava num `as` sobre o que estava guardado.
 */

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { VisibilityState } from "@tanstack/react-table";

import { parseVisibility } from "../lib/persist.js";
import { usePersistent } from "./usePersistent.js";

/**
 * O par devolvido é o do `useState` de propósito: a TanStack chama
 * `onColumnVisibilityChange` com um ATUALIZADOR, não com o valor pronto.
 */
export function useColumnVisibility(
  key: string,
  defaultHidden: VisibilityState,
): [VisibilityState, Dispatch<SetStateAction<VisibilityState>>] {
  const { value, set } = usePersistent<VisibilityState>(key, defaultHidden, parseVisibility);
  return [value, useCallback<Dispatch<SetStateAction<VisibilityState>>>((next) => set(next), [set])];
}
