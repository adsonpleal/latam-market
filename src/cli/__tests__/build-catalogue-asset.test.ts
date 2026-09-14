/**
 * O asset do catálogo e quem o lê.
 *
 * O servidor indexa as linhas do asset por POSIÇÃO (`store/catalogue.ts`). Uma coluna
 * renomeada ou reordenada aqui sem mexer lá produziria um catálogo silenciosamente
 * embaralhado — nome no lugar do tipo, slot no lugar do id.
 */

import { describe, expect, it } from "vitest";

import { buildCatalogue, CATALOGUE_COLS } from "../build-catalogue-asset.js";
import { catalogueFromAsset } from "../../store/catalogue.js";

describe("asset do catálogo", () => {
  it("declara as colunas na ordem que o leitor espera", () => {
    expect(CATALOGUE_COLS).toEqual(["id", "name", "nameNorm", "slots", "itemType", "equipSlots"]);
  });

  it("emite id crescente, para o hash não mudar por acaso", () => {
    const asset = buildCatalogue({
      "909": { name: "Jellopy" },
      "501": { name: "Poção Vermelha" },
    });
    expect(asset.rows.map((r) => r[0])).toEqual([501, 909]);
  });

  it("o leitor do servidor devolve cada campo no lugar certo", () => {
    const asset = buildCatalogue({
      "2101": { name: "Escudo [1]", description: "Tipo: Escudo" },
      "501": { name: "Poção Vermelha" },
    });
    const { items, byNameNorm } = catalogueFromAsset(asset);
    const escudo = items.get(2101)!;
    expect(escudo.name).toBe("Escudo");
    expect(escudo.nameNorm).toBe("escudo");
    expect(byNameNorm.get("pocao vermelha")).toBe(501);
    expect(Array.isArray(escudo.equipSlots)).toBe(true);
  });
});
