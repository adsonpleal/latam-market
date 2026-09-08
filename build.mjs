/**
 * Empacota o SHIPPER num único ESM autocontido.
 *
 * O que este build produz encolheu junto com o que ainda roda no EC2: a API, o MCP e a
 * interface são do Worker agora, publicados por `wrangler deploy`, e não passam por aqui.
 * Sobrou o processo que agenda o coletor e manda o resultado para `/internal/ingest`.
 *
 * O deploy dele continua sendo "um arquivo, copiado por scp" — sem node_modules no
 * servidor, sem passo de build lá. O catálogo também não vem mais junto: quem precisa dele
 * é a busca, que mora no Worker e o recebe como asset estático.
 */

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
await rm(resolve(root, "dist"), { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: "linked",
  // Algumas dependências transitivas chamam `require()` em runtime; em ESM não existe
  // esse global, então injetamos um.
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  logLevel: "info",
};

/**
 * A ponte da fase de escrita dupla.
 *
 * Enquanto o serviço antigo continua coletando e servindo (para ser um alvo de rollback
 * atualizado), ele é quem fala com o coletor — dois coletores ao mesmo tempo dividiriam a
 * paciência de rede que o coletor administra sozinho. Então a ponte não coleta: ela LÊ o
 * SQLite local, em modo somente-leitura, e empurra a coleta mais recente para o Worker.
 *
 * É o mesmo binário do bootstrap, e de propósito: a carga inicial e a ponte fazem a mesma
 * coisa, e o `crawlId` preso ao id do snapshot faz reenviar o que já foi ser um no-op.
 * Sai de cena junto com o serviço antigo.
 */
const bridge = await esbuild.build({
  ...shared,
  entryPoints: [resolve(root, "src/cli/bootstrap-blob.ts")],
  outfile: resolve(root, "dist/bridge.mjs"),
});

const shipper = await esbuild.build({
  ...shared,
  entryPoints: [resolve(root, "src/shipper/index.ts")],
  outfile: resolve(root, "dist/shipper.mjs"),
  metafile: true,
});

const bytes = Object.values(shipper.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`dist/shipper.mjs empacotado (${(bytes / 1024).toFixed(0)} KB com sourcemap)`);
