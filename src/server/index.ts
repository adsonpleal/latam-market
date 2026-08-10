/**
 * Ponto de entrada do serviço.
 *
 * Ordem do boot, e o porquê de cada passo estar onde está:
 *  1. abre o banco e monta o cache — sem isso a primeira requisição responderia vazio;
 *  2. sobe o servidor HTTP, já pronto para atender;
 *  3. liga o agendador do crawl, se houver coletor instalado e a coleta estiver habilitada.
 *
 * O passo 3 é o único opcional, e é opcional de verdade: sem coletor o serviço fica de pé
 * servindo o histórico que estiver no banco, que é o que responde a maior parte das
 * perguntas. É também como um clone deste repositório roda.
 */

import { statSync } from "node:fs";

import { TAXONOMY_VERSION } from "../core/taxonomy.js";
import { LATAM_ITEMS_PATH } from "../store/paths.js";
import { openDb } from "../store/db.js";
import { DEFAULT_SERVER } from "../core/servers.js";
import { getCache, refreshAllCaches } from "../store/cache.js";
import { loadCatalogue } from "../store/write.js";
import { config } from "./config.js";
import { createHttpServer } from "./http.js";
import { startScheduler, type Scheduler } from "../worker/scheduler.js";

const db = openDb();

/**
 * Recarrega o catálogo só quando o arquivo mudou.
 *
 * Reimportar as 14.379 linhas custa ~112 ms e um pico de 20 MB de heap — a maior
 * alocação que o processo faz, num teto de 256 MB. O arquivo só muda em deploy, e o
 * `Restart=always` do systemd pode reiniciar o serviço várias vezes seguidas.
 */
function syncCatalogue(): string {
  const file = statSync(LATAM_ITEMS_PATH);
  // A versão da taxonomia entra no carimbo porque `loadCatalogue` grava a classificação
  // derivada: mudar as regras sem trocar o arquivo precisa forçar uma recarga.
  const stamp = `${file.mtimeMs}:${file.size}:tax${TAXONOMY_VERSION}`;
  const seen = db.prepare(`SELECT value FROM meta WHERE key = 'catalogue_stamp'`).get() as
    | { value: string }
    | undefined;

  if (seen?.value === stamp) return "inalterado";

  const count = loadCatalogue(db);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('catalogue_stamp', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(stamp);
  return `${count} itens carregados`;
}

console.log(`[boot] catálogo: ${syncCatalogue()}`);
refreshAllCaches(db);
const cache = getCache(DEFAULT_SERVER);
console.log(
  `[boot] cache: ${cache.prices.size} com preço, ${cache.listings.size} com oferta`,
);

// O agendador só nasce depois do servidor, então a API o alcança por uma função — que
// devolve `null` enquanto ele não existe, ou se não houver coleta neste processo.
let scheduler: Scheduler | null = null;

const server = createHttpServer(db, {
  nextRun: (dataset, marketServer) => scheduler?.nextRun(dataset, marketServer) ?? null,
});
server.listen(config.port, config.host, () => {
  console.log(
    `[boot] ouvindo em http://${config.host}:${config.port} ` +
      `(API em /api/v1, MCP em /mcp, saúde em /healthz)`,
  );
});

// Basta saber se há coletor configurado: quem o carrega de verdade é cada worker de
// coleta, que precisa do seu próprio (nem o handle do banco nem o coletor atravessam
// threads). Carregá-lo aqui só para conferir abriria uma saída de rede que este processo
// não usa para nada.
if (config.collectorPath === "") {
  console.log("[boot] sem coletor instalado — servindo o histórico já coletado.");
} else if (!config.crawl.enabled) {
  console.log("[boot] agendador do crawl desligado (CRAWL_ENABLED != 1)");
} else {
  scheduler = startScheduler(db);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[boot] ${signal} recebido, encerrando.`);
    scheduler?.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Se algo travar no encerramento, não ficar pendurado para sempre segurando a porta.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
