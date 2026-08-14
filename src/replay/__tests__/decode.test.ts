/**
 * Os números aqui foram medidos decodificando a fixture na mão antes de existir
 * parser: 34 itens no inventário (chunk 4510), 17 no carrinho (4516), 6 vestidos
 * (4601) e 2 de costume/sombrio (4603). Se um refactor mexer no passo dos registros
 * ou na separação por container, é aqui que aparece.
 *
 * `storage-test.rrf` é a segunda fixture, gravada abrindo as duas janelas de armazém —
 * é o único replay em mão que tem armazém, e o que prova que eles NÃO estão nos
 * contêineres do arquivo (a lista `unknown` vem vazia mesmo com as janelas abertas).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StorageChangeEvent, StorageItem } from "rrfparser";

import { applyStorageChanges, decodeReplay } from "../decode.js";

function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(resolve(import.meta.dirname, "fixtures", name));
  // `Buffer` é uma view sobre um pool compartilhado — sem o slice, o DataView leria
  // bytes de outros arquivos que o Node carregou no mesmo pool.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const replay = decodeReplay(loadFixture("equip-test-2.rrf"));
const withStorage = decodeReplay(loadFixture("storage-test.rrf"));

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

  it("deixa os armazéns em null quando a janela não foi aberta", () => {
    // Não é "armazém vazio": esta gravação simplesmente não passou no Kafra, e a
    // diferença é o que impede a API de afirmar que o armazém está vazio.
    expect(replay.storage).toBeNull();
    expect(replay.guildStorage).toBeNull();
  });
});

describe("decodeReplay — armazéns", () => {
  it("lê o armazém do Kafra com a ocupação que o servidor informou", () => {
    const storage = withStorage.storage;
    expect(storage).not.toBeNull();
    expect(storage!.items).toHaveLength(35);
    expect(storage!.usedSlots).toBe(35);
    expect(storage!.maxSlots).toBe(300);
    // A janela do Kafra foi a segunda a abrir, ~15 s depois do começo da gravação.
    expect(storage!.openedAtMs).toBe(15069);
  });

  it("lê o armazém do clã separado do do Kafra", () => {
    const guild = withStorage.guildStorage;
    expect(guild).not.toBeNull();
    expect(guild!.items).toHaveLength(2);
    expect(guild!.maxSlots).toBe(200);
    expect(guild!.items.map((r) => r.itemId)).toEqual([578, 12580]);
    // 140 Frutas de Yggdrasil guardadas no clã — a quantidade tem que sobreviver.
    expect(guild!.items.find((r) => r.itemId === 12580)!.qty).toBe(140);
  });

  it("não mistura os dois armazéns", () => {
    const kafra = new Set(withStorage.storage!.items.map((r) => r.itemId));
    // O 12580 está no armazém do clã; se os dois caíssem na mesma lista, apareceria aqui.
    expect(kafra.has(12580)).toBe(false);
    expect(withStorage.storage!.items.map((r) => r.itemId)).toContain(11568);
  });

  it("usa o índice do servidor como slot, sem repetir linha", () => {
    // O índice é a alça do item na listagem: único ali dentro, e é o que identifica a
    // linha quando o mesmo item aparece em duas pilhas.
    const slots = withStorage.storage!.items.map((r) => r.slot);
    expect(new Set(slots).size).toBe(slots.length);
    expect(Math.min(...slots)).toBe(8);
  });

  it("nada em armazém vem marcado como equipado", () => {
    const all = [...withStorage.storage!.items, ...withStorage.guildStorage!.items];
    expect(all.every((r) => r.equipped === 0)).toBe(true);
  });

  it("os armazéns não estão nos contêineres do arquivo", () => {
    // A gravação foi feita com as duas janelas abertas e `unknown` continua vazio. Era a
    // suspeita antiga — de que os chunks 4517/4522 fossem o armazém — e ela morre aqui.
    expect(Object.keys(withStorage.items.unknown)).toHaveLength(0);
    expect(withStorage.items.inventory).toHaveLength(77);
    expect(withStorage.items.cart).toHaveLength(9);
  });
});

/**
 * Nenhum replay em mão movimenta item com a janela aberta, então o merge só se exercita
 * com entrada montada à mão — que é a razão de `applyStorageChanges` ser exportada.
 */
describe("applyStorageChanges", () => {
  const item = (index: number, itemId: number, qty: number): StorageItem => ({
    index,
    itemId,
    qty,
    equipped: 0,
    refine: 0,
    grade: 0,
    cards: [0, 0, 0, 0],
    options: [],
  });

  const change = (
    index: number,
    added: boolean,
    amount: number,
    itemId = 0,
  ): StorageChangeEvent => ({
    time: 0,
    kind: "storage",
    index,
    added,
    itemId,
    amount,
    refine: 0,
    grade: 0,
    cards: [0, 0, 0, 0],
    options: [],
  });

  it("devolve a listagem intacta quando nada se moveu", () => {
    const items = [item(2, 501, 10), item(3, 502, 5)];
    expect(applyStorageChanges(items, [])).toEqual(items);
  });

  it("soma na pilha existente ao depositar", () => {
    const out = applyStorageChanges([item(2, 501, 10)], [change(2, true, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.qty).toBe(15);
  });

  it("cria a linha ao depositar num índice que a listagem não tinha", () => {
    const out = applyStorageChanges([item(2, 501, 10)], [change(9, true, 3, 909)]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.index === 9)).toMatchObject({ itemId: 909, qty: 3 });
  });

  it("subtrai ao retirar e remove a linha quando zera", () => {
    const items = [item(2, 501, 10), item(3, 502, 5)];
    const out = applyStorageChanges(items, [change(2, false, 4), change(3, false, 5)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 2, qty: 6 });
  });

  it("ignora retirada de índice que a listagem não trouxe", () => {
    // A lib resolve o `itemId` como 0 nesse caso; aplicar viraria um item fantasma
    // (ou uma quantidade negativa) na conta.
    const out = applyStorageChanges([item(2, 501, 10)], [change(77, false, 1)]);
    expect(out).toEqual([item(2, 501, 10)]);
  });

  it("aplica os eventos na ordem em que vieram", () => {
    const out = applyStorageChanges(
      [item(2, 501, 10)],
      [change(2, false, 10), change(2, true, 4, 501)],
    );
    // A retirada zera e apaga a linha; o depósito seguinte a recria com 4.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ index: 2, itemId: 501, qty: 4 });
  });

  it("não muta a listagem recebida", () => {
    const items = [item(2, 501, 10)];
    applyStorageChanges(items, [change(2, true, 5)]);
    expect(items[0]!.qty).toBe(10);
  });
});
