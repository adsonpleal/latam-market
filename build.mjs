/**
 * Empacota o servidor num único ESM autocontido.
 *
 * O deploy é "um arquivo e os dados ao lado", copiado por scp — sem node_modules no
 * servidor, sem passo de build lá. Os JSON de dados NÃO são embutidos: 6,6 MB de
 * literais de objeto em JavaScript parseiam mais devagar que o JSON equivalente e
 * ficariam retidos duas vezes na memória.
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

const server = await esbuild.build({
  ...shared,
  entryPoints: [resolve(root, "src/server/index.ts")],
  outfile: resolve(root, "dist/server.mjs"),
  metafile: true,
});

// Os workers são arquivos à parte porque `new Worker()` carrega por caminho: se
// fossem para dentro do bundle principal, o caminho não existiria em runtime. Os
// nomes têm que bater com o que `scheduler.ts` resolve em `workerPath()`.
for (const worker of ["crawl-worker", "retention-worker"]) {
  await esbuild.build({
    ...shared,
    entryPoints: [resolve(root, `src/worker/${worker}.ts`)],
    outfile: resolve(root, `dist/${worker}.js`),
  });
}

const bytes = Object.values(server.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);
console.log(`dist/server.mjs empacotado (${(bytes / 1024 / 1024).toFixed(2)} MB com sourcemap)`);
