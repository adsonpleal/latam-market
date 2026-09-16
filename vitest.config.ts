import { defineConfig } from "vitest/config";

/**
 * Os testes da raiz são só os de `tools/` — scripts em JS puro, rodados por `node` direto
 * (o do catálogo e a guarda contra vazamento do coletor). A aplicação tem a suíte dela em
 * `web/`.
 */
export default defineConfig({
  test: {
    include: ["tools/**/*.{test,spec}.mjs"],
  },
});
