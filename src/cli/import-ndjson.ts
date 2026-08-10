/**
 * Importa os NDJSON já coletados para o SQLite.
 *
 *   pnpm import --run-id full
 *
 * Serve para o backfill inicial (os arquivos em data/raw/ são o histórico que existe
 * antes do servidor começar a coletar sozinho) e para reimportar depois de mexer no
 * schema. É idempotente por snapshot: rodar duas vezes cria dois snapshots com o mesmo
 * conteúdo, então use `--replace` para trocar o anterior em vez de empilhar.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

import { DATASETS, type Dataset } from "../core/datasets.js";
import { DEFAULT_SERVER as SERVER } from "../core/servers.js";
import { ndjsonPath } from "../store/paths.js";
import type { Row } from "../store/rows.js";
import { openDb, transact } from "../store/db.js";
import {
  abortSnapshot,
  beginSnapshot,
  finishSnapshot,
  loadCatalogue,
  rollupDaily,
  rollupListings,
  writeRows,
} from "../store/write.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const runId = arg("run-id", "full")!;
const only = arg("dataset") as Dataset | undefined;
const datasets = only ? [only] : DATASETS;
const replace = flag("replace");

const db = openDb();

console.log(`catálogo: ${loadCatalogue(db)} itens`);

for (const dataset of datasets) {
  const file = ndjsonPath(runId, dataset, SERVER);
  if (!existsSync(file)) {
    console.log(`${dataset}: sem arquivo em ${file}, pulando`);
    continue;
  }

  // O mtime do arquivo é o melhor carimbo de tempo disponível: os NDJSON não guardam
  // quando foram coletados, e usar "agora" colocaria uma coleta antiga no topo da
  // linha do tempo, o que estragaria qualquer leitura de tendência.
  const collectedAt = Math.floor(statSync(file).mtimeMs / 1000);

  if (replace) {
    const olds = db
      .prepare(
        `SELECT id FROM snapshot WHERE dataset = ? AND server = ? AND source = 'import'`,
      )
      .all(dataset, SERVER) as Array<{ id: number }>;
    for (const { id } of olds) abortSnapshot(db, id);
    if (olds.length > 0) console.log(`${dataset}: ${olds.length} import(s) anterior(es) removido(s)`);
  }

  const snap = beginSnapshot(db, dataset, SERVER, "import", collectedAt);

  let batch: Row[] = [];
  const started = Date.now();

  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        batch.push(JSON.parse(line) as Row);
      } catch {
        // Última linha rasgada de um run interrompido — o sink é append-only.
        continue;
      }
      if (batch.length >= 1000) {
        writeRows(db, snap, batch);
        batch = [];
      }
    }
    if (batch.length > 0) writeRows(db, snap, batch);

    if (dataset === "trading") {
      const items = rollupListings(db, snap);
      transact(db, () => rollupDaily(db, SERVER, collectedAt));
      console.log(`${dataset}: rollup de ${items} itens`);
    }

    // A contagem vem do snapshot fechado, não da soma dos lotes: os NDJSON se sobrepõem
    // de propósito, e somar `writeRows` contaria a mesma linha várias vezes.
    const total = finishSnapshot(db, snap.id, dataset);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `${dataset}: ${total} linhas -> snapshot ${snap.id} ` +
        `(coletado em ${new Date(collectedAt * 1000).toISOString()}, ${secs}s)`,
    );
  } catch (err) {
    abortSnapshot(db, snap.id);
    throw err;
  }
}

db.close();
