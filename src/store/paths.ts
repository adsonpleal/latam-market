/**
 * Onde ficam os arquivos de dados.
 *
 * Nasceram na configuração do coletor, junto das constantes de raspagem, porque na época
 * era ele quem escrevia tudo. Não são assunto dele: o banco resolve `DB_PATH` a partir
 * daqui, o boot carrega o catálogo daqui, e o coletor virou um componente à parte com a
 * sua própria raiz. As pastas que só ele usa (termos, checkpoints, calibração) ficaram com
 * ele.
 */

import { resolve } from "node:path";

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";

/**
 * Onde ficam os dados. Em produção vem da unit do systemd, já absoluto.
 *
 * O padrão é relativo ao diretório de trabalho, e não à localização deste módulo, porque a
 * segunda opção depende de quantos níveis o arquivo está abaixo da raiz — o que muda entre
 * rodar por `tsx src/...` e rodar o bundle em `dist/`. A versão anterior contava os níveis
 * do código-fonte e errava no bundle, e ninguém notava porque em produção `DATA_DIR` está
 * sempre definido. `pnpm dev` e `node dist/server.mjs` rodam da raiz do projeto.
 */
export const DATA_DIR = resolve(process.env["DATA_DIR"] ?? "data");

/**
 * Catálogo de itens em pt-BR, extraído do cliente do jogo pelo ragassets.
 *
 * Vive em `data/` em vez de ser buscado na rede: o servidor sobe como um bundle único no
 * EC2 e carrega o catálogo antes de escutar. Atualize com `pnpm sync:items`.
 */
export const LATAM_ITEMS_PATH = resolve(DATA_DIR, "latam-items.json");

/**
 * Onde `pnpm import` procura os NDJSON de backfill, um diretório por run.
 *
 * Não é exportado de propósito: `ndjsonPath` é a única forma de nomear esses arquivos, e
 * expor a pasta seria convidar um segundo lugar a montar `${dataset}.${server}.ndjson` à
 * mão — exatamente a divergência que a função existe para evitar.
 */
const RAW_DIR = resolve(DATA_DIR, "raw");

/**
 * Nome do NDJSON de um (run, dataset, servidor).
 *
 * A convenção é combinada com quem escreve esses arquivos — o coletor, que tem a sua
 * própria cópia desta linha. Mudar aqui sem mudar lá faz o import não achar nada.
 */
export function ndjsonPath(runId: string, dataset: Dataset, server: Server): string {
  return resolve(RAW_DIR, runId, `${dataset}.${server.toLowerCase()}.ndjson`);
}
