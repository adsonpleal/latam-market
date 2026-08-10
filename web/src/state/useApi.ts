import { useEffect, useState, type DependencyList } from "react";

import { messageOf } from "../api/client.js";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
}

/**
 * Uma busca à API amarrada ao ciclo de vida do componente.
 *
 * Existe porque a mesma trava de `alive`, o mesmo funil de `ApiError` e o mesmo par
 * "erro / Carregando…" estavam escritos em cada página. Concentrar aqui também tira o
 * risco de uma resposta atrasada de uma janela anterior sobrescrever a atual.
 *
 * `deps` é o que a busca depende — passe valores estáveis. Um objeto recriado a cada
 * render faz esta busca rodar de novo a cada render.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null });

  useEffect(() => {
    let alive = true;
    setState({ data: null, error: null });

    fetcher()
      .then((data) => alive && setState({ data, error: null }))
      .catch((err: unknown) => alive && setState({ data: null, error: messageOf(err) }));

    return () => {
      alive = false;
    };
    // O chamador declara as dependências: `fetcher` é uma closure nova a cada render e
    // não pode entrar na lista.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
