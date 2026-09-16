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
 * foi commitado, e este teste não olha para lá: ele protege contra reintrodução, não contra
 * o que já foi gravado.
 *
 * O que ele procura são as marcas mais características do que mora no outro repositório.
 * Não é um classificador de segredo: é um alarme para quando um deles reaparecer. Se um dia
 * acusar algo legítimo, o certo é reescrever o texto — não afrouxar a lista.
 *
 * **Uma exceção deliberada, desde 2026-09-15.** O site oficial pôs proteção contra robôs na
 * frente do mercado, a coleta do servidor morreu, e a consulta de preço passou a rodar no
 * navegador de quem usa, dentro do próprio site. O leitor do HTML do site
 * (`web/src/lib/market/extract.ts`) é público por decisão — é código que roda no navegador
 * de qualquer um e não teria como ser segredo —, então `__next_f` e o payload RSC deixaram
 * de ser marca de vazamento e saíram da lista. O resto continua proibido: falsificação de
 * navegador (`User-Agent`), detalhes de saída de rede, limites medidos e tudo o mais abaixo.
 *
 * Mora em `tools/` desde que o projeto virou só a interface: é a suíte da raiz, e a única que
 * olha o repositório inteiro como texto.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = fileURLToPath(import.meta.url);
const REPO = resolve(HERE, "..", "..", "..");

/**
 * O que é varrido.
 *
 * `data/` fica fora, e não por preguiça: o catálogo do jogo tem "Warp Portal" e outros
 * nomes de habilidade que casariam com a lista abaixo para sempre. Ele é dado de terceiro,
 * não texto nosso, então não é onde um vazamento nosso apareceria.
 */
const ROOTS = ["web/src", "web/scripts", "web/public", "infra", "tools", ".github"];
const LOOSE_FILES = ["README.md", "CHANGELOG.md", "package.json", ".gitignore", "web/README.md"];

const TEXT = /\.(ts|tsx|js|mjs|json|md|ya?ml|sh|html|css)$|^_headers$/;

/** Diretórios que nunca interessam: nada aqui é código escrito à mão. */
const SKIP = new Set(["node_modules", "dist", "generated"]);

/** Todos os arquivos de texto sob `dir`. Raiz que não existe devolve lista vazia. */
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) walk(resolve(current, entry.name));
      } else if (TEXT.test(entry.name)) {
        out.push(resolve(current, entry.name));
      }
    }
  };
  walk(dir);
  return out;
}

/** As marcas do coletor. Cada uma é específica o bastante para não aparecer por acidente. */
const FORBIDDEN = [
  ["túnel WARP", /\bwgcf\b|\bwarp-cli\b|WARP_|\bwarp=on\b/i],
  ["network namespace", /\bip netns\b|\bnetns\b|NetworkNamespacePath/i],
  ["scripts de lane", /provision-lane|lane-proxy|ro-lane@/],
  ["verificação de IP de saída", /cdn-cgi\/trace|api\.ipify\.org/],
  ["configuração de saída", /EGRESS_LANES|tunnelLanes|reserveDirectForLive/],
  ["navegador falsificado", /Mozilla\/5\.0|AppleWebKit\/|\bUser-Agent\b/i],
  ["projeto irmão privado", /notifymarket/i],
  ["limites medidos do site", /rateLimitDelayMs|latencyDegradeRatio|E_SPECIAL_CHAR/],
];

describe("nada do coletor sobrou aqui", () => {
  /** Lido uma vez, em memória, e reusado por todos os testes abaixo. */
  const sources = [
    ...ROOTS.flatMap((root) => filesUnder(resolve(REPO, root))),
    ...LOOSE_FILES.map((f) => resolve(REPO, f)).filter((f) => existsSync(f)),
  ]
    // Este arquivo lista o que procura, então casaria com tudo.
    .filter((f) => f !== HERE)
    .map((f) => [relative(REPO, f).replace(/\\/g, "/"), readFileSync(f, "utf8").split("\n")]);

  it("achou os arquivos para varrer", () => {
    // Sem isto o teste passaria à toa no dia em que a varredura parasse de achar nada —
    // que é exatamente quando ele deixaria de proteger.
    expect(sources.length).toBeGreaterThan(50);
  });

  for (const [label, pattern] of FORBIDDEN) {
    it(`sem ${label}`, () => {
      const hits = [];
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
    // `existsSync`, não `isDirectory`: um ARQUIVO com o mesmo nome seria a mesma regressão.
    const voltou = ["src/scraper", "src/egress", "data/terms"].filter((p) => existsSync(resolve(REPO, p)));
    expect(voltou).toEqual([]);
  });
});
