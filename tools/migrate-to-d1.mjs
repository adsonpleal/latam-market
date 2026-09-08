/**
 * Projeta um `market.db` do EC2 no schema do D1 e emite o SQL de carga.
 *
 * Não é um `.dump`. O schema mudou, e a diferença é o ponto:
 *
 *   - **`listing` e `store` NÃO vêm.** Os anúncios crus tinham um leitor só, sempre no
 *     snapshot mais recente; os 24 que a retenção guardava nunca eram lidos. No D1 eles
 *     custariam ~120 M linhas escritas/mês entre inserção, índice e o DELETE da retenção.
 *     O retrato corrente é reconstruído no R2 por `src/cli/bootstrap-blob.ts`.
 *   - **`listing_stats` vem recortado** pela mesma janela que a retenção aplica. Carregar o
 *     que seria apagado na primeira varredura é pagar duas vezes por nada.
 *   - **`meta` não vem.** A única chave lá é o `catalogue_stamp`, estado de boot de um
 *     processo que não existe mais.
 *
 * O que sobra tem chave primária natural em todas as tabelas, e é isso que torna a carga
 * repetível: reimportar uma janela sobreposta não duplica nada. É a mesma propriedade de
 * que o catch-up do cutover depende.
 *
 * Duas decisões vêm do tamanho real da base (~6,7 milhões de linhas, 5,2 M só de
 * `listing_stats`):
 *
 *   - **A leitura é por cursor.** `all()` materializaria os 5,2 M em objetos JS de uma vez,
 *     o que estoura a memória da máquina antes de escrever a primeira linha.
 *   - **A saída é fatiada.** Um arquivo só faria a carga inteira depender de uma execução do
 *     `wrangler` não falhar no meio. Em pedaços, um erro custa o pedaço.
 *
 * Uso:
 *   node tools/migrate-to-d1.mjs <origem.db> <prefixo> [--stats-days 30]
 *                                [--since-snapshot N] [--chunk-mb 40]
 */

import { createRequire } from "node:module";
import { closeSync, openSync, writeSync } from "node:fs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

const [source, prefix] = process.argv.slice(2);
if (!source || !prefix) {
  console.error(
    "uso: node tools/migrate-to-d1.mjs <origem.db> <prefixo> [--stats-days N] [--since-snapshot N] [--chunk-mb N]",
  );
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const statsDays = arg("--stats-days", 30);
const chunkBytes = arg("--chunk-mb", 40) * 1024 * 1024;
/** Para o catch-up: só o que entrou depois do snapshot já importado. */
const sinceSnapshot = arg("--since-snapshot", 0);

const db = new DatabaseSync(source, { readOnly: true });

// --------------------------------------------------------------------------
// Saída fatiada
// --------------------------------------------------------------------------

const files = [];
let handle = null;
let written = 0;

function openNext() {
  if (handle !== null) closeSync(handle);
  const name = `${prefix}-${String(files.length + 1).padStart(3, "0")}.sql`;
  files.push(name);
  handle = openSync(name, "w");
  written = 0;
}

function put(text) {
  // A troca acontece entre statements, nunca no meio de um: cada pedaço tem que ser SQL
  // válido sozinho, senão a carga por partes não funciona.
  if (handle === null || written + text.length > chunkBytes) openNext();
  writeSync(handle, text);
  written += text.length;
}

/**
 * Escapa um valor para embutir no SQL.
 *
 * Embutir, e não vincular, porque a saída é um arquivo que o `wrangler d1 execute` lê — não
 * há parâmetros ali. Por isso o número é conferido em vez de confiado: um `NaN` ou um
 * `Infinity` interpolado viraria SQL inválido no meio de uma carga de milhões de linhas.
 */
function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`número inválido: ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Teto por statement. O D1 recusa acima de 100 KB; 80 KB deixa folga para a linha maior. */
const MAX_STATEMENT_BYTES = 80_000;

/**
 * Emite uma tabela inteira, lendo por cursor.
 *
 * `iterate()` entrega linha a linha; `all()` traria os 5,2 M de `listing_stats` de uma vez.
 */
function emit(table, columns, query, params = []) {
  const head = `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES\n`;
  let buffer = "";
  let count = 0;

  const flush = () => {
    if (buffer === "") return;
    put(`${head}${buffer};\n`);
    buffer = "";
  };

  for (const row of db.prepare(query).iterate(...params)) {
    const tuple = `(${columns.map((c) => sql(row[c])).join(",")})`;
    if (buffer !== "" && buffer.length + tuple.length > MAX_STATEMENT_BYTES) flush();
    buffer += buffer === "" ? tuple : `,\n${tuple}`;
    count++;
  }
  flush();

  console.log(`  ${table.padEnd(14)} ${count.toLocaleString("pt-BR")}`);
  return count;
}

// --------------------------------------------------------------------------

console.log(`lendo ${source}`);
const version = db.prepare("PRAGMA user_version").get().user_version;
if (version !== 3) {
  // O projetor conhece o schema v3. Um banco mais novo pode ter colunas que ele ignora em
  // silêncio — melhor parar do que carregar dado pela metade.
  throw new Error(`banco na versão ${version}, esperada 3`);
}

const totals = {};

totals.item = emit(
  "item",
  ["item_id", "name", "name_norm", "img_path", "db_type", "slots", "aegis_name", "item_type", "equip_slots"],
  `SELECT item_id, name, name_norm, img_path, db_type, slots, aegis_name, item_type, equip_slots
     FROM item ORDER BY item_id`,
);

totals.item_market = emit(
  "item_market",
  ["item_id", "server", "in_market", "first_seen", "last_seen"],
  `SELECT item_id, server, in_market, first_seen, last_seen
     FROM item_market WHERE in_market = 1 ORDER BY server, item_id`,
);

totals.snapshot = emit(
  "snapshot",
  ["id", "server", "dataset", "started_at", "finished_at", "row_count", "ok", "source"],
  `SELECT id, server, dataset, started_at, finished_at, row_count, ok, source
     FROM snapshot WHERE ok = 1 AND id > ? ORDER BY id`,
  [sinceSnapshot],
);

totals.price_point = emit(
  "price_point",
  ["server", "item_id", "ts", "snapshot_id", "total_cnt", "min_price", "max_price", "avg_price"],
  `SELECT server, item_id, ts, snapshot_id, total_cnt, min_price, max_price, avg_price
     FROM price_point WHERE snapshot_id > ? ORDER BY server, item_id, ts`,
  [sinceSnapshot],
);

const statsFrom = Math.floor(Date.now() / 1000) - statsDays * 86400;

totals.listing_stats = emit(
  "listing_stats",
  ["server", "item_id", "ts", "listings", "units", "min_price", "p25", "median", "p75", "max_price"],
  `SELECT server, item_id, ts, listings, units, min_price, p25, median, p75, max_price
     FROM listing_stats WHERE ts >= ? ORDER BY server, item_id, ts`,
  [statsFrom],
);

totals.listing_daily = emit(
  "listing_daily",
  ["server", "item_id", "day", "listings", "units", "min_price", "p25", "median", "p75", "max_price"],
  // O diário vive para sempre: é a base de `movers`, `deals` e do `appraise`.
  `SELECT server, item_id, day, listings, units, min_price, p25, median, p75, max_price
     FROM listing_daily ORDER BY server, item_id, day`,
);

if (handle !== null) closeSync(handle);

/**
 * A marca d'água do catch-up.
 *
 * Entre este dump e o cutover a EC2 continua coletando. Reimportar a partir daqui, com
 * `--since-snapshot`, cobre a diferença — e como toda tabela tem PK natural, sobrepor a
 * janela é seguro.
 */
const watermark = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM snapshot WHERE ok = 1`).get();
const total = Object.values(totals).reduce((a, b) => a + b, 0);
console.log(`\n${files.length} arquivo(s): ${files[0]} .. ${files[files.length - 1]}`);
console.log(`total de linhas: ${total.toLocaleString("pt-BR")}`);
console.log(`marca d'água (--since-snapshot para o catch-up): ${watermark.id}`);
db.close();
