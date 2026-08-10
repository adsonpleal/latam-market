/**
 * A porta do coletor: o que este serviço precisa de quem fala com o site.
 *
 * Quem coleta é um componente à parte, carregado em tempo de execução (ver `load.ts`).
 * Este arquivo é a única coisa que os dois lados compartilham, e de propósito não tem
 * dependência de execução nenhuma: nada de URL, cabeçalho, limite medido ou saída de rede.
 * Tudo isso é problema de quem implementa.
 *
 * A divisão de responsabilidade que a interface desenha:
 *
 *  - o coletor sabe COMO buscar — que endereço, em que ordem, com que paciência;
 *  - este serviço sabe O QUE FAZER COM O RESULTADO — snapshot, transação, rollup, cache.
 *
 * `onRows` existe por causa da segunda metade: as linhas chegam em lotes e são gravadas
 * conforme chegam, cada lote na sua própria transação curta. Devolver tudo num array no
 * final seria uma coleta inteira (~20 mil linhas) viva na memória e um único lote de
 * escrita segurando o write lock — a API pararia de ler no meio da coleta.
 */

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { Row } from "../store/rows.js";

export interface CrawlRequest {
  dataset: Dataset;
  server: Server;
  /**
   * Chamado conforme as linhas chegam, para quem pediu gravá-las incrementalmente.
   *
   * **Em lotes, não linha por linha.** Cada chamada custa uma transação no SQLite, então
   * um lote por linha troca ~150 transações por ~20 mil. O tamanho natural é a unidade de
   * busca do coletor (hoje, uma página de até 1000 linhas).
   *
   * **Não lança.** Quem implementa chama isto de dentro do próprio laço, onde uma exceção
   * viraria "esta unidade falhou" — classificando um erro de banco como erro de coleta.
   * Quem grava é responsável por capturar o próprio erro e decidir o que fazer com ele.
   */
  onRows: (rows: Row[]) => void;
}

export interface CrawlReport {
  /** Quantas unidades de trabalho o coletor planejou. */
  planned: number;
  /** Quantas delas falharam. Quem chamou decide se a coleta ainda vale. */
  failures: number;
}

export interface Collector {
  crawl(req: CrawlRequest): Promise<CrawlReport>;
  /** Libera o que o coletor tenha aberto (conexões, túneis, processos). */
  close(): Promise<void>;
}

/** O formato do módulo que `COLLECTOR_PATH` tem que exportar. */
export interface CollectorModule {
  createCollector(): Promise<Collector>;
}
