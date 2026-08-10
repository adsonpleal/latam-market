import { defineConfig } from "vitest/config";

/**
 * Config própria, separada da raiz: o `fileParallelism: false` de lá existe por causa
 * do cache de mercado ser um singleton de módulo no servidor, o que não vale aqui.
 * A raiz também não enxerga estes testes — o `include` dela é ancorado em `src/**`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
  },
});
