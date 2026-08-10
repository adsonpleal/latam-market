import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.ts"],
    // Os testes de paridade sobem servidor HTTP e abrem banco; rodar arquivos em
    // paralelo embaralharia o cache global do mercado, que é um singleton de módulo.
    fileParallelism: false,
  },
});
