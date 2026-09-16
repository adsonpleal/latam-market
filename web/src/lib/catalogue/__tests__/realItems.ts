/**
 * O catálogo real, para os testes que precisam de nome de item de verdade.
 *
 * O `pretest` roda `scripts/build-catalogue.mjs`, que gera o asset em `public/generated/` e a
 * URL com hash em `src/generated/catalogue.ts` — o mesmo par que a página baixa. Os testes
 * leem por aqui em vez de montar um catálogo à mão para que uma regressão no formato do asset
 * apareça também neles.
 *
 * Não é um `.test.ts`: o vitest coleta só arquivos de teste, e este é um módulo comum.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ITEMS_URL } from "../../../generated/catalogue.js";
import { indexItems, type ItemIndex, type ItemRows } from "../catalogue.js";

const PUBLIC = resolve(import.meta.dirname, "..", "..", "..", "..", "public");

let cached: ItemIndex | null = null;

/** Lido uma vez por arquivo de teste: são centenas de KB de JSON. */
export function realItems(): ItemIndex {
  cached ??= indexItems(JSON.parse(readFileSync(resolve(PUBLIC, `.${ITEMS_URL}`), "utf8")) as ItemRows);
  return cached;
}
