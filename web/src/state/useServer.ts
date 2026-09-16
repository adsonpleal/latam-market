import { useCallback, useState } from "react";

// A lista vem de `lib/server.ts`, que é quem guarda o servidor — uma cópia aqui seria um
// segundo lugar para lembrar de editar.
export { SERVERS } from "../lib/server.js";
import { getServer, setServer as persist, type Server } from "../lib/server.js";

/**
 * Servidor ativo, com o valor real guardado em `lib/server.ts`.
 *
 * O estado do React aqui existe só para provocar re-render; a fonte é o módulo, porque é
 * dele que sai o `serverType` de cada consulta ao site. Se o React
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
