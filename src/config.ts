/**
 * Configuração do serviço, toda por variável de ambiente.
 *
 * É só o que muda entre a máquina de desenvolvimento, o Worker e o EC2. O que o coletor
 * precisa saber para funcionar é assunto dele, e vem do ambiente dele.
 *
 * Era um `const` montado no topo do módulo lendo `process.env` direto. No Worker isso não
 * existe: `env` só chega dentro do handler, e módulo é avaliado antes de qualquer
 * requisição. Por isso o objeto agora nasce com os padrões e `applyEnv` o preenche — o
 * formato de `config.x` continua igual em todos os lugares que já o usavam.
 *
 * Mora na raiz de `src/`, e não sob `server/` ou `edge/`, porque os dois lados o leem: o
 * Worker (API + MCP) e o shipper que roda ao lado do coletor.
 */

/** De onde a configuração sai: `process.env` no Node, o objeto de bindings no Worker. */
export type EnvSource = Record<string, unknown>;

const str = (env: EnvSource, key: string, fallback: string): string => {
  const raw = env[key];
  return typeof raw === "string" && raw !== "" ? raw : fallback;
};

const num = (env: EnvSource, key: string, fallback: number): number => {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (env: EnvSource, key: string, fallback: string): string[] =>
  str(env, key, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_PUBLIC_URL = "https://mercado.latam-tools.com.br";
const DEFAULT_HOSTS = "mercado.latam-tools.com.br,localhost,127.0.0.1";
const DEFAULT_ORIGINS =
  "https://claude.ai,https://mercado.latam-tools.com.br,https://visuais.latam-tools.com.br,http://localhost:5173";

export const config = {
  /** 8787 já está ocupado nesta máquina. Só o shipper e o `wrangler dev` usam. */
  port: 8788,
  host: "127.0.0.1",

  /**
   * Endereço público do serviço.
   *
   * O MCP precisa saber o próprio endereço para poder dizer ao agente "manda o arquivo
   * por aqui em vez de codificar em base64". Vem do ambiente porque quem hospedar isto
   * em outro lugar não deveria ter que editar a descrição de uma ferramenta.
   */
  publicUrl: DEFAULT_PUBLIC_URL,

  /**
   * Defesa contra DNS rebinding: só aceitamos requisições cujo Host seja um dos
   * nomes por onde o serviço realmente é publicado.
   */
  allowedHosts: DEFAULT_HOSTS.split(","),
  allowedOrigins: DEFAULT_ORIGINS.split(","),

  limits: {
    /** Corpo do /mcp. Um replay em base64 tem ~120 KB, então 1 MB dá folga. */
    mcpBodyBytes: 1024 * 1024,
    /** Upload de `.rrf` cru. Os maiores do acervo têm poucas centenas de KB. */
    replayBytes: 8 * 1024 * 1024,
    /** Teto de itens numa resposta de busca. */
    maxResults: 100,
    /**
     * Teto de ids numa consulta em lote (`/prices`).
     *
     * Separado do `maxResults` de propósito: aquele limita o TAMANHO DA RESPOSTA de uma
     * busca e pode ser baixado à vontade; este limita a LISTA PEDIDA, e baixá-lo passa a
     * recusar a aba Favoritos de quem tem mais favoritos que o novo teto.
     */
    maxBatchItems: 100,
  },

  /**
   * Caminho do módulo que implementa a coleta (ver `collect/port.ts`).
   *
   * Vazio é o padrão e um estado válido. Só o shipper o lê — no Worker é sempre vazio.
   */
  collectorPath: "",

  crawl: {
    /** Liga o agendador do shipper. Desligado em dev para não sair coletando sozinho. */
    enabled: false,
    tradingEveryMin: 30,
    marketEveryMin: 360,
  },
};

/**
 * Preenche a configuração a partir do ambiente.
 *
 * Idempotente e barata, porque roda no começo de TODA requisição do Worker: o `env` é o
 * mesmo objeto durante a vida do isolate, então a comparação por identidade faz o trabalho
 * acontecer uma vez só. Guardar por um booleano simples não serviria — os testes trocam de
 * ambiente entre casos, e um `applyEnv` que ignora o segundo ambiente seria pior que não
 * existir.
 */
let lastEnv: EnvSource | null = null;

export function applyEnv(env: EnvSource): void {
  if (lastEnv === env) return;

  config.port = num(env, "PORT", 8788);
  config.host = str(env, "HOST", "127.0.0.1");
  config.publicUrl = str(env, "PUBLIC_URL", DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  config.allowedHosts = list(env, "ALLOWED_HOSTS", DEFAULT_HOSTS);
  config.allowedOrigins = list(env, "ALLOWED_ORIGINS", DEFAULT_ORIGINS);

  config.limits.mcpBodyBytes = num(env, "MAX_MCP_BODY", 1024 * 1024);
  config.limits.replayBytes = num(env, "MAX_REPLAY_BYTES", 8 * 1024 * 1024);
  config.limits.maxResults = num(env, "MAX_RESULTS", 100);
  config.limits.maxBatchItems = num(env, "MAX_BATCH_ITEMS", 100);

  config.collectorPath = str(env, "COLLECTOR_PATH", "");
  config.crawl.enabled = env["CRAWL_ENABLED"] === "1";
  config.crawl.tradingEveryMin = num(env, "CRAWL_TRADING_MIN", 30);
  config.crawl.marketEveryMin = num(env, "CRAWL_MARKET_MIN", 360);

  lastEnv = env;
}
