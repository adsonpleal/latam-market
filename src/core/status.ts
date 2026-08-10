/**
 * Estado do serviço: quão fresco é o dado e o que já foi coletado.
 *
 * Existe porque `api/` e `mcp/` chamavam `store/read.js` direto para listar coletas —
 * a única brecha na regra de que os dois canais só enxergam `core/`. Publicar uma
 * linha do banco como se fosse contrato deixa o schema vazar para a resposta: mudar
 * uma coluna passaria a mudar a API.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Server } from "./servers.js";

import { listSnapshots } from "../store/read.js";
import { freshness } from "./prices.js";
import type { Freshness } from "./types.js";

/** Uma coleta concluída, no formato que o serviço publica. */
export interface Collection {
  id: number;
  dataset: string;
  server: string;
  /** Epoch em segundos. */
  startedAt: number;
  finishedAt: number | null;
  rows: number;
  /**
   * `crawl` (varredura periódica) ou `import` (backfill).
   *
   * Bancos antigos também têm `live`, de quando existia consulta pontual ao site. As
   * leituras já ignoram essas linhas; o valor continua aparecendo aqui porque o histórico
   * não é reescrito.
   */
  source: string;
}

export interface ServiceStatus {
  freshness: Freshness;
  collections: Collection[];
}

export function serviceStatus(db: DatabaseSync, server: Server, limit = 10): ServiceStatus {
  return {
    // O frescor é do servidor perguntado; a lista de coletas mostra os dois, porque
    // é a saúde do coletor que ela responde, não o estado de um mercado.
    freshness: freshness(server),
    collections: listSnapshots(db, limit).map((s) => ({
      id: s.id,
      dataset: s.dataset,
      server: s.server,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      rows: s.rowCount,
      source: s.source,
    })),
  };
}
