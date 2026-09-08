/**
 * A fronteira entre `core/` e o banco.
 *
 * Existe porque `core/` importava `type { DatabaseSync } from "node:sqlite"` — um tipo do
 * Node num lugar que não pode conhecer runtime nenhum. Enquanto o servidor era um processo
 * Node isso era só feio; com o Worker no meio, é o que impediria `core/` de rodar nos dois.
 *
 * A forma é a do D1 reduzida ao que se usa de verdade: consulta com parâmetros
 * posicionais, sempre assíncrona. Quem tem SQLite síncrono do outro lado (`store/sqlite.ts`,
 * usado pelo shipper e pelos testes de unidade) devolve promessa já resolvida — o custo é
 * um microtask, e em troca `core/` tem uma assinatura só.
 *
 * Deliberadamente NÃO expõe `prepare()`: statements preparados são a otimização que faz
 * sentido num processo longo e nenhum sentido num isolate que morre. Guardar um por
 * conexão aqui só reproduziria o `preparedFor` de `write.ts` num lugar pior.
 */

/** O que dá para vincular numa consulta. É o denominador comum entre D1 e node:sqlite. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Uma consulta e seus parâmetros, para os caminhos que mandam várias de uma vez. */
export interface SqlStatement {
  sql: string;
  params?: readonly SqlParam[];
}

export interface Db {
  /** Todas as linhas. Vazio quando não há nenhuma — nunca `null`. */
  all<T>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  /** A primeira linha, ou `null`. */
  first<T>(sql: string, ...params: SqlParam[]): Promise<T | null>;
}

export interface WritableDb extends Db {
  /** Uma escrita solta. Devolve quantas linhas mudaram. */
  run(sql: string, ...params: SqlParam[]): Promise<number>;
  /**
   * Várias escritas como UMA transação.
   *
   * É o `transact()` do SQLite com outro nome: no D1 o `batch` é atômico e faz rollback
   * inteiro se qualquer statement falhar, que é a garantia de que a ingestão depende para
   * nunca publicar um snapshot pela metade.
   */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}
