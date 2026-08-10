/**
 * Utilidades das ferramentas MCP, no mesmo formato do projeto irmão (ro-mcp).
 *
 * O ponto de `registerJsonTool` é transformar exceção em resultado legível: um erro
 * que escapa vira falha de transporte, e o agente recebe "erro interno" sem saber o
 * que fazer. Como resultado com `isError`, ele lê a mensagem e corrige a chamada.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_SERVER, SERVERS, type Server } from "../core/servers.js";

const wrap = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true as const } : {}),
});

export const json = (payload: unknown, isError = false) =>
  wrap(JSON.stringify(payload, null, 1), isError);

/**
 * Sem indentação, para payload que é uma lista longa de números.
 *
 * O `json` indenta com um espaço, o que para um punhado de objetos custa quase nada e
 * deixa a resposta legível. Numa resposta de alguns milhares de inteiros, porém, o
 * indentador põe uma quebra de linha antes de CADA um — o agente passa a pagar um token
 * de formatação por id. É o caso do `market_ids`, e só dele.
 */
export const jsonCompact = (payload: unknown) => wrap(JSON.stringify(payload));

export const fail = (error: unknown) =>
  json({ erro: error instanceof Error ? error.message : String(error) }, true);

/**
 * Descrição de uma ferramenta.
 *
 * Escrita à mão em vez de `Parameters<McpServer["registerTool"]>[1]` porque
 * `registerTool` é sobrecarregado, e `Parameters` de uma sobrecarga resolve para
 * `never` — o que faz toda chamada não compilar.
 */
export interface ToolConfig {
  title?: string;
  description?: string;
  /** Shape cru do zod (um objeto de validadores), não um `z.object`. */
  inputSchema?: Record<string, z.ZodType>;
  annotations?: Record<string, unknown>;
}

/**
 * O argumento de servidor, acrescentado a TODA ferramenta aqui e não em cada schema.
 *
 * Toda ferramenta daqui aceita servidor, então isto é uniforme, não caso
 * especial — e pendurá-lo em cada uma exigia repetir a entrada no schema e no tipo do
 * handler, que já tinham divergido: `data_status` declarava `Record<string, never>` e
 * lia `args.servidor` mesmo assim. Centralizado, esquecer deixa de ser possível.
 */
const servidorSchema = z
  .enum(SERVERS)
  .optional()
  .describe("Servidor do mercado. Padrão FREYA.");

export function registerJsonTool<A>(
  server: McpServer,
  name: string,
  config: ToolConfig,
  handler: (args: A, market: Server) => unknown | Promise<unknown>,
): void {
  const withServer: ToolConfig = {
    ...config,
    inputSchema: { ...(config.inputSchema ?? {}), servidor: servidorSchema },
  };

  server.registerTool(name, withServer as never, (async (args: A & { servidor?: Server }) => {
    try {
      return await handler(args, args.servidor ?? DEFAULT_SERVER);
    } catch (error) {
      return fail(error);
    }
  }) as never);
}

/** Envelope uniforme de listagem, para o agente saber que houve corte. */
export function paged<T, R>(
  key: string,
  total: number,
  rows: T[],
  offset: number,
  map: (row: T) => R,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    total,
    mostrando: rows.length,
    offset,
    [key]: rows.map(map),
  };
  if (offset + rows.length < total) {
    out["dica"] = `Há mais ${total - offset - rows.length}. Repita com offset=${offset + rows.length}.`;
  }
  return out;
}
