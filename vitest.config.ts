import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `tools/` entra porque os scripts de lá são JS puro, rodados por `node` direto: o
    // teste do catálogo importa `tools/sync-items.mjs`, e escrevê-lo em TS dentro de
    // `src/` obrigaria o tsc a enxergar `.mjs` (`allowJs`) só por causa dele — uma
    // frouxidão no projeto inteiro em troca de tipo nenhum, porque sem `checkJs` a
    // assinatura inferida é `any`.
    include: ["src/**/*.{test,spec}.ts", "tools/**/*.{test,spec}.mjs"],
    // Os testes de paridade sobem servidor HTTP e abrem banco; rodar arquivos em
    // paralelo embaralharia o cache global do mercado, que é um singleton de módulo.
    fileParallelism: false,
  },
});
