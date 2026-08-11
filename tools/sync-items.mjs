/**
 * Atualiza `data/latam-items.json` a partir da tabela de itens do ragassets.
 *
 * O catálogo é vendorizado em vez de buscado em tempo de execução porque o servidor sobe
 * como um bundle único no EC2 e carrega o catálogo antes de escutar: uma ida à rede no
 * boot seria uma dependência nova entre o serviço estar no ar e um segundo host estar de
 * pé (a razão completa está em `LATAM_ITEMS_PATH`, em `src/store/paths.ts`). Este script
 * existe para a cópia não virar uma bifurcação silenciosa — rode depois de uma atualização
 * do cliente do jogo.
 *
 * A origem é o [ragassets](https://github.com/adsonpleal/ragassets), que extrai as tabelas
 * do cliente e as publica em `https://assets.latam-tools.com.br/raw/`. De lá vem um vetor
 * ordenado por id:
 *   { id, name, slots, aegisName, resourceName, description, view, equipSlots, costume }
 * Daqui sai um objeto chaveado por id com só os quatro campos que o serviço lê (veja
 * `LatamItem` em `src/store/rows.ts`). A conversão está em `catalogueFrom`.
 *
 * Uso:
 *   node tools/sync-items.mjs                    # busca de assets.latam-tools.com.br
 *   node tools/sync-items.mjs --input items.json # usa um arquivo local (ragassets ao lado)
 *   node tools/sync-items.mjs --url <url>        # troca a origem
 *   node tools/sync-items.mjs --out <path>       # troca o destino
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_URL = "https://assets.latam-tools.com.br/raw/items.json";
const DEFAULT_OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "latam-items.json",
);

/**
 * Converte a tabela do ragassets no catálogo que o serviço lê.
 *
 * **A ordem de inserção é parte do formato.** O arquivo é escrito com `JSON.stringify`
 * compacto, então a ordem das chaves de cada registro — e a ausência das opcionais — é o
 * que faz duas gerações do mesmo dado saírem byte a byte iguais. Trocar a ordem daqui
 * reescreve 6,6 MB sem mudar dado nenhum, e o `web-deploy` dispara por caminho.
 */
export function catalogueFrom(items) {
  const out = {};
  for (const it of items) {
    // Linhas sem nome identificado não viram item: a busca do mercado é por nome, e um
    // registro sem ele não é achável nem exibível. São milhares de ids que o cliente
    // reserva e não usa.
    if (!it.name) continue;

    const rec = { name: it.name };
    if (it.description) rec.description = it.description;
    // `aegisName` vem do `itemmoveinfov5.txt` do cliente, que não cobre a tabela inteira.
    // Onde ele falta, o nome do recurso é o identificador estável que sobra — e é o que o
    // catálogo sempre trouxe nesses casos.
    const aegis = it.aegisName ?? it.resourceName;
    if (aegis) rec.aegisName = aegis;
    // Zero é ausência de slot, não "zero slots": a chave fica de fora.
    if (it.slots > 0) rec.slots = it.slots;

    out[it.id] = rec;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.out ? resolve(args.out) : DEFAULT_OUT;

  const items = await loadSource(args.input, args.url ?? DEFAULT_URL);
  if (!Array.isArray(items)) {
    console.error("esperava um vetor de itens na origem.");
    process.exit(1);
  }

  const catalogue = catalogueFrom(items);
  const after = Object.keys(catalogue).length;
  // Uma origem sem nome nenhum escreveria um `{}` que sobe e responde um mercado vazio. O
  // deploy só confere que o arquivo não está vazio (`test -s`), e `{}` passa nisso — então
  // a checagem que vale é esta aqui.
  if (after === 0) {
    console.error("nenhum item nomeado na origem; nada foi escrito.");
    process.exit(1);
  }

  const before = existsSync(target) ? Object.keys(readJson(target)).length : 0;
  const json = JSON.stringify(catalogue);
  writeFileSync(target, json);

  console.log(
    `catálogo atualizado: ${before} -> ${after} itens ` +
      `(${(Buffer.byteLength(json) / 1024 / 1024).toFixed(1)} MB)`,
  );
  if (after < before) {
    console.warn(`aviso: o catálogo novo tem ${before - after} itens A MENOS que o anterior.`);
  }
}

/** A tabela: de um arquivo local quando `--input` diz onde, senão da rede. */
async function loadSource(input, url) {
  if (input) {
    const path = resolve(input);
    if (!existsSync(path)) {
      console.error(`tabela de origem não encontrada em ${path}`);
      process.exit(1);
    }
    console.log(`lendo ${path}`);
    return readJson(path);
  }

  console.log(`buscando ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`HTTP ${res.status} em ${url}`);
    process.exit(1);
  }
  return res.json();
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") out.input = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else {
      console.error(
        "uso: node tools/sync-items.mjs [--input <items.json>] [--url <url>] [--out <path>]",
      );
      process.exit(1);
    }
  }
  return out;
}

// Só roda quando chamado direto: o teste importa `catalogueFrom` e não pode disparar uma
// busca na rede por isso.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
