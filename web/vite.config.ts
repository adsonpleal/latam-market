import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Só arquivos estáticos: não há backend para onde fazer proxy. O catálogo sai de
 * `scripts/build-catalogue.mjs` para `public/generated/`, e o replay é lido no navegador.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env["WEB_PORT"] ?? 5173),
  },
  build: {
    // Os 5,4 MB de descrições e o catálogo de itens são assets em public/, copiados sem
    // passar pelo bundler. Só o JS/CSS da aplicação chega aqui — o parser de replay incluso.
    chunkSizeWarningLimit: 700,
  },
});
