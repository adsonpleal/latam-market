import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      // `tools/` entra porque os scripts de lá são JS puro, rodados por `node` direto: o teste
      // do catálogo importa `tools/sync-items.mjs`, e escrevê-lo em TS dentro de `src/`
      // obrigaria o tsc a enxergar `.mjs` (`allowJs`) só por causa dele.
      "tools/**/*.{test,spec}.mjs",
    ],
    // O cache do mercado é singleton de módulo. Enquanto houver arquivos que escrevem nele,
    // rodar em paralelo embaralharia leituras de outro.
    fileParallelism: false,
  },
});
