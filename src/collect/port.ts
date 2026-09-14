/**
 * A porta do coletor: o que este serviço precisa de quem fala com o site.
 *
 * Quem coleta é um componente à parte, carregado em tempo de execução (ver `load.ts`).
 * Este arquivo é a única coisa que os dois lados compartilham, e de propósito não tem
 * dependência de execução nenhuma: nada de URL, cabeçalho, limite medido ou saída de rede.
 * Tudo isso é problema de quem implementa. **Cópia espelhada de `src/port.ts` no
 * repositório do coletor** — mexer num lado sem o outro quebra a coleta no deploy seguinte.
 *
 * A divisão de responsabilidade que a interface desenha:
 *
 *  - o coletor sabe COMO buscar — que endereço, em que ordem, com que paciência, e quando
 *    um item já foi visto por inteiro;
 *  - este serviço sabe O QUE FAZER COM O RESULTADO — snapshot, transação, rollup, cache.
 */

import type { Dataset } from "../core/datasets.js";
import type { Server } from "../core/servers.js";
import type { Row } from "../store/rows.js";

/** Um item com anúncio conhecido pelo serviço, e o nome com que o site o mostrou. */
export interface KnownItem {
  itemId: number;
  /**
   * O nome como o SITE o escreve (o que a coleta anterior viu, sem sufixo de slot), não o
   * do catálogo: é contra ele que a busca casa, e uma tradução diferente no catálogo faria
   * o coletor concluir "nenhum termo contido no nome o devolveu" de um item à venda.
   */
  name: string;
}

/** Um item decidido: todos os anúncios dele nesta coleta. */
export interface ItemBatch {
  itemId: number;
  /**
   * Os anúncios (`trading`, únicos por `ssi`) ou o agregado (`market-price`, uma linha).
   * **Vazio** = item conhecido confirmado sem anúncio: remover.
   */
  rows: Row[];
}

export interface CrawlRequest {
  dataset: Dataset;
  server: Server;
  /**
   * Chamado conforme itens ficam COMPLETOS durante a coleta, e não no fim dela.
   *
   * Um item está completo quando um termo de busca contido no nome dele terminou de ser
   * varrido: a busca casa substring, então aquele termo trouxe todos os anúncios do item.
   * Termos que falharam seguram só os itens deles — o resto sai.
   *
   * **Um item pode vir mais de uma vez** na mesma coleta (um anúncio novo apareceu no meio,
   * outro termo trouxe o que tinha mudado de página). Cada entrega SUBSTITUI a anterior.
   *
   * **Em lotes.** Uma chamada por página atendida, com os itens que ela completou.
   *
   * **Não lança.** Quem implementa chama isto de dentro do próprio laço, onde uma exceção
   * viraria "esta unidade falhou". Quem grava captura o próprio erro.
   */
  onItems: (batches: ItemBatch[]) => void;
  /**
   * `trading`: os itens hoje à venda. É o que permite confirmar que um item SAIU — um item
   * que ninguém devolve só é removido se um termo contido no nome dele completou. Sem a
   * lista, nada é removido.
   */
  known?: readonly KnownItem[];
  /**
   * Cancela a coleta (prazo estourado). O coletor para de pedir páginas, entrega o que já
   * está decidido e resolve.
   */
  signal?: AbortSignal;
}

export interface CrawlReport {
  /** Quantas unidades de trabalho o coletor planejou. */
  planned: number;
  /** Quantas delas falharam. */
  failures: number;
  /** Termos varridos por inteiro, e os que não (falha, ou páginas somando menos que o total). */
  termsComplete: number;
  termsFailed: number;
  /** Itens entregues com anúncio ao menos uma vez. */
  itemsPublished: number;
  /** Itens conhecidos entregues vazios: confirmados fora de venda. */
  itemsRemoved: number;
  /** Itens vistos ou conhecidos que não deu para decidir: o serviço mantém o que tinha. */
  itemsIncomplete: number;
}

export interface Collector {
  crawl(req: CrawlRequest): Promise<CrawlReport>;
  /** Libera o que o coletor tenha aberto (conexões, processos). */
  close(): Promise<void>;
}

/** O formato do módulo que `COLLECTOR_PATH` tem que exportar. */
export interface CollectorModule {
  createCollector(): Promise<Collector>;
}
