/**
 * O replay na forma da tela: containers nomeados, sem preço.
 *
 * O parser tem teste próprio (`decode.test.ts`, ao lado) com as contagens medidas
 * à mão. Aqui o que se prova é a tradução para o contrato que a interface importa — que
 * cada container chega, que um id desconhecido não some, e que nenhum resto do tempo em que
 * o replay era avaliado em zeny ficou para trás.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { indexItems } from "../../catalogue/catalogue.js";
import { realItems } from "../../catalogue/__tests__/realItems.js";
import { readReplay, type InventoryItem, type ReplayInventory } from "../inventory.js";

function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(resolve(import.meta.dirname, "fixtures", name));
  // `Buffer` é uma view sobre um pool compartilhado — sem o slice, o parser leria bytes de
  // outros arquivos que o Node carregou no mesmo pool.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const allItems = (r: ReplayInventory): InventoryItem[] => [
  ...r.inventory.items,
  ...r.cart.items,
  ...r.equipped.items,
  ...(r.storage?.items ?? []),
  ...(r.guildStorage?.items ?? []),
  ...Object.values(r.unidentified).flat(),
];

let equip: ReplayInventory;
let withStorage: ReplayInventory;

beforeAll(() => {
  equip = readReplay(loadFixture("equip-test-2.rrf"), realItems());
  withStorage = readReplay(loadFixture("storage-test.rrf"), realItems());
});

describe("readReplay", () => {
  it("traz personagem e os containers — os mesmos números do decode", () => {
    expect(equip.character.name).not.toBe("");
    expect(Object.keys(equip.character).sort()).toEqual(["baseLevel", "jobLevel", "map", "name"]);
    expect(equip.inventory.items).toHaveLength(34);
    expect(equip.cart.items).toHaveLength(17);
    // Vestido e costume/sombrio juntos: 6 + 2.
    expect(equip.equipped.items).toHaveLength(8);
  });

  it("armazém não aberto é null, aberto vem com a ocupação", () => {
    expect(equip.storage).toBeNull();
    expect(equip.guildStorage).toBeNull();

    expect(withStorage.storage).not.toBeNull();
    expect(withStorage.guildStorage).not.toBeNull();
    for (const s of [withStorage.storage!, withStorage.guildStorage!]) {
      expect(Array.isArray(s.items)).toBe(true);
      expect(typeof s.usedSlots).toBe("number");
      expect(typeof s.maxSlots).toBe("number");
      expect(typeof s.openedAtMs).toBe("number");
    }
  });

  it("nomeia os itens pelo catálogo", () => {
    const named = allItems(equip).filter((i) => !i.item.name.startsWith("Item desconhecido"));
    expect(named.length).toBeGreaterThan(0);
    for (const i of equip.inventory.items) {
      expect(i.cardNames).toHaveLength(i.cards.length);
    }
  });

  it("ordena cada container por pilha e depois nome", () => {
    for (const { items } of [equip.inventory, equip.cart, equip.equipped]) {
      for (let k = 1; k < items.length; k++) {
        const [a, b] = [items[k - 1]!, items[k]!];
        const ok =
          a.qty > b.qty || (a.qty === b.qty && a.item.name.localeCompare(b.item.name, "pt-BR") <= 0);
        expect(ok, `${a.item.name} (${a.qty}) antes de ${b.item.name} (${b.qty})`).toBe(true);
      }
    }
  });

  it("não tem campo de preço em lugar nenhum", () => {
    const body = JSON.stringify([equip, withStorage]);
    for (const key of [
      "unitPrice",
      "unitMedian",
      "total",
      "totalValue",
      "value",
      "unpriced",
      "stores",
      "units",
      "market",
      "priceCaveat",
      "freshness",
      "sellCandidates",
      "inMarket",
    ]) {
      expect(body).not.toContain(`"${key}":`);
    }
    for (const note of [...equip.notes, ...withStorage.notes]) {
      expect(note).not.toMatch(/preço|total|zeny|valor/i);
    }
  });

  it("as notas dizem o que nenhum campo diz", () => {
    expect(equip.notes.some((n) => n.includes("início da gravação"))).toBe(true);
    expect(equip.notes.some((n) => n.includes("não é o mesmo que estar vazio"))).toBe(true);
    expect(withStorage.notes.some((n) => n.includes("janela foi aberta"))).toBe(true);
  });

  it("id fora do catálogo vira item desconhecido, sem sumir", () => {
    const first = equip.inventory.items[0]!;
    const id = first.item.itemId;

    // O mesmo catálogo, sem aquele id.
    const without = indexItems(
      [...realItems().values()].filter((i) => i.itemId !== id).map((i) => [i.itemId, i.name, i.slots] as const),
    );

    const again = readReplay(loadFixture("equip-test-2.rrf"), without);
    const unknown = allItems(again).filter((i) => i.item.itemId === id);
    expect(unknown.length).toBeGreaterThan(0);
    for (const i of unknown) {
      expect(i.item).toEqual({ itemId: id, name: `Item desconhecido #${id}`, slots: null });
    }
    expect(allItems(again)).toHaveLength(allItems(equip).length);
  });
});
