import { useCallback, useReducer } from "react";

import { ApiError, postReplay, type ReplayOptions } from "../api/client.js";
import type { ReplayResponse } from "../api/types.js";

export type ReplayState =
  | { kind: "idle" }
  | { kind: "loading"; fileName: string }
  | { kind: "error"; message: string }
  | { kind: "loaded"; fileName: string; valuation: ReplayResponse };

type Action =
  | { type: "start"; fileName: string }
  | { type: "ok"; fileName: string; valuation: ReplayResponse }
  | { type: "fail"; message: string }
  | { type: "clear" };

/**
 * O `.rrf` fica guardado para poder ser reprecificado.
 *
 * Trocar de servidor muda todos os preços, e pedir o arquivo de novo por causa disso
 * seria trabalho que o navegador já tem em mãos. É o File original, não uma cópia dos
 * bytes — custo praticamente zero.
 */
let lastFile: File | null = null;

function reducer(state: ReplayState, action: Action): ReplayState {
  switch (action.type) {
    case "start":
      return { kind: "loading", fileName: action.fileName };
    case "ok":
      return { kind: "loaded", fileName: action.fileName, valuation: action.valuation };
    case "fail":
      return { kind: "error", message: action.message };
    case "clear":
      return { kind: "idle" };
    default:
      return state;
  }
}

export interface ReplayController {
  state: ReplayState;
  upload: (file: File, opts?: ReplayOptions) => Promise<void>;
  /** Repete a última avaliação — usado quando o servidor ativo muda. */
  reprice: () => void;
  clear: () => void;
}

export function useReplay(onUploadStart?: () => void): ReplayController {
  const [state, dispatch] = useReducer(reducer, { kind: "idle" });

  const upload = useCallback(
    async (file: File, opts: ReplayOptions = {}): Promise<void> => {
      lastFile = file;
      dispatch({ type: "start", fileName: file.name });
      // O catálogo de descrições começa a baixar aqui, em paralelo: a ida e volta do
      // upload paga o download, e quando a tabela aparece o hover já funciona.
      onUploadStart?.();
      try {
        dispatch({ type: "ok", fileName: file.name, valuation: await postReplay(file, opts) });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : "Não foi possível falar com o serviço. Verifique sua conexão.";
        dispatch({ type: "fail", message });
      }
    },
    [onUploadStart],
  );

  const reprice = useCallback(() => {
    if (lastFile) void upload(lastFile);
  }, [upload]);

  const clear = useCallback(() => {
    lastFile = null;
    dispatch({ type: "clear" });
  }, []);

  return { state, upload, reprice, clear };
}
