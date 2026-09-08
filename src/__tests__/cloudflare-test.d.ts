/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";

/**
 * O que os testes do projeto `workers` enxergam além dos bindings de produção.
 *
 * `Cloudflare.Env` é a interface que o `wrangler types` gera a partir do wrangler.jsonc; o
 * pool tipa o `env` de `cloudflare:test` por ela. Aqui ela é ESTENDIDA (declaration
 * merging) com o que só existe em teste: as migrações, para criar o schema, e o segredo da
 * ingestão — que em produção é `wrangler secret put` e por isso não aparece no
 * wrangler.jsonc nem no tipo gerado.
 */
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      INGEST_SECRET: string;
    }
  }
}

/** Os `.rrf` que o `vitest.config.ts` injeta em base64 (não há `node:fs` no workerd). */
declare module "vitest" {
  interface ProvidedContext {
    replays: Record<string, string>;
  }
}

export {};
