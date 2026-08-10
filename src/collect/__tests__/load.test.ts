/**
 * O carregamento do coletor degrada em vez de estourar.
 *
 * É o comportamento que sustenta "sem coletor o serviço ainda serve o histórico", e ele só
 * aparece em produção quando algo já deu errado — exatamente quando ninguém quer descobrir
 * que a degradação também estava quebrada. Os três modos de falha aqui já aconteceram de
 * verdade: caminho absoluto do Windows recusado pelo `import()`, módulo carregado sem o
 * export esperado, e `createCollector()` estourando na largada.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { loadCollector } from "../load.js";

const dir = mkdtempSync(resolve(tmpdir(), "collector-load-"));

/** Escreve um módulo ESM no disco e devolve o caminho absoluto. */
function moduleWith(name: string, source: string): string {
  const file = resolve(dir, name);
  writeFileSync(file, source, "utf8");
  return file;
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadCollector", () => {
  it("sem caminho configurado, devolve null sem reclamar", async () => {
    expect(await loadCollector("")).toBeNull();
  });

  it("carrega um módulo por caminho absoluto", async () => {
    // O caso que quebrava no Windows: `C:/…` lido como URL de protocolo "c:".
    const path = moduleWith(
      "bom.mjs",
      `export async function createCollector() {
         return { crawl: async () => ({ planned: 0, failures: 0 }), close: async () => {} };
       }`,
    );

    const collector = await loadCollector(path);
    expect(collector).not.toBeNull();
    expect(typeof collector!.crawl).toBe("function");
    expect(typeof collector!.close).toBe("function");
  });

  it("um módulo que não existe degrada para null", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadCollector(resolve(dir, "nao-existe.mjs"))).toBeNull();
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("um módulo sem createCollector degrada para null", async () => {
    const path = moduleWith("vazio.mjs", `export const nada = 1;`);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await loadCollector(path)).toBeNull();
    // A mensagem tem que dizer QUAL é o problema: uma instalação incompleta e um arquivo
    // ausente pedem ações diferentes.
    expect(quiet.mock.calls.flat().join(" ")).toContain("createCollector");
    quiet.mockRestore();
  });

  it("createCollector() que estoura degrada para null", async () => {
    const path = moduleWith(
      "explode.mjs",
      `export async function createCollector() { throw new Error("sem túnel"); }`,
    );
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await loadCollector(path)).toBeNull();
    expect(quiet.mock.calls.flat().join(" ")).toContain("sem túnel");
    quiet.mockRestore();
  });
});
