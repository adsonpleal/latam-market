/**
 * Extrai da `data/latam-items.json` os dois pedaços que o navegador precisa e nenhum
 * a mais.
 *
 * O catálogo tem 6,6 MB e nunca muda entre deploys, então ele **não** passa pela API:
 * vira asset estático servido pelo mesmo Caddy, com hash no nome e cache imutável.
 * Alternativas descartadas, e por quê:
 *
 *   - rota `/api/v1/items/:id/description`: obrigaria a manter os 5,4 MB de texto
 *     residentes no processo, que roda com `MemoryMax=384M`, para servir dado que é
 *     constante entre deploys.
 *   - campo `description` no `ItemBrief`: ele vai embutido em toda resposta dos dois
 *     canais. Uma busca com `limit=100` passaria a gastar centenas de KB do contexto
 *     do agente no MCP, que é o produto principal do projeto.
 *
 * Saídas (só o JSON: a Cloudflare comprime na entrega, então os `.br`/`.zst`/`.gz` que
 * existiam aqui para o `file_server precompressed` do Caddy viraram arquivos mortos —
 * servidos com o Content-Type errado, ocupando o orçamento de arquivos do deploy, e
 * custando 11 s de brotli em todo build para produzir byte a byte o que já existia):
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

const descriptions = {};
const untradable = [];
for (const [id, rec] of Object.entries(catalogue)) {
  if (rec.description) descriptions[id] = rec.description;
  if (isUntradable(rec.description)) untradable.push(Number(id));
}
untradable.sort((a, b) => a - b);

mkdirSync(publicDir, { recursive: true });
mkdirSync(genDir, { recursive: true });

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const keep = new Set();

const descriptionsUrl = emit("descriptions", descriptions);
const untradableUrl = emit("untradable", untradable);

// O nome carrega hash do conteúdo, então saída de execução anterior com catálogo
// diferente ficaria para trás e subiria no tar para sempre. Varre em vez de apagar o
// diretório inteiro, senão o `emit` nunca encontraria nada para reaproveitar.
for (const stale of readdirSync(publicDir)) {
  if (!keep.has(stale)) rmSync(join(publicDir, stale), { force: true });
}

writeFileSync(
  join(genDir, "catalogue.ts"),
  "// GERADO por scripts/build-catalogue.mjs — não edite à mão.\n" +
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
