/**
 * Gera o catálogo que o Worker hidrata em memória.
 *
 * No EC2 o catálogo entrava no processo por `loadCatalogue`, que lia os 6,3 MB de
 * `data/latam-items.json` e gravava 13.846 linhas em `item`. No Worker não há disco nem
 * boot longo, e ler o catálogo do D1 a cada isolate seria varrer 13.846 linhas para
 * responder qualquer busca — em rows read, o caminho mais caro que existe.
 *
 * Então ele vira asset estático: requisição de asset é grátis e ilimitada, a Cloudflare já
 * comprime e faz cache hierárquico, e o conteúdo só muda quando o catálogo muda, que é
 * quando há deploy. Um isolate paga o download uma vez e serve o resto da vida dele.
 *
 * O formato é colunar (`cols` + `rows`) e não uma lista de objetos: com 13.846 entradas,
 * repetir as seis chaves em cada uma custa mais que o dado. Medido no rodapé desta saída.
 *
 * A classificação roda AQUI, no build, chamando o mesmo `classify` que o `loadCatalogue`
 * chamava — por isso este script é TypeScript em `src/cli/` e não um `.mjs` em `tools/`.
 * Uma cópia das regras em JS ao lado seria a mesma armadilha que `util/stats.ts` existe
 * para evitar: duas definições que combinam até alguém corrigir uma só.
 *
 * Sai em `web/dist/generated/`, DEPOIS do `vite build` (que limpa o `dist`), e não em
 * `web/public/generated/`, porque o `build-catalogue.mjs` apaga de lá tudo que não é dele.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { TAXONOMY_VERSION, classify } from "../core/taxonomy.js";
import { normalizeName, stripSlotSuffix } from "../util/text.js";

interface LatamEntry {
  name: string;
  description?: string;
  aegisName?: string;
  slots?: number;
}

/** A ordem das colunas é o contrato com `store/hydrate.ts`. Mudou aqui, muda lá. */
export const CATALOGUE_COLS = ["id", "name", "nameNorm", "slots", "itemType", "equipSlots"] as const;

export interface CatalogueAsset {
  v: 1;
  /** Versão da taxonomia que classificou estas linhas (ver `core/taxonomy.ts`). */
  tax: number;
  cols: typeof CATALOGUE_COLS;
  rows: Array<[number, string, string, number | null, string | null, string | null]>;
}

export function buildCatalogue(raw: Record<string, LatamEntry>): CatalogueAsset {
  const rows: CatalogueAsset["rows"] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const itemId = Number(id);
    if (!Number.isFinite(itemId)) continue;
    const name = stripSlotSuffix(entry.name);
    // `null` no lugar do `db_type`, igual ao `loadCatalogue`: o tipo cru só existe depois
    // de o item aparecer numa coleta, e a queda para ele acontece na leitura.
    const { type, slots } = classify(name, entry.description, null);
    rows.push([
      itemId,
      name,
      normalizeName(name),
      entry.slots ?? null,
      type,
      slots.length > 0 ? slots.join(",") : null,
    ]);
  }
  // Id crescente: a ordem de `Object.entries` sobre chaves numéricas já é essa, mas
  // depender disso deixaria o asset mudando de hash por acaso.
  rows.sort((a, b) => a[0] - b[0]);
  return { v: 1, tax: TAXONOMY_VERSION, cols: CATALOGUE_COLS, rows };
}

// Só roda quando chamado direto, para o teste poder importar `buildCatalogue`.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..", "..");
  const source = resolve(root, "data", "latam-items.json");
  const outDir = resolve(root, "web", "dist", "generated");
  const genDir = resolve(root, "src", "generated");

  const asset = buildCatalogue(JSON.parse(readFileSync(source, "utf8")) as Record<string, LatamEntry>);
  const json = JSON.stringify(asset);
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 8);
  const file = `catalogue.${hash}.json`;

  mkdirSync(outDir, { recursive: true });
  // O nome carrega o hash, então uma execução anterior com catálogo diferente ficaria
  // para trás e subiria no deploy para sempre.
  for (const stale of readdirSync(outDir)) {
    if (stale.startsWith("catalogue.") && stale !== file) rmSync(join(outDir, stale), { force: true });
  }
  writeFileSync(join(outDir, file), json, "utf8");

  mkdirSync(genDir, { recursive: true });
  writeFileSync(
    join(genDir, "catalogue.ts"),
    "// GERADO por src/cli/build-catalogue-asset.ts — não edite à mão.\n" +
      `export const CATALOGUE_URL = ${JSON.stringify(`/generated/${file}`)};\n`,
    "utf8",
  );

  const verbose = JSON.stringify(
    asset.rows.map((r) => Object.fromEntries(CATALOGUE_COLS.map((c, i) => [c, r[i]]))),
  ).length;
  console.log(
    `catálogo do Worker: ${asset.rows.length} itens, ${(json.length / 1024).toFixed(0)} KB ` +
      `(colunar; como lista de objetos seriam ${(verbose / 1024).toFixed(0)} KB) -> ${file}`,
  );
}
