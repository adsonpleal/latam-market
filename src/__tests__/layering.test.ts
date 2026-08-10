/**
 * A regra que sustenta a paridade entre os canais: **`api/` e `mcp/` só enxergam
 * `core/`.**
 *
 * O teste de paridade compara duas respostas; ele não vê um import indevido, e de
 * fato não viu — `listSnapshots` foi importado direto de `store/read.js` pelos dois
 * lados e passou despercebido, publicando uma linha do banco como se fosse contrato.
 * Uma asserção sobre o grafo de imports pega isso na hora.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { filesUnder } from "./files.js";

const SRC = resolve(import.meta.dirname, "..");

const TS = /\.tsx?$/;
const tsUnder = (dir: string): string[] => filesUnder(dir, { match: TS });

/** Especificadores de import/export relativos ou de pacote, um por ocorrência. */
function importsIn(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]!);
}

const importsOf = (file: string): string[] => importsIn(readFileSync(file, "utf8"));

describe("camadas", () => {
  const edgeFiles = [...tsUnder(resolve(SRC, "api")), ...tsUnder(resolve(SRC, "mcp"))];

  it("encontrou os arquivos de borda", () => {
    expect(edgeFiles.length).toBeGreaterThan(3);
  });

  it("api/ e mcp/ não alcançam store/, worker/ nem collect/", () => {
    const violations: string[] = [];
    for (const file of edgeFiles) {
      for (const spec of importsOf(file)) {
        if (/^\.\.\/(store|worker|collect)\//.test(spec)) {
          violations.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
        }
      }
    }
    // A mensagem lista o que quebrou, para não precisar caçar.
    expect(violations).toEqual([]);
  });

  /**
   * O coletor entra por uma porta só.
   *
   * `collect/load.ts` é o único lugar que faz o `import()` dinâmico, e `collect/port.ts` é
   * o único vocabulário compartilhado com o outro repositório. Um segundo ponto de entrada
   * — um `import()` conveniente dentro do `core/`, digamos — desfaria a separação sem
   * ninguém notar, porque continuaria compilando.
   */
  it("só collect/ carrega o coletor", () => {
    const violations: string[] = [];

    // `server/config.ts` é onde TODA variável de ambiente é lida, então é a única exceção
    // à regra de que COLLECTOR_PATH é assunto de `collect/`. Este arquivo de teste também,
    // por escrever o nome que procura.
    const mayNameTheEnvVar = ["server/config.ts", "__tests__/layering.test.ts"];

    for (const file of tsUnder(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
      const source = readFileSync(file, "utf8");

      if (
        !rel.startsWith("collect/") &&
        !mayNameTheEnvVar.includes(rel) &&
        source.includes("COLLECTOR_PATH")
      ) {
        violations.push(`${rel} lê COLLECTOR_PATH`);
      }

      // Quem carrega é o worker de coleta, e só ele.
      for (const spec of importsIn(source)) {
        if (/collect\/load\.js$/.test(spec) && !rel.startsWith("worker/")) {
          violations.push(`${rel} -> ${spec}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("core/ não conhece HTTP nem MCP", () => {
    const violations: string[] = [];
    for (const file of tsUnder(resolve(SRC, "core"))) {
      for (const spec of importsOf(file)) {
        if (/^\.\.\/(api|mcp|server)\//.test(spec) || spec.startsWith("node:http")) {
          violations.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  /**
   * `core/servers.ts`, `core/taxonomy.ts` e `core/datasets.ts` são folhas: vocabulário de
   * domínio puro, sem seta para lugar nenhum.
   *
   * Isso não é detalhe de estilo. `store/write.ts` importa `classify` do segundo, e
   * `core/` importa `store/cache` na outra direção — o que só não fecha ciclo porque
   * estes três não olham para trás. Até agora essa garantia era um comentário; aqui
   * ela passa a quebrar o teste no dia em que deixar de valer.
   */
  it("as folhas de core/ não dependem de camada nenhuma", () => {
    const leaves = ["servers.ts", "taxonomy.ts", "datasets.ts"];
    const violations: string[] = [];

    for (const leaf of leaves) {
      for (const spec of importsOf(resolve(SRC, "core", leaf))) {
        if (/^\.\.\/(store|collect|worker|api|mcp|server)\//.test(spec)) {
          violations.push(`core/${leaf} -> ${spec}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * O `web/` compartilha os tipos do backend importando `../src/core/*` — de propósito,
   * porque um arquivo espelho divergiria calado. Só que `core/replay.ts` puxa
   * `node:sqlite`, então um import de VALOR faria o Vite tentar empacotar o módulo do
   * banco. Isso quebraria só no build do deploy; aqui quebra no `pnpm test`.
   */
  it("web/ só alcança o backend por import type", () => {
    const webSrc = resolve(SRC, "..", "web", "src");
    const violations: string[] = [];
    let crossings = 0;

    for (const file of tsUnder(webSrc)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /^[ \t]*(import|export)([ \t]+type)?[ \t][^;]*?["']((?:\.\.\/)+src\/[^"']+)["']/gm,
      )) {
        crossings++;
        if (match[2] === undefined) {
          violations.push(`web/${file.slice(webSrc.length - 3)} -> ${match[3]}`);
        }
      }
    }

    // Sem isto o teste passaria à toa se o padrão parasse de casar — que é exatamente
    // como ele deixaria de proteger o que deveria.
    expect(crossings).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
