/**
 * Manda um crawl para o Worker.
 *
 * O coletor continua onde está, com a saída de rede que só ele administra; o que mudou é o
 * destino das linhas. Em vez de gravar SQLite no disco ao lado, elas viajam como NDJSON
 * comprimido para `/internal/ingest`, e é o Worker quem abre o snapshot, calcula os
 * percentis, grava no D1 e publica o retrato no R2.
 *
 * Isso apaga a razão de existir das worker threads: elas existiam porque `node:sqlite` é
 * síncrono e ~20 mil inserts na thread principal travariam a API por segundos. Aqui não há
 * API neste processo e não há escrita síncrona — só um POST.
 */

import { gzipSync } from "node:zlib";
import { createHmac, createHash } from "node:crypto";

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { Row } from "../store/rows.js";

export interface ShipRequest {
  dataset: Dataset;
  server: Server;
  startedAt: number;
  /** Um por crawl: é o que torna um reenvio depois de timeout inofensivo. */
  crawlId: string;
  /**
   * Quando a PRÓXIMA coleta está agendada, já com o jitter aplicado.
   *
   * Vai junto porque só o agendador sabe o número exato, e é dele que sai o
   * `nextTradingAt` que o navegador usa para dormir até a coleta pousar. Sem ele o Worker
   * cairia na estimativa `última + 30min` e erraria por até cinco minutos.
   */
  nextRunAt: number;
  /** Só a carga inicial usa: semeia `inMarket` com o histórico (ver `edge/ingest.ts`). */
  inMarketSeed?: number[];
  rows: Row[];
}

export interface ShipResult {
  snapshotId: number;
  duplicate: boolean;
  rows: number;
  /** Linhas que o agrupamento por (item, loja, preço) absorveu. Ver `edge/ingest.ts`. */
  grouped?: number;
}

export interface ShipTarget {
  url: string;
  secret: string;
}

export async function ship(target: ShipTarget, request: ShipRequest): Promise<ShipResult> {
  const { rows, ...header } = request;
  const ndjson = [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join("\n");
  const body = gzipSync(Buffer.from(ndjson, "utf8"));

  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", target.secret)
    .update(`${timestamp}\n${request.crawlId}\n${digest}`)
    .digest("hex");

  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-ndjson",
      "content-encoding": "gzip",
      "x-ingest-timestamp": String(timestamp),
      "x-ingest-crawl-id": request.crawlId,
      "x-ingest-signature": `sha256=${signature}`,
    },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`ingestão recusou (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload as unknown as ShipResult;
}
