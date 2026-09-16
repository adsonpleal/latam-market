/**
 * O replay carregado, lido dentro do navegador.
 *
 * O arquivo não sai do computador: é lido com `rrfparser` e nomeado pelo catálogo estático.
 * Mora no `App` para sair para Favoritos e voltar não perder o que foi carregado.
 */

import { useCallback, useState } from "react";

import { loadItems, type ItemIndex } from "../lib/catalogue/catalogue.js";
import { readReplay, type ReplayInventory } from "../lib/replay/inventory.js";

export type ReplayState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; inventory: ReplayInventory };

export interface ReplayController {
  state: ReplayState;
  upload: (file: File) => Promise<void>;
  clear: () => void;
}

export function useReplay(onUploadStart?: () => void): ReplayController {
  const [state, setState] = useState<ReplayState>({ kind: "idle" });

  const upload = useCallback(
    async (file: File): Promise<void> => {
      setState({ kind: "loading" });
      // O catálogo de descrições começa a baixar aqui, em paralelo: quando a tabela aparece,
      // o hover já funciona.
      onUploadStart?.();

      let loaded: [ItemIndex, ArrayBuffer];
      try {
        // Os dois ao mesmo tempo: ler o arquivo do disco não espera o catálogo chegar.
        loaded = await Promise.all([loadItems(), file.arrayBuffer()]);
      } catch {
        setState({
          kind: "error",
          message: "Não foi possível carregar o catálogo de itens. Verifique sua conexão e tente de novo.",
        });
        return;
      }
      const [index, bytes] = loaded;

      // Uma volta do laço antes do trabalho síncrono, para o "lendo…" chegar a aparecer: um
      // replay de vários megabytes segura a thread da página enquanto é decodificado.
      // `setTimeout`, e não `requestAnimationFrame`: com a aba em segundo plano o navegador
      // para de pintar, e a leitura ficaria esperando a pessoa voltar para a aba.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        setState({ kind: "loaded", inventory: readReplay(bytes, index) });
      } catch {
        setState({
          kind: "error",
          message: "Este arquivo não parece um replay do Ragnarok (.rrf), ou está corrompido.",
        });
      }
    },
    [onUploadStart],
  );

  const clear = useCallback(() => setState({ kind: "idle" }), []);

  return { state, upload, clear };
}
