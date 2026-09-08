/**
 * Construção do servidor MCP.
 *
 * Um `McpServer` novo por POST: o transporte é stateless, então não há sessão para
 * guardar. Registrar as ferramentas custa microssegundos — o estado caro (o cache do
 * mercado e o handle do banco) é compartilhado e nunca reconstruído.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { Db } from "../store/port.js";

import { config } from "../config.js";
import { registerTools } from "./tools.js";

/**
 * As instruções são o lugar onde a regra do caro-versus-barato é dita uma vez para o
 * agente todo: o modelo lê as ferramentas isoladamente e escolhe a que parece mais
 * precisa, não a mais barata.
 */
export const buildInstructions = (): string =>
  [
    "Dados do mercado de jogadores do Ragnarok Online LATAM (servidor FREYA).",
    "",
    "Todas as ferramentas respondem instantaneamente a partir das coletas periódicas, que",
    "costumam ter menos de uma hora — data_status mostra a idade. Não existe consulta ao",
    "vivo: para o mercado deste instante, mande a pessoa ao site oficial (o link vem em",
    "`links.market` de qualquer item).",
    "",
    "value_inventory é a única que custa caro: recebe o replay .rrf em base64, o que gasta",
    "dezenas de milhares de tokens do seu contexto. Se você consegue fazer requisições HTTP,",
    `mande o arquivo binário para ${config.publicUrl}/api/v1/replay e receba o mesmo JSON de graça.`,
    "",
    "Ao dar um preço, diga de quando é o dado (o campo `freshness` vem em toda resposta).",
    "`market` é o histórico de vendas publicado pelo site; `offers` é o que está à venda",
    "agora. São medidas diferentes e não se somam.",
  ].join("\n");

/**
 * Montadas uma vez por isolate.
 *
 * Mesma razão dos schemas em `tools.ts`: a linha do replay interpola `config.publicUrl`,
 * que no Worker só existe depois de `applyEnv` rodar dentro do `fetch`. Como constante de
 * módulo ela congelaria o padrão e passaria a anunciar o endereço errado para o agente —
 * em silêncio, porque continua sendo uma URL válida.
 */
let instructions: string | null = null;
const getInstructions = (): string => (instructions ??= buildInstructions());

export function createMcpServer(db: Db): McpServer {
  const server = new McpServer(
    // Acompanha a versão do pacote; já divergiu três vezes por ficar esquecida aqui.
    { name: "latam-market", version: "0.10.0" },
    { instructions: getInstructions() },
  );
  registerTools(server, db);
  return server;
}
