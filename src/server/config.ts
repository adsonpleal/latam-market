/**
 * Configuração do servidor, toda por variável de ambiente (ver a unit do systemd).
 *
 * É só o que muda entre a máquina de desenvolvimento e o EC2. O que o coletor precisa
 * saber para funcionar é assunto dele, e vem do ambiente dele.
 */

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (key: string, fallback: string): string[] =>
  (process.env[key] ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  /** 8787 já está ocupado nesta máquina. */
  port: num("PORT", 8788),
  host: process.env["HOST"] ?? "127.0.0.1",

  /**
   * Endereço público do serviço.
   *
   * O MCP precisa saber o próprio endereço para poder dizer ao agente "manda o arquivo
   * por aqui em vez de codificar em base64". Vem do ambiente porque quem hospedar isto
   * em outro lugar não deveria ter que editar a descrição de uma ferramenta.
   */
  publicUrl: (process.env["PUBLIC_URL"] ?? "https://mercado.latam-tools.com.br").replace(/\/+$/, ""),

  /**
   * Defesa contra DNS rebinding: só aceitamos requisições cujo Host seja um dos
   * nomes por onde o serviço realmente é publicado.
   */
  allowedHosts: list("ALLOWED_HOSTS", "mercado.latam-tools.com.br,localhost,127.0.0.1"),
  allowedOrigins: list(
    "ALLOWED_ORIGINS",
    "https://claude.ai,https://mercado.latam-tools.com.br,http://localhost:5173",
  ),

  limits: {
    /** Corpo do /mcp. Um replay em base64 tem ~120 KB, então 1 MB dá folga. */
    mcpBodyBytes: num("MAX_MCP_BODY", 1024 * 1024),
    /** Upload de `.rrf` cru. Os maiores do acervo têm poucas centenas de KB. */
    replayBytes: num("MAX_REPLAY_BYTES", 8 * 1024 * 1024),
    /** Teto de itens numa resposta de busca. */
    maxResults: num("MAX_RESULTS", 100),
    /**
     * Teto de ids numa consulta em lote (`/prices`).
     *
     * Separado do `maxResults` de propósito: aquele limita o TAMANHO DA RESPOSTA de uma
     * busca e pode ser baixado à vontade; este limita a LISTA PEDIDA, e baixá-lo passa a
     * recusar a aba Favoritos de quem tem mais favoritos que o novo teto.
     */
    maxBatchItems: num("MAX_BATCH_ITEMS", 100),
  },

  /**
   * Caminho do módulo que implementa a coleta (ver `collect/port.ts`).
   *
   * Vazio é o padrão e um estado válido: o serviço sobe e serve o que já está no banco.
   * Quem coleta é um componente à parte, instalado ao lado — este repositório não o traz.
   */
  collectorPath: process.env["COLLECTOR_PATH"] ?? "",

  crawl: {
    /** Liga o agendador embutido. Desligado em dev para não sair coletando sozinho. */
    enabled: process.env["CRAWL_ENABLED"] === "1",
    tradingEveryMin: num("CRAWL_TRADING_MIN", 30),
    marketEveryMin: num("CRAWL_MARKET_MIN", 360),
  },
};
