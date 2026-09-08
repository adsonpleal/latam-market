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
    /**
     * 30min. Foi 15 por uma hora e meia, e a tentativa é o motivo do número.
     *
     * O piso da cadência NÃO é quanto tempo uma coleta leva — é quanto tempo o coletor
     * deixa uma saída de molho quando ela é recusada. Se a cadência for parecida com esse
     * descanso, a saída que tropeça só volta na coleta seguinte: perde a que está rodando
     * inteira. E some justamente quando faz mais falta, porque a carga dela vai para as
     * poucas outras, que também tropeçam. Cascata.
     *
     * Foi o que aconteceu em 2026-09-08 com 15min: 5 coletas boas, 4 DESCARTADAS por
     * passar de 20% de unidades falhando e 5 puladas por a anterior ainda estar rodando —
     * o frescor foi de 3min para 65. Pior que os 30min que a mudança queria melhorar.
     *
     * A regra que sai disso: a cadência tem que ser confortavelmente maior que o descanso,
     * para uma saída castigada voltar DENTRO do mesmo ciclo.
     *
     * Descer daqui exige mais saídas distintas ou um descanso menor, e nenhuma das duas é
     * decisão deste repositório: os números vivem no do coletor, junto do que os mediu.
     */
    tradingEveryMin: 30,
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
  // Lido por prefixo, e não por uma lista de servidores conhecidos: `SERVERS` mora em
  // `core/` e este arquivo é lido pelos dois lados (Worker e shipper) antes de qualquer
  // coisa. Um nome de servidor novo passa a ter cadência própria sem tocar aqui.
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
