/**
 * A conversão da tabela do ragassets para `data/latam-items.json`.
 *
 * O catálogo é vendorizado: quem o gera é `sync-items.mjs`, e o arquivo entra no
 * repositório e no tar do deploy. Um erro na conversão, portanto, não aparece na hora —
 * aparece no dia em que alguém rodar o sync, e como o arquivo tem 6,6 MB, a revisão do
 * diff não é onde ele vai ser pego.
 *
 * O que este teste fixa é o **formato**, e por isso compara também o JSON serializado: a
 * ordem das chaves e a ausência das opcionais são o que faz duas gerações do mesmo dado
 * saírem idênticas. Uma reordenação inocente reescreveria o arquivo inteiro sem mudar dado
 * nenhum — e dispararia o deploy da interface, que observa este caminho.
 *
 * Importar o módulo não pode ir à rede: ele só busca quando é executado direto.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { catalogueFrom } from "../sync-items.mjs";

const raw = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "raw-items.json"), "utf8"),
);

describe("catalogueFrom", () => {
  const catalogue = catalogueFrom(raw);

  it("chaveia por id e pula as linhas sem nome", () => {
    // 3000 tem aegisName, descrição e slots — e mesmo assim fica de fora, porque sem nome
    // não há o que buscar nem o que exibir.
    expect(Object.keys(catalogue)).toEqual(["501", "1101", "2199", "4001"]);
  });

  it("omite `slots` quando é zero", () => {
    expect(catalogue["1101"].slots).toBe(3);
    expect(catalogue["501"]).not.toHaveProperty("slots");
  });

  it("omite `description` quando vem vazia", () => {
    expect(catalogue["2199"]).not.toHaveProperty("description");
    expect(catalogue["501"].description).toBe("Poção feita de ervas vermelhas.");
  });

  it("cai para `resourceName` quando o cliente não dá `aegisName`", () => {
    expect(catalogue["1101"].aegisName).toBe("Sword");
    expect(catalogue["501"].aegisName).toBe("빨간포션");
    // Sem nenhum dos dois a chave some, em vez de virar `null` — é o que o resto do
    // código espera de `aegisName` opcional (veja `LatamItem`, em `src/store/rows.ts`).
    expect(catalogue["4001"]).not.toHaveProperty("aegisName");
  });

  it("serializa na ordem que o arquivo versionado tem", () => {
    expect(JSON.stringify(catalogue)).toBe(
      '{"501":{"name":"Poção Vermelha","description":"Poção feita de ervas vermelhas.",' +
        '"aegisName":"빨간포션"},' +
        '"1101":{"name":"Espada","description":"Uma espada comum.","aegisName":"Sword","slots":3},' +
        '"2199":{"name":"Escudo sem Descrição","aegisName":"Shield_Blank"},' +
        '"4001":{"name":"Carta sem Aegis","description":"Nem itemmoveinfo nem recurso nomeiam esta."}}',
    );
  });
});
