import { describe, expect, it } from "vitest";

import { classify, EQUIP_SLOTS, ITEM_CATEGORIES } from "../taxonomy.js";

/**
 * Todos os casos abaixo são strings reais do catálogo LATAM. A fonte é texto escrito à
 * mão, e a classificação errada é pior que a ausente — o filtro esconderia o item certo.
 */
describe("classify", () => {
  it("lê tipo e slot de uma descrição normal", () => {
    const desc = "Um chapéu qualquer.\nTipo: Equip. para Cabeça\nEquipa em: Topo\nPeso: 20";
    expect(classify("Chapéu", desc)).toEqual({ type: "cabeca", slots: ["topo"] });
  });

  it("ignora os códigos de cor do cliente", () => {
    expect(classify("Item", "^0000ffTipo:^000000 Adaga").type).toBe("adaga");
  });

  it("separa uma mão de duas mãos", () => {
    expect(classify("Item", "Tipo: Espada").type).toBe("espada");
    expect(classify("Item", "Tipo: Espada de Duas Mãos").type).toBe("espada2m");
  });

  /** O catálogo traz "Equip. para Cabeуa" com `у` cirílico, idêntico ao ç renderizado. */
  it("aceita as variantes de grafia de equipamento de cabeça", () => {
    for (const raw of [
      "Equip. para Cabeça",
      "Equip. Para Cabeça",
      "Equipamento para Cabeça",
      "Equipamento pra cabeça",
      "Equip. para Cabeуa",
    ]) {
      expect(classify("Item", `Tipo: ${raw}`).type).toBe("cabeca");
    }
  });

  /** Várias linhas vêm com o campo seguinte grudado por falha de quebra na origem. */
  it("descarta o campo grudado no valor", () => {
    expect(classify("Item", "Tipo: Capa DEF: 18").type).toBe("capa");
    expect(classify("Item", "Tipo: Equip. para Cabeça DEF: -7").type).toBe("cabeca");
    expect(classify("Item", "Tipo: Equip. para Cabeça\nEquipa em: Topo Peso: 30").slots).toEqual([
      "topo",
    ]);
  });

  it("expande um slot combinado", () => {
    expect(classify("Item", "Tipo: Visual\nEquipa em: Topo, Meio e Baixo").slots).toEqual([
      "topo",
      "meio",
      "baixo",
    ]);
    expect(classify("Item", "Tipo: Visual\nEquipa em: Meio e Baixo").slots).toEqual(["meio", "baixo"]);
  });

  /**
   * A parte contraintuitiva: armadura, capa, calçado e acessório NUNCA trazem
   * "Equipa em:" — medido em 0% dos 366 acessórios do catálogo. O tipo já é o slot.
   */
  it("deriva o slot do tipo quando a descrição não diz", () => {
    expect(classify("Item", "Tipo: Armadura").slots).toEqual(["armadura"]);
    expect(classify("Item", "Tipo: Acessório").slots).toEqual(["acessorio"]);
    expect(classify("Item", "Tipo: Katar").slots).toEqual(["arma"]);
  });

  /**
   * O sombrio é um tipo só para seis peças diferentes, e 662 dos 707 itens não trazem
   * "Equipa em:". Quem desempata é a primeira palavra do nome — validado contra os 45
   * que declaram o slot, com 100% de concordância e nenhuma contradição.
   */
  describe("equipamento sombrio, pelo nome", () => {
    const cases: [string, string][] = [
      ["Manopla Sombria Média", "arma"],
      ["Malha Sombria do Poder", "armadura"],
      ["Escudo Sombrio de Atena", "escudo"],
      ["Greva Sombria do Fluxo", "calcado"],
      ["Sapato Sombrio", "calcado"],
      ["Brinco Sombrio Ardente", "acessorio"],
      ["Colar Sombrio Ardente", "acessorio"],
      ["Armadura Sombria", "armadura"],
    ];

    for (const [name, slot] of cases) {
      it(`${name} -> ${slot}`, () => {
        expect(classify(name, "Tipo: Equip. Sombrio")).toEqual({
          type: "sombrio",
          slots: [slot],
        });
      });
    }

    it("a descrição ainda manda quando ela existe", () => {
      // Um dos 45 que declaram: o texto ganha do prefixo do nome.
      expect(
        classify("Manopla Sombria", "Tipo: Equip. Sombrio\nEquipa em: Escudo").slots,
      ).toEqual(["escudo"]);
    });

    it("nome fora do padrão fica sem slot em vez de chutar", () => {
      expect(classify("Coisa Sombria", "Tipo: Equip. Sombrio").slots).toEqual([]);
    });
  });
});

describe("catálogo de filtros", () => {
  it("todo id produzido por classify existe no catálogo publicado", () => {
    // O `/taxonomy` é o que a interface usa para montar os seletores. Um id fora dessa
    // lista viraria um filtro impossível de escolher.
    for (const raw of ["Adaga", "Equip. para Cabeça", "Carta", "Visual", "Munição"]) {
      const { type } = classify("Item", `Tipo: ${raw}`);
      expect(type).not.toBeNull();
      expect(ITEM_CATEGORIES.some((c) => c.id === type)).toBe(true);
    }
    for (const slot of classify("Item", "Tipo: Visual\nEquipa em: Topo e Meio").slots) {
      expect(EQUIP_SLOTS.some((s) => s.id === slot)).toBe(true);
    }
  });

  it("não tem id repetido", () => {
    expect(new Set(ITEM_CATEGORIES.map((c) => c.id)).size).toBe(ITEM_CATEGORIES.length);
    expect(new Set(EQUIP_SLOTS.map((s) => s.id)).size).toBe(EQUIP_SLOTS.length);
  });
});
