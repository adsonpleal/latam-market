import { useCallback, useState } from "react";

// A lista vem do cliente da API, que é quem carimba o parâmetro — uma cópia aqui
// seria um segundo lugar para lembrar de editar.
export { SERVERS } from "../api/client.js";
import { getServer, setServer as persist, type Server } from "../api/client.js";

/**
 * Servidor ativo, com o valor real guardado no cliente da API.
 *
 * O estado do React aqui existe só para provocar re-render; a fonte é o
 * `client.ts`, porque é ele que carimba o parâmetro em toda requisição. Se o React
 * fosse a fonte, uma chamada disparada fora de um componente sairia com o servidor
 * errado.
 */
export function useServer(): { server: Server; change: (next: Server) => void } {
  const [server, setLocal] = useState<Server>(getServer);

  const change = useCallback((next: Server) => {
    persist(next);
    setLocal(next);
  }, []);

  return { server, change };
}
