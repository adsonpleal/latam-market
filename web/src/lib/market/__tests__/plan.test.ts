/**
 * O agrupamento das consultas.
 *
 * Sobre o catálogo real: se um termo agrupa ou não depende de quantos itens do jogo casam com
 * ele, e isso só se prova com a vizinhança de verdade.
 */

import { describe, expect, it } from "vitest";

import { realItems } from "../../catalogue/__tests__/realItems.js";
import { normalizeName } from "../../catalogue/normalize.js";
import { MAX_GROUP_CATALOGUE_HITS, planQueries } from "../plan.js";

const index = realItems();

const idOf = (name: string): number => {
  for (const e of index.values()) if (e.name === name) return e.itemId;
  throw new Error(`item não achado: ${name}`);
};

const hits = (term: string): number =>
  [...index.values()].filter((e) => e.nameNorm.includes(normalizeName(term))).length;

describe("planQueries", () => {
  it("agrupa itens que dividem um termo raro numa requisição só", () => {
    const ids = ["Carta Zangão", "Carta Zangão Gigante", "Carta Zangão Selvagem"].map(idOf);
    const { jobs } = planQueries(ids, index);
    expect(jobs).toHaveLength(1);
    expect(new Set(jobs[0]!.itemIds)).toEqual(new Set(ids));
    // E o termo escolhido de fato casa com os três nomes.
    for (const id of ids) {
      expect(index.get(id)!.name.toLowerCase()).toContain(jobs[0]!.term.toLowerCase());
    }
  });

  it("não agrupa por termo que traria meio catálogo", () => {
    const ids = ["Carta Poring", "Carta Zangão"].map(idOf);
    const { jobs } = planQueries(ids, index);
    expect(hits("Carta")).toBeGreaterThan(MAX_GROUP_CATALOGUE_HITS);
    expect(jobs).toHaveLength(2);
  });

  it("todo termo de grupo respeita o teto do catálogo", () => {
    const ids = [...index.values()].filter((e) => e.type === "carta").slice(0, 150).map((e) => e.itemId);
    const { jobs } = planQueries(ids, index);
    for (const job of jobs.filter((j) => j.itemIds.length > 1)) {
      expect(hits(job.term), job.term).toBeLessThanOrEqual(MAX_GROUP_CATALOGUE_HITS);
    }
    // Nenhum item some e nenhum aparece duas vezes.
    const covered = jobs.flatMap((j) => j.itemIds);
    expect(new Set(covered).size).toBe(covered.length);
    expect(new Set(covered)).toEqual(new Set(ids));
  });

  it("economiza requisições numa lista de verdade", () => {
    // Um conjunto de cartas de um mesmo mapa costuma dividir nome de monstro.
    const ids = [...index.values()]
      .filter((e) => /^Carta (Zangão|Orc|Esqueleto|Lobo)/.test(e.name))
      .map((e) => e.itemId);
    expect(ids.length).toBeGreaterThan(6);
    expect(planQueries(ids, index).jobs.length).toBeLessThan(ids.length);
  });

  it("quem veio cortado antes vai sozinho, pelo próprio nome", () => {
    const ids = ["Carta Zangão", "Carta Zangão Gigante"].map(idOf);
    const { jobs } = planQueries(ids, index, new Set([ids[0]!]));
    expect(jobs).toContainEqual({ term: "Carta Zangão", itemIds: [ids[0]] });
    expect(jobs).toHaveLength(2);
  });

  it("id fora do catálogo não vira requisição", () => {
    const plan = planQueries([999_999_999, idOf("Carta Poring")], index);
    expect(plan.unsearchable).toEqual([999_999_999]);
    expect(plan.jobs).toHaveLength(1);
  });

  it("id repetido na entrada não duplica consulta", () => {
    const id = idOf("Carta Poring");
    expect(planQueries([id, id], index).jobs).toEqual([{ term: "Carta Poring", itemIds: [id] }]);
  });
});
