import { defineConfig } from "vitest/config";

/**
 * A suíte da aplicação. A raiz tem outra, só para os scripts de `tools/`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
  },
});
