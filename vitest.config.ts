import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Dois projetos, porque há dois runtimes.
 *
 * - **node** — lógica pura e o que ainda fala `node:sqlite`: taxonomia, texto, o decoder
 *   de replay, os rollups, o carregador do coletor e as regras de camada. Nada disso
 *   precisa de um Worker para ser conferido, e subir um custaria segundos por arquivo.
 *
 * - **workers** — o que só tem sentido DENTRO do runtime de produção: a paridade entre a
 *   API e o MCP, a ingestão e o cache de borda. Aqui os testes rodam no `workerd` de
 *   verdade, com D1 e R2 locais de verdade — não com dublês. Era a parte que faltava:
 *   a suíte antiga subia um `node:http` que não existe mais em produção, então ela
 *   provava o comportamento de um servidor que ninguém roda.
 *
 * As migrações entram como binding para o `applyD1Migrations` poder criar o schema em cada
 * teste a partir do MESMO `migrations/` que o deploy aplica — em vez de uma cópia do DDL
 * que envelhece em silêncio.
 */
const migrations = await readD1Migrations(resolve(import.meta.dirname, "migrations"));

/**
 * Os `.rrf` entram por `provide`, em base64.
 *
 * Dentro do `workerd` não há `node:fs` — e é exatamente por isso que os testes valem: o
 * Worker de produção também não tem. Ler os fixtures aqui, do lado do Node que monta a
 * suíte, é a única forma de levá-los para lá sem fingir um sistema de arquivos.
 */
const fixture = (name: string): string =>
  readFileSync(
    resolve(import.meta.dirname, "src/replay/__tests__/fixtures", name),
  ).toString("base64");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: [
            "src/{core,util,replay,collect,cli,store,shipper}/**/*.test.ts",
            "src/__tests__/{layering,no-leaks,config-timing}.test.ts",
            // `tools/` entra porque os scripts de lá são JS puro, rodados por `node`
            // direto: o teste do catálogo importa `tools/sync-items.mjs`, e escrevê-lo em
            // TS dentro de `src/` obrigaria o tsc a enxergar `.mjs` (`allowJs`) só por
            // causa dele — uma frouxidão no projeto inteiro em troca de tipo nenhum.
            "tools/**/*.{test,spec}.mjs",
          ],
          // `store/blob.test.ts` publica no cache global do mercado, que é singleton de
          // módulo. Enquanto houver um arquivo que escreve nele, rodar em paralelo
          // embaralharia leituras de outro.
          fileParallelism: false,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                // O segredo da ingestão é secret em produção (`wrangler secret put`), então
                // não vem do wrangler.jsonc. Aqui ele existe para os testes poderem semear
                // pelo MESMO caminho que o shipper usa.
                INGEST_SECRET: "segredo-de-teste",
              },
            },
          }),
        ],
        test: {
          name: "workers",
          include: ["src/__tests__/parity.test.ts", "src/edge/**/*.test.ts"],
          provide: {
            replays: {
              "storage-test.rrf": fixture("storage-test.rrf"),
              "equip-test-2.rrf": fixture("equip-test-2.rrf"),
            },
          },
        },
      },
    ],
  },
});
