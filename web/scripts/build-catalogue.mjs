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
 * Saídas (as duas com `.br`/`.zst`/`.gz` ao lado, para o `file_server precompressed`):
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
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { isUntradable } from "./catalogue-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const source = resolve(webRoot, "..", "data", "latam-items.json");
const publicDir = join(webRoot, "public", "generated");
const genDir = join(webRoot, "src", "generated");

if (!existsSync(source)) {
  console.error(`catálogo não encontrado em ${source}`);
  console.error("rode `pnpm sync:items` na raiz para trazê-lo do projeto irmão.");
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
  if (!keep.has(stale.replace(/\.(br|gz|zst)$/, ""))) {
    rmSync(join(publicDir, stale), { force: true });
  }
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

/** Grava o JSON com hash no nome, mais as variantes comprimidas. Devolve a URL. */
function emit(name, data) {
  const json = JSON.stringify(data);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 8);
  const file = `${name}.${hash}.json`;
  const path = join(publicDir, file);
  const raw = Buffer.from(json, "utf8");
  keep.add(file);

  // O nome JÁ é o hash do conteúdo, então um `.br` existente só pode ter vindo deste
  // mesmo JSON. Sem esta saída antecipada o brotli de qualidade 11 recomprimia 5,4 MB
  // a cada `dev`, `test`, `typecheck` e `build` — 11 s medidos, três vezes por deploy,
  // sempre para produzir byte a byte o mesmo arquivo.
  if (existsSync(`${path}.br`)) {
    console.log(`  ${file} — reaproveitado`);
    return `/generated/${file}`;
  }

  writeFileSync(path, raw);
  writeFileSync(
    `${path}.br`,
    zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    }),
  );
  writeFileSync(`${path}.gz`, zlib.gzipSync(raw, { level: 9 }));
  // zstd só existe no node:zlib a partir do 22.15. O Caddy tenta as codificações na
  // ordem configurada e cai para a próxima, então a ausência degrada sozinha.
  if (typeof zlib.zstdCompressSync === "function") {
    writeFileSync(`${path}.zst`, zlib.zstdCompressSync(raw));
  }

  console.log(
    `  ${file} — ${kb(raw.length)} cru, ${kb(statSync(`${path}.br`).size)} brotli, ` +
      `${kb(statSync(`${path}.gz`).size)} gzip`,
  );
  return `/generated/${file}`;
}
