/**
 * Este repositório é público; o coletor não é.
 *
 * A separação não é uma pasta a menos — é um conjunto de decisões sobre como falar com o
 * site que ficou fora daqui de propósito. Isso é o tipo de coisa que volta um commit por
 * vez: uma constante copiada para "só depurar", um comentário explicando por que o
 * cabeçalho é aquele, um caminho de script no README. Nenhum desses passos parece errado
 * sozinho, e é por isso que a garantia precisa ser automática em vez de lembrada.
 *
 * ⚠ **Escopo: a árvore de trabalho, não o histórico.** Um `git log -p` alcança tudo que já
 * foi commitado, e este teste não olha para lá. É por isso que a publicação parte de um
 * histórico novo (um commit só) em vez de apagar arquivos num histórico que já os continha:
 * este teste protege contra reintrodução, não contra o que já foi gravado.
 *
 * O que ele procura são as marcas mais características do que mora no outro repositório.
 * Não é um classificador de segredo: é um alarme para quando um deles reaparecer. Se um dia
 * acusar algo legítimo, o certo é reescrever o texto — não afrouxar a lista.
 */

import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { filesUnder } from "./files.js";

const REPO = resolve(import.meta.dirname, "..", "..");

/**
 * O que é varrido.
 *
 * `data/` fica fora, e não por preguiça: o catálogo do jogo tem "Warp Portal" e outros
 * nomes de habilidade que casariam com a lista abaixo para sempre. Ele é dado de terceiro,
 * não texto nosso, então não é onde um vazamento nosso apareceria.
 */
const ROOTS = ["src", "web/src", "web/scripts", "infra", "tools", ".github"];
const LOOSE_FILES = ["README.md", "CHANGELOG.md", "package.json", "build.mjs", ".gitignore"];

const TEXT = /\.(ts|tsx|js|mjs|json|md|ya?ml|sh|service|caddy|conf|html|css)$/;

/**
 * As marcas do coletor. Cada uma é específica o bastante para não aparecer por acidente
 * num serviço que só lê o próprio banco.
 */
const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ["túnel WARP", /\bwgcf\b|\bwarp-cli\b|WARP_|\bwarp=on\b/i],
  ["network namespace", /\bip netns\b|\bnetns\b|NetworkNamespacePath/i],
  ["scripts de lane", /provision-lane|lane-proxy|ro-lane@/],
  ["verificação de IP de saída", /cdn-cgi\/trace|api\.ipify\.org/],
  ["configuração de saída", /EGRESS_LANES|tunnelLanes|reserveDirectForLive/],
  ["navegador falsificado", /Mozilla\/5\.0|AppleWebKit\/|\bUser-Agent\b/i],
  ["payload RSC do site", /__next_f|text\/x-component|"RSC"|RSC:\s*"1"/],
  ["projeto irmão privado", /notifymarket/i],
  ["limites medidos do site", /rateLimitDelayMs|latencyDegradeRatio|E_SPECIAL_CHAR/],
];

describe("nada do coletor sobrou aqui", () => {
  /**
   * Lido uma vez, em memória, e reusado pelos nove testes.
   *
   * A versão anterior relia os ~130 arquivos por padrão — nove passadas sobre os mesmos
   * 570 KB, que era de longe o arquivo mais lento da suíte.
   */
  const sources: Array<readonly [path: string, lines: string[]]> = [
    ...ROOTS.flatMap((root) => filesUnder(resolve(REPO, root), { match: TEXT })),
    ...LOOSE_FILES.map((f) => resolve(REPO, f)),
  ]
    // Este arquivo lista o que procura, então casaria com tudo.
    .filter((f) => f !== resolve(import.meta.filename))
    .map((f) => [relative(REPO, f).replace(/\\/g, "/"), readFileSync(f, "utf8").split("\n")]);

  it("achou os arquivos para varrer", () => {
    // Sem isto o teste passaria à toa no dia em que a varredura parasse de achar nada —
    // que é exatamente quando ele deixaria de proteger.
    expect(sources.length).toBeGreaterThan(50);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`sem ${label}`, () => {
      const hits: string[] = [];
      for (const [path, lines] of sources) {
        for (const [i, line] of lines.entries()) {
          if (pattern.test(line)) hits.push(`${path}:${i + 1}`);
        }
      }
      // A mensagem lista onde bateu, para não precisar caçar.
      expect(hits).toEqual([]);
    });
  }

  it("nenhum diretório do coletor voltou", () => {
    // `existsSync`, não `isDirectory`: um ARQUIVO chamado `src/scraper` seria a mesma
    // regressão.
    const voltou = ["src/scraper", "src/egress", "data/terms"].filter((p) =>
      existsSync(resolve(REPO, p)),
    );
    expect(voltou).toEqual([]);
  });
});
