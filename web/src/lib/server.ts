/**
 * Servidor do jogo escolhido, guardado entre sessões.
 *
 * FREYA e NIDHOGG são mercados diferentes: é daqui que sai o `serverType` de cada consulta
 * ao site e o servidor a que pertence o alvo de cada alerta. O inventário e o catálogo não
 * dependem dele.
 *
 * Estado de módulo, e não só React, porque é lido fora de componente — na montagem da URL
 * de cada consulta, dentro do laço. `useServer` leva o valor para o React.
 */

const SERVER_KEY = "latam-market:server";
export const SERVERS = ["FREYA", "NIDHOGG"] as const;
export type Server = (typeof SERVERS)[number];

let activeServer: Server = (() => {
  try {
    const saved = localStorage.getItem(SERVER_KEY);
    return SERVERS.find((s) => s === saved) ?? "FREYA";
  } catch {
    return "FREYA";
  }
})();

export const getServer = (): Server => activeServer;

export function setServer(server: Server): void {
  activeServer = server;
  try {
    localStorage.setItem(SERVER_KEY, server);
  } catch {
    // Modo privado sem storage: a escolha vale só para esta aba.
  }
}
