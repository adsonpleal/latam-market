import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * O proxy reproduz a topologia de produção: em produção o Caddy serve a SPA e a API na
 * MESMA origem, então o front nunca monta URL absoluta e não existe CORS.
 *
 * Aponta para o backend LOCAL (`pnpm dev` na raiz), e não para produção. O serviço no
 * EC2 sobe com `ALLOWED_ORIGINS=https://claude.ai,https://mercado.latam-tools.com.br`
 * (infra/latam-market.service), sem `http://localhost:5173` — que só existe no padrão
 * do src/server/config.ts. O proxy do Vite repassa o `Origin` intacto (`changeOrigin`
 * mexe no `Host`, não nele), então apontar para lá devolve 403 em tudo.
 */
/**
 * A porta do backend vem do ambiente para dois backends locais poderem conviver — duas
 * cópias do projeto, ou um `pnpm start` já ocupando a 8788. O padrão é o do
 * `src/server/config.ts`, então o caso normal não precisa configurar nada.
 */
const BACKEND = `http://127.0.0.1:${process.env["BACKEND_PORT"] ?? 8788}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env["WEB_PORT"] ?? 5173),
    proxy: {
      "/api": { target: BACKEND, changeOrigin: false },
      "/healthz": { target: BACKEND, changeOrigin: false },
    },
  },
  build: {
    // Os 5,4 MB de descrições são um asset em public/, copiado sem passar pelo bundler.
    // Só o JS/CSS da aplicação chega aqui, e ele é pequeno.
    chunkSizeWarningLimit: 700,
  },
});
