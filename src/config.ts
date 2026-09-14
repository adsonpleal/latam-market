/**
 * Configuração do serviço, toda por variável de ambiente.
 *
 * É só o que muda entre a máquina de desenvolvimento e a VM. O que o coletor precisa saber
 * para funcionar é assunto dele, e vem do ambiente dele.
 *
 * O objeto nasce com os padrões e `applyEnv` o preenche no boot. Os testes chamam
 * `applyEnv` com outros ambientes, e o formato de `config.x` é o mesmo em todo lugar.
 */

/** De onde a configuração sai: `process.env` no processo, um objeto qualquer nos testes. */
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
  /** Só o túnel fala com o servidor, então ele escuta no endereço local. */
  port: 8788,
  host: "127.0.0.1",

  /** O banco, fora de `/opt/latam-market` — o deploy faz `rsync --delete` lá. */
  dbPath: "data/market.db",
  /** A interface já buildada (`web/dist`). */
  staticDir: "web/dist",
  /** Os arquivos de `migrations/`, que viajam junto com o bundle. */
  migrationsDir: "migrations",
  /**
   * Quanto tempo uma oferta vive sem ser confirmada por nenhuma coleta.
   *
   * Um item cujos termos falham coleta após coleta não é decidido, e continua com as
   * ofertas que tinha. Depois disto elas saem: vender o preço de duas horas atrás como "à
   * venda agora" é pior que não mostrar.
   */
  offerMaxAgeMin: 120,

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
   * Vazio é o padrão e um estado válido: o serviço sobe e serve o histórico.
   */
  collectorPath: "",

  crawl: {
    /** Liga o agendador. Desligado em dev para não sair coletando sozinho. */
    enabled: false,
    /**
     * 10min, para os dois servidores.
     *
     * O piso da cadência nunca foi quanto tempo uma coleta leva — foi quanto tempo uma saída
     * de rede recusada fica de molho. Com poucas saídas compartilhadas, a 15 minutos a que
     * tropeçava só voltava na coleta seguinte, e a carga dela derrubava as outras: em
     * 2026-09-08 foram 5 coletas boas, 4 descartadas e 5 puladas.
     *
     * Com 31 endereços próprios e publicação por item, uma saída de molho some no meio das
     * outras, e um termo que falha segura só os itens dele. As duas coisas moram no
     * repositório do coletor; é por elas que o número pôde descer.
     */
    tradingEveryMin: 10,
    /**
     * Cadência por servidor, quando um deles merece atenção diferente do outro.
     *
     * Preenchido por `CRAWL_TRADING_MIN_<SERVIDOR>`; o que não aparecer aqui usa o
     * `tradingEveryMin` acima. Existe porque os dois mercados não custam o mesmo nem valem
     * o mesmo: FREYA traz ~4x mais linhas que NIDHOGG por ~1,6x as requisições, então
     * prendê-los à mesma cadência gasta orçamento no mercado menor para adiar o maior.
     */
    tradingEveryMinByServer: {} as Record<string, number>,
    marketEveryMin: 360,
  },
};

/** A cadência que vale para este servidor: a dele, ou o padrão. */
export function tradingEveryMinFor(server: string): number {
  return config.crawl.tradingEveryMinByServer[server] ?? config.crawl.tradingEveryMin;
}

/**
 * Preenche a configuração a partir do ambiente.
 *
 * Idempotente: reaplicar o MESMO objeto não faz nada. Guardar por um booleano simples não
 * serviria — os testes trocam de ambiente entre casos, e um `applyEnv` que ignora o segundo
 * ambiente seria pior que não existir.
 */
let lastEnv: EnvSource | null = null;

export function applyEnv(env: EnvSource): void {
  if (lastEnv === env) return;

  config.port = num(env, "PORT", 8788);
  config.host = str(env, "HOST", "127.0.0.1");
  config.dbPath = str(env, "DB_PATH", "data/market.db");
  config.staticDir = str(env, "STATIC_DIR", "web/dist");
  config.migrationsDir = str(env, "MIGRATIONS_DIR", "migrations");
  config.offerMaxAgeMin = num(env, "OFFER_MAX_AGE_MIN", 120);
  config.publicUrl = str(env, "PUBLIC_URL", DEFAULT_PUBLIC_URL).replace(/\/+$/, "");
  config.allowedHosts = list(env, "ALLOWED_HOSTS", DEFAULT_HOSTS);
  config.allowedOrigins = list(env, "ALLOWED_ORIGINS", DEFAULT_ORIGINS);

  config.limits.mcpBodyBytes = num(env, "MAX_MCP_BODY", 1024 * 1024);
  config.limits.replayBytes = num(env, "MAX_REPLAY_BYTES", 8 * 1024 * 1024);
  config.limits.maxResults = num(env, "MAX_RESULTS", 100);
  config.limits.maxBatchItems = num(env, "MAX_BATCH_ITEMS", 100);

  config.collectorPath = str(env, "COLLECTOR_PATH", "");
  config.crawl.enabled = env["CRAWL_ENABLED"] === "1";
  config.crawl.tradingEveryMin = num(env, "CRAWL_TRADING_MIN", 10);
  // Lido por prefixo, e não por uma lista de servidores conhecidos: um nome de servidor
  // novo passa a ter cadência própria sem tocar aqui.
  config.crawl.tradingEveryMinByServer = {};
  for (const key of Object.keys(env)) {
    const match = /^CRAWL_TRADING_MIN_(.+)$/.exec(key);
    if (!match) continue;
    const minutes = num(env, key, 0);
    if (minutes > 0) config.crawl.tradingEveryMinByServer[match[1]!] = minutes;
  }
  config.crawl.marketEveryMin = num(env, "CRAWL_MARKET_MIN", 360);

  lastEnv = env;
}
