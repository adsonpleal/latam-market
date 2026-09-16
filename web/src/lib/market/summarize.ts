/**
 * De uma página de anúncios para o que a tabela e o alerta precisam de um item.
 *
 * A busca do site é por trecho do nome, então a resposta mistura itens: "Carta Zangão"
 * também traz "Carta Zangão Rainha". Só contam as linhas do id pedido.
 */

import type { TradingRow } from "./extract.js";

export interface ListingSummary {
  /**
   * Menor preço à venda, ou `null` quando nenhuma linha é deste item.
   *
   * Exato mesmo com a página cortada: a consulta pede `sortType=LOW_PRICE`, e essa ordem vale
   * para o resultado inteiro (ver `url.ts`).
   */
  min: number | null;
  /** Lojas distintas vendendo. Com `truncated`, é um piso. */
  stores: number;
  /** Soma das unidades à venda. Com `truncated`, é um piso. */
  units: number;
  /** Nome de quem vende mais barato — é o que se procura no jogo. */
  seller: string | null;
  /** O site tinha mais anúncios que os que vieram na página. */
  truncated: boolean;
}

export function summarize(rows: TradingRow[], totalCount: number, itemId: number): ListingSummary {
  const mine = rows.filter((r) => r.itemId === itemId);

  let min: number | null = null;
  let seller: string | null = null;
  let units = 0;
  const stores = new Set<string>();
  for (const row of mine) {
    units += row.itemCnt;
    // O vendedor, e não o nome da loja: "VENDO" se repete entre personagens diferentes, e o
    // mesmo personagem só abre uma loja por vez.
    stores.add(row.itemSellerCharName);
    if (min === null || row.itemPrice < min) {
      min = row.itemPrice;
      seller = row.itemSellerCharName;
    }
  }

  return { min, stores: stores.size, units, seller, truncated: totalCount > rows.length };
}
