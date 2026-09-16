/**
 * A conexão com a aba do mercado, vista pelo React.
 *
 * Um cliente só para a página inteira, criado no primeiro uso: a conversa com a aba do
 * mercado é da janela, não de um componente, e dois clientes responderiam ao mesmo anúncio
 * como se fossem duas páginas.
 */

import { useCallback, useEffect, useState } from "react";

import { BridgeClient, type BridgeState } from "../bridge/client.js";
import { ticker } from "../lib/market/ticker.js";

/** De quanto em quanto tempo perguntar à conexão se ela está viva. Custa uma mensagem. */
const PING_MS = 10_000;

let shared: BridgeClient | null = null;

export function bridgeClient(): BridgeClient {
  shared ??= new BridgeClient(window);
  return shared;
}

export interface BridgeApi {
  client: BridgeClient;
  state: BridgeState;
  open: (url: string) => void;
}

export function useBridge(): BridgeApi {
  const client = bridgeClient();
  const [state, setState] = useState<BridgeState>(() => client.state());

  useEffect(() => {
    const update = () => setState(client.state());
    const unsubscribe = client.subscribe(update);
    // Pelo relógio do worker: com a aba em segundo plano, é justamente quando a conexão mais
    // precisa ser conferida — o ciclo vai rodar sem ninguém olhando.
    const stop = ticker().every(PING_MS, () => client.ping());
    client.ping();
    update();
    return () => {
      unsubscribe();
      stop();
    };
  }, [client]);

  const open = useCallback((url: string) => client.open(url), [client]);

  return { client, state, open };
}
