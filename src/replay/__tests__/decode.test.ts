/**
 * Os números aqui foram medidos decodificando a fixture na mão antes de existir
 * parser: 34 itens no inventário (chunk 4510), 17 no carrinho (4516), 6 vestidos
 * (4601) e 2 de costume/sombrio (4603). Se um refactor mexer no passo dos registros
 * ou na separação por container, é aqui que aparece.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { decodeReplay } from "../rrf/decode.js";

function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(resolve(import.meta.dirname, "fixtures", name));
  // `Buffer` é uma view sobre um pool compartilhado — sem o slice, o DataView leria
  // bytes de outros arquivos que o Node carregou no mesmo pool.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const replay = decodeReplay(loadFixture("equip-test-2.rrf"));

describe("decodeReplay", () => {
  it("lê o cabeçalho e o personagem", () => {
    expect(new Date(replay.recordedAt * 1000).getFullYear()).toBe(2026);
    expect(replay.character.name).not.toBe("");
    expect(replay.character.accountId).toBeGreaterThan(0);
  });

  it("separa inventário, carrinho e equipamento", () => {
    const { inventory, cart, equipped, equippedCostume } = replay.items;
    expect(inventory).toHaveLength(34);
    expect(cart).toHaveLength(17);
    expect(equipped).toHaveLength(6);
    expect(equippedCostume).toHaveLength(2);
  });

  it("não vaza item do carrinho para o inventário", () => {
    // As duas listas usam posições começando em zero, e os slots 4 e 5 só existem no
    // carrinho. Se a fusão fosse por posição global (como no latam-ro-calc), a
    // Manopla Sombria Média e a Greva Sombria do Fluxo apareceriam na mochila.
    const inventoryIds = new Set(replay.items.inventory.map((r) => r.itemId));
    expect(inventoryIds.has(24076)).toBe(false);
    expect(inventoryIds.has(24111)).toBe(false);
    expect(replay.items.cart.map((r) => r.itemId)).toContain(24076);
  });

  it("lê quantidade, refino e cartas", () => {
    // Insígnia da Cavalaria x3, primeiro slot do carrinho.
    expect(replay.items.cart[0]).toMatchObject({ slot: 0, itemId: 1004, qty: 3 });

    // A mão do personagem: item 1398 refinado +7.
    const weapon = replay.items.equipped.find((r) => r.itemId === 1398);
    expect(weapon).toBeDefined();
    expect(weapon!.refine).toBe(7);

    // Ovo de Abelha-Rainha com uma carta encaixada, na mochila.
    const carded = replay.items.inventory.find((r) => r.itemId === 9193);
    expect(carded!.cards).toEqual([3]);
  });

  it("marca os equipados com a bitmask de local", () => {
    expect(replay.items.equipped.every((r) => r.equipped > 0)).toBe(true);
    expect(replay.items.equippedCostume.map((r) => r.itemId)).toContain(440007);
  });

  it("não confunde slot duplicado dentro do mesmo chunk", () => {
    // O chunk 4601 traz o item 1398 duas vezes (arma de duas mãos ocupa dois locais).
    // Cada slot só pode aparecer uma vez no resultado.
    const slots = replay.items.equipped.map((r) => r.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });
});
