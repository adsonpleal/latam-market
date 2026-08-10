/**
 * Atualiza `data/latam-items.json` a partir do projeto irmão latam-ro-calc.
 *
 * O catálogo é vendorizado em vez de lido de fora porque o servidor sobe como um
 * bundle único no EC2, onde o projeto irmão não existe. Este script existe para a
 * cópia não virar uma bifurcação silenciosa: rode quando o irmão atualizar o dele.
 */

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source =
  process.env.LATAM_ITEMS_SOURCE ??
  resolve(root, "..", "latam-ro-calc", "src", "assets", "demo", "data", "latam-items.json");
const target = resolve(root, "data", "latam-items.json");

if (!existsSync(source)) {
  console.error(`catálogo de origem não encontrado em ${source}`);
  console.error("aponte LATAM_ITEMS_SOURCE para o arquivo se o projeto irmão estiver em outro lugar.");
  process.exit(1);
}

const count = (path) => Object.keys(JSON.parse(readFileSync(path, "utf8"))).length;

const before = existsSync(target) ? count(target) : 0;
copyFileSync(source, target);
const after = count(target);

console.log(
  `catálogo atualizado: ${before} -> ${after} itens ` +
    `(${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`,
);
if (after < before) {
  console.warn(`aviso: o catálogo novo tem ${before - after} itens A MENOS que o anterior.`);
}
