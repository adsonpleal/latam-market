/**
 * A busca no catálogo.
 *
 * Roda sobre o catálogo real, e não sobre meia dúzia de itens montados à mão, porque a
 * ordem de relevância só se prova com a vizinhança de verdade: "Poção Vermelha" disputa
 * com "[Evento] Poção Vermelha", "Poção Vermelha Compacta" e mais uma dezena de nomes.
 */

import { describe, expect, it } from "vitest";

import { countByFilter, countMatches, searchItems as search, type SearchOptions } from "../search.js";
import { FILTER_OPTIONS } from "../taxonomy.js";
import { realItems } from "./realItems.js";

const index = realItems();
const searchItems = (opts: SearchOptions) => search(index, opts);
const ids = (opts: SearchOptions) => searchItems(opts).map((e) => e.itemId);

describe("searchItems", () => {
  it("sem termo e sem filtro não há busca", () => {
    expect(searchItems({ query: "" })).toEqual([]);
    expect(searchItems({ query: "   " })).toEqual([]);
  });

  it("todo item do catálogo é buscável", () => {
    // Conta por fora quantos nomes contêm o termo: a busca tem que achar todos.
    const expected = [...index.values()].filter((i) => i.nameNorm.includes("poring")).length;
    expect(searchItems({ query: "poring" })).toHaveLength(expected);
  });

  it("devolve a entrada inteira do catálogo, com tipo e posição", () => {
    const [first] = searchItems({ query: "4001" });
    expect(first).toBe(index.get(4001));
    expect(first).toMatchObject({ name: "Carta Poring", type: "carta" });
  });

  it("ignora acento e caixa", () => {
    expect(ids({ query: "POCAO VERMELHA" })[0]).toBe(501);
  });

  it("ordena por relevância: nome igual, começa com, contém, e o mais curto ganha", () => {
    const names = searchItems({ query: "poção vermelha" }).map((i) => i.name);

    expect(names[0]).toBe("Poção Vermelha");
    // Começa-com vem antes de qualquer contém, mesmo que o contém tenha nome mais curto.
    const compacta = names.indexOf("Poção Vermelha Compacta");
    const assistente = names.indexOf("Poção Vermelha de Assistente");
    const evento = names.indexOf("[Evento] Poção Vermelha");
    expect(compacta).toBeGreaterThan(0);
    expect(assistente).toBeGreaterThan(compacta);
    expect(evento).toBeGreaterThan(assistente);
  });

  it("id exato vem primeiro, e uma lista de ids mantém a ordem digitada", () => {
    expect(ids({ query: "501" })[0]).toBe(501);
    expect(ids({ query: "909, 502 501" }).slice(0, 3)).toEqual([909, 502, 501]);
  });

  it("id repetido ou inexistente na lista não vira linha", () => {
    const found = ids({ query: "502,502,999999999,501" });
    expect(found.slice(0, 2)).toEqual([502, 501]);
    expect(found.filter((id) => id === 502)).toHaveLength(1);
  });

  it("a ordem é estável: a mesma busca dá a mesma lista", () => {
    expect(ids({ query: "carta" })).toEqual(ids({ query: "carta" }));
  });

  it("com filtro e sem texto, navega em ordem alfabética", () => {
    const katars = searchItems({ query: "", filter: { type: "katar" } });
    expect(katars.length).toBeGreaterThan(10);
    expect(katars.every((i) => i.type === "katar")).toBe(true);
    const names = katars.map((i) => i.nameNorm);
    expect([...names].sort(new Intl.Collator("pt-BR").compare)).toEqual(names);
  });

  it("o filtro vale junto com o texto, e até para um id exato", () => {
    const cartas = searchItems({ query: "poring", filter: { type: "carta" } });
    expect(cartas.map((i) => i.name)).toContain("Carta Poring");
    expect(cartas.every((i) => i.type === "carta")).toBe(true);
    // 501 é Poção Vermelha: pedir uma carta não pode devolvê-la.
    expect(ids({ query: "501", filter: { type: "carta" } })).not.toContain(501);
  });

  it("posição e sem tipo filtram pelo que o build classificou", () => {
    expect(searchItems({ query: "", filter: { slot: "topo" } }).every((i) => i.equipSlots.includes("topo"))).toBe(true);
    const semTipo = searchItems({ query: "poção vermelha", filter: { type: null } });
    expect(semTipo.map((i) => i.itemId)).toContain(501);
    expect(semTipo.every((i) => i.type === null)).toBe(true);
  });
});

describe("countByFilter", () => {
  it("toda opção do seletor conta os itens que ela traria", () => {
    const counts = countByFilter(index, FILTER_OPTIONS);
    expect(counts.get("carta")).toBe(searchItems({ query: "", filter: { type: "carta" } }).length);
    expect(counts.get("sem-tipo")).toBeGreaterThan(5000);
  });
});

describe("countMatches", () => {
  it("conta pelo nome, como a busca por texto", () => {
    expect(countMatches(index, "Zangão")).toBe(searchItems({ query: "zangao" }).length);
  });
});
