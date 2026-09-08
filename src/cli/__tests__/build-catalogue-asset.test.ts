/**
 * O asset do catálogo tem que dizer exatamente o que a tabela `item` dizia.
 *
 * A classificação saiu do boot (`loadCatalogue`, que gravava 13.846 linhas no SQLite) para
 * o build (`buildCatalogue`, que emite o asset). São dois caminhos para a mesma resposta, e
 * é a busca inteira que depende dela: `type` e `equip_slots` são os filtros, `name_norm` é
 * o índice de nome. Uma divergência aqui não quebra nada — só passa a classificar diferente
 * do que já está no banco, em silêncio.
 *
 * Por isso o teste roda os DOIS sobre o catálogo real e compara linha a linha.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { buildCatalogue, CATALOGUE_COLS } from "../build-catalogue-asset.js";
import { LATAM_ITEMS_PATH } from "../../store/paths.js";
import { SCHEMA_SQL } from "../../store/schema.js";
import { loadCatalogue } from "../../store/write.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

describe("asset do catálogo contra loadCatalogue", () => {
  const hasCatalogue = existsSync(LATAM_ITEMS_PATH);

  it.skipIf(!hasCatalogue)("classifica igual ao caminho que gravava no banco", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(LATAM_ITEMS_PATH, "utf8"));
    const asset = buildCatalogue(raw);

    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SCHEMA_SQL);
      const n = loadCatalogue(db, LATAM_ITEMS_PATH);
      expect(asset.rows.length).toBe(n);

      const rows = db
        .prepare(
          `SELECT item_id, name, name_norm, slots, item_type, equip_slots
             FROM item ORDER BY item_id`,
        )
        .all() as Array<Record<string, unknown>>;

      expect(asset.rows).toEqual(
        rows.map((r) => [
          r["item_id"], r["name"], r["name_norm"], r["slots"], r["item_type"], r["equip_slots"],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("declara as colunas na ordem que o hidratador espera", () => {
    // `store/hydrate.ts` indexa por posição; renomear ou reordenar aqui sem mexer lá
    // produziria um catálogo silenciosamente embaralhado.
    expect(CATALOGUE_COLS).toEqual(["id", "name", "nameNorm", "slots", "itemType", "equipSlots"]);
  });

  it("emite id crescente, para o hash não mudar por acaso", () => {
    const asset = buildCatalogue({
      "909": { name: "Jellopy" },
      "501": { name: "Poção Vermelha" },
    });
    expect(asset.rows.map((r) => r[0])).toEqual([501, 909]);
  });
});
