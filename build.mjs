/**
 * Empacota o serviço num ESM autocontido, para a VM.
 *
 * O deploy continua sendo "um arquivo, copiado por scp" — sem node_modules no servidor,
 * sem passo de build lá. Saem três coisas:
 *
 *  - `dist/server.mjs`: API, MCP, interface e agendador da coleta;
 *  - `dist/crawl-thread.mjs`: a worker thread que carrega o coletor, ao lado do bundle
 *    (`node/crawl-runner.ts` a procura ali);
 *  - `dist/import-cloudflare.mjs`: a carga única do histórico que veio do D1.
 *
 * A interface (`web/dist`) e as migrações (`migrations/`) viajam junto, como arquivos.
 */

import { copyFile, rm } from "node:fs/promises";
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

const server = await esbuild.build({
  ...shared,
  entryPoints: [resolve(root, "src/node/index.ts")],
  outfile: resolve(root, "dist/server.mjs"),
  metafile: true,
});

await esbuild.build({
  ...shared,
  entryPoints: [resolve(root, "src/cli/import-cloudflare.ts")],
  outfile: resolve(root, "dist/import-cloudflare.mjs"),
});

// JavaScript puro e sem dependências: copiado, não empacotado.
await copyFile(resolve(root, "src/collect/crawl-thread.mjs"), resolve(root, "dist/crawl-thread.mjs"));

const bytes = Object.values(server.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`dist/server.mjs empacotado (${(bytes / 1024).toFixed(0)} KB com sourcemap)`);
