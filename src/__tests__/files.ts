/**
 * Varredura de arquivos, compartilhada pelos testes que olham o repositório como texto.
 *
 * Existe porque `layering` e `no-leaks` precisam da mesma caminhada e as duas cópias já
 * tinham divergido: uma tolerava raiz inexistente e pulava `node_modules`, a outra não.
 * Como as duas dependem de ler TUDO para valer alguma coisa, uma diferença de cobertura
 * entre elas não quebra nada — só faz um dos testes deixar de olhar, em silêncio.
 *
 * Não é um `.test.ts`: o `vitest.config.ts` coleta só `*.{test,spec}.ts`, então este
 * arquivo é um módulo comum ao lado deles.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Diretórios que nunca interessam: nada aqui é código escrito à mão. */
const SKIP = new Set(["node_modules", "dist", "generated"]);

export interface WalkOptions {
  /** Só devolve arquivos cujo nome casa. */
  match: RegExp;
  /** Diretórios a pular, além dos padrões. */
  skip?: Iterable<string>;
}

/**
 * Todos os arquivos sob `dir` que casam com `match`, recursivamente.
 *
 * Uma raiz que não existe devolve lista vazia em vez de estourar — a lista de raízes é
 * mantida à mão e um diretório removido não é falha do teste. Quem chama é que garante
 * cobertura, com um piso sobre a contagem.
 */
export function filesUnder(dir: string, opts: WalkOptions): string[] {
  const skip = new Set([...SKIP, ...(opts.skip ?? [])]);
  const out: string[] = [];

  const walk = (current: string): void => {
    let entries;
    try {
      // `withFileTypes` evita um `statSync` por entrada: o tipo vem do próprio readdir.
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(resolve(current, entry.name));
      } else if (opts.match.test(entry.name)) {
        out.push(resolve(current, entry.name));
      }
    }
  };

  walk(dir);
  return out;
}
