/**
 * Extrai da `data/latam-items.json` os pedaços que o navegador precisa e nenhum a mais.
 *
 * O site é só arquivos estáticos: não há servidor para buscar item ou ler replay, então tudo
 * que a interface sabe sobre o catálogo sai daqui, com hash no nome e cache imutável. São
 * três arquivos, e não um, porque pesam e servem a momentos muito diferentes:
 *
 *   - `items` (id, nome, slots, tipo e onde equipa) é o que a busca, os favoritos e o
 *     inventário precisam para nomear e filtrar — baixado na primeira vez que alguém precisa;
 *   - `untradable` é minúsculo e alimenta o filtro de "não dá para vender";
 *   - `descriptions` é o grosso (5,4 MB) e só serve ao hover — carrega por último.
 *
 * Saídas (só o JSON: a Cloudflare comprime na entrega):
 *   public/generated/items.<sha8>.json         [[<id>, "<nome>", <slots>, <tipo>, "<posições>"], ...]
 *   public/generated/descriptions.<sha8>.json  { "<id>": "<descrição>" }
 *   public/generated/untradable.<sha8>.json    [<id>, ...]
 *   src/generated/catalogue.ts                 as URLs, com o hash embutido
 *
 * O hash no nome é o que torna `Cache-Control: immutable` seguro, e pô-lo num módulo
 * TS faz ele viajar dentro do bundle já versionado — sem manifesto e sem uma ida extra
 * ao servidor só para descobrir o nome do arquivo.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// TypeScript direto do `src/`: o script roda com `tsx`, e a interface usa as mesmas listas de
// rótulos. Uma cópia das regras em JS aqui seria duas definições que combinam até alguém
// corrigir uma só.
import { classify } from "../src/lib/catalogue/taxonomy.ts";
import { isUntradable } from "./catalogue-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const source = resolve(webRoot, "..", "data", "latam-items.json");
const publicDir = join(webRoot, "public", "generated");
const genDir = join(webRoot, "src", "generated");

if (!existsSync(source)) {
  console.error(`catálogo não encontrado em ${source}`);
  console.error("rode `pnpm sync:items` na raiz para trazê-lo do ragassets.");
  process.exit(1);
}

const catalogue = JSON.parse(readFileSync(source, "utf8"));

// Colunar e ordenado por id: uma lista de objetos repetiria as chaves 14 mil vezes, e a ordem
// fixa faz o hash só mudar quando o conteúdo muda. Tipo e posição saem da descrição, aqui no
// build, para a busca poder filtrar sem baixar os 5 MB de descrições (ver `taxonomy.ts`).
const items = [];
const descriptions = {};
const untradable = [];
for (const [id, rec] of Object.entries(catalogue)) {
  const { type, slots } = classify(rec.name, rec.description);
  items.push([
    Number(id),
    rec.name,
    typeof rec.slots === "number" ? rec.slots : null,
    type,
    slots.length > 0 ? slots.join(",") : null,
  ]);
  if (rec.description) descriptions[id] = rec.description;
  if (isUntradable(rec.description)) untradable.push(Number(id));
}
items.sort((a, b) => a[0] - b[0]);
untradable.sort((a, b) => a - b);

mkdirSync(publicDir, { recursive: true });
mkdirSync(genDir, { recursive: true });

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const keep = new Set();

const itemsUrl = emit("items", items);
const descriptionsUrl = emit("descriptions", descriptions);
const untradableUrl = emit("untradable", untradable);

// O nome carrega hash do conteúdo, então saída de execução anterior com catálogo
// diferente ficaria para trás e subiria em todo deploy para sempre. Varre em vez de apagar o
// diretório inteiro, senão o `emit` nunca encontraria nada para reaproveitar.
for (const stale of readdirSync(publicDir)) {
  if (!keep.has(stale)) rmSync(join(publicDir, stale), { force: true });
}

writeFileSync(
  join(genDir, "catalogue.ts"),
  "// GERADO por scripts/build-catalogue.mjs — não edite à mão.\n" +
    `export const ITEMS_URL = ${JSON.stringify(itemsUrl)};\n` +
    `export const DESCRIPTIONS_URL = ${JSON.stringify(descriptionsUrl)};\n` +
    `export const UNTRADABLE_URL = ${JSON.stringify(untradableUrl)};\n`,
  "utf8",
);

console.log(
  `catálogo: ${Object.keys(catalogue).length} itens, ` +
    `${Object.keys(descriptions).length} com descrição, ` +
    `${untradable.length} intransferíveis`,
);

/** Grava o JSON com hash no nome. Devolve a URL. */
function emit(name, data) {
  const json = JSON.stringify(data);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 8);
  const file = `${name}.${hash}.json`;
  const raw = Buffer.from(json, "utf8");
  keep.add(file);

  writeFileSync(join(publicDir, file), raw);
  console.log(`  ${file} — ${kb(raw.length)}`);
  return `/generated/${file}`;
}
