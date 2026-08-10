/**
 * Que servidores de mercado existem.
 *
 * Mora em `core/`, e não na configuração do coletor onde nasceu, porque deixou de ser
 * detalhe dele: a API, o MCP e o banco falam de servidor o tempo todo. O que eles precisam
 * é do conceito, não de como alguém vai buscar o dado. Ver `core/datasets.ts`, que saiu de
 * lá pelo mesmo motivo.
 */

/** O site expõe exatamente estes dois. */
export const SERVERS = ["FREYA", "NIDHOGG"] as const;
export type Server = (typeof SERVERS)[number];

/**
 * Servidor assumido quando ninguém diz qual.
 *
 * FREYA porque é o que tem histórico acumulado e o que toda chamada existente da API e
 * do MCP significava antes de haver escolha — mudar o padrão reescreveria o sentido de
 * conversas já em andamento com agentes.
 */
export const DEFAULT_SERVER: Server = "FREYA";

/** Normaliza o que veio de fora. `null` quando não é um servidor conhecido. */
export function parseServer(raw: string | null | undefined): Server | null {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_SERVER;
  return SERVERS.find((s) => s === raw.toUpperCase()) ?? null;
}
