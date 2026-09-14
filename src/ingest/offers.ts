/**
 * De linhas do site para ofertas: as regras que valem para qualquer caminho de ingestão.
 *
 * Saíram de `edge/ingest.ts` (a ingestão do Worker) quando o serviço veio para a VM. As
 * regras não mudaram; o que mudou é que agora elas rodam por ITEM, conforme o coletor
 * decide cada um, e não sobre a coleta inteira de uma vez.
 */

import type { ListingRow, PricePoint } from "../store/read.js";
import type { MarketPriceRow, Row, TradingRow } from "../store/rows.js";
import { normalizeName, stripSlotSuffix } from "../util/text.js";

/** Um item visto no mercado, para o catálogo e para o "já apareceu aqui". */
export interface SeenItem {
  itemId: number;
  name: string;
  nameNorm: string;
  imgPath: string | null;
  dbType: string | null;
}

export function seenItem(row: Row): SeenItem {
  const name = stripSlotSuffix(row.itemName);
  return {
    itemId: row.itemId,
    name,
    nameNorm: normalizeName(name),
    imgPath: row.databaseImgPath,
    dbType: row.databaseType,
  };
}

export interface GroupedOffers {
  /** Ordenadas por preço crescente — a ordem em que são servidas. */
  listings: ListingRow[];
  /** Linhas que eram a MESMA vaga vista de novo. */
  repetidas: number;
  /** Vagas distintas fundidas numa oferta só. */
  agrupadas: number;
}

/**
 * As ofertas de um conjunto de anúncios.
 *
 * Um anúncio é UMA LOJA OFERECENDO A UM PREÇO — não uma vaga de loja. O site devolve uma
 * linha por VAGA (`ssi`), e um vendedor com três cópias do mesmo item ocupa três vagas:
 * mesmo preço, mesma loja, mesmo vendedor, `itemCnt` 1 em cada. Repassar isso adiante
 * deixava a mesma loja três vezes seguidas no painel "lojas mais baratas", fazia o campo
 * "Lojas" dizer 3 quando havia 1, e puxava a mediana.
 *
 * `slotMax` entra na chave porque descreve o item, não a vaga: a mesma loja vendendo a
 * versão com e sem slot ao mesmo preço são duas ofertas diferentes.
 *
 * O agrupamento NÃO pode ver a mesma vaga duas vezes: a soma das peças contaria a vaga a
 * cada repetição, e um equipamento — que não empilha — apareceria com 5 peças onde há 1.
 * O `ssi` identifica a VAGA, não a observação: a mesma vaga pode voltar com outro
 * `itemCnt` se a loja vendeu entre uma varredura e outra, e a última ocorrência vence.
 */
export function groupOffers(rows: readonly TradingRow[]): GroupedOffers {
  const porVaga = new Map<string, TradingRow>();
  for (const row of rows) porVaga.set(row.ssi, row);

  const porOferta = new Map<string, ListingRow>();
  for (const row of porVaga.values()) {
    // O site manda `""` quando o item não tem slot, e isso é NULL, não string vazia.
    const slotMax = row.slotMaxCount || null;
    // `itemId` na chave: quem chama pode passar anúncios de mais de um item, e dois itens
    // ao mesmo preço na mesma loja não são a mesma oferta.
    const key = JSON.stringify([
      row.itemId,
      row.itemSellerCharName,
      row.storeName,
      row.itemPrice,
      slotMax ?? "",
    ]);
    const seen = porOferta.get(key);
    if (seen) {
      seen.cnt += row.itemCnt;
      continue;
    }
    porOferta.set(key, {
      ssi: row.ssi,
      itemId: row.itemId,
      price: row.itemPrice,
      cnt: row.itemCnt,
      slotMax,
      storeName: row.storeName,
      seller: row.itemSellerCharName,
      mapId: row.mapId,
    });
  }

  const listings = [...porOferta.values()].sort((a, b) => a.price - b.price || cmp(a.ssi, b.ssi));
  return {
    listings,
    repetidas: rows.length - porVaga.size,
    agrupadas: porVaga.size - listings.length,
  };
}

export function pricePoint(row: MarketPriceRow, ts: number): PricePoint {
  return {
    itemId: row.itemId,
    ts,
    totalCnt: row.totalItemCnt,
    minPrice: row.minItemPrice,
    maxPrice: row.maxItemPrice,
    avgPrice: row.avgItemPrice,
  };
}

/** Impressão digital de um conjunto de ofertas: igual = nada a regravar. */
export function offersFingerprint(listings: readonly ListingRow[]): string {
  return listings
    .map((l) => `${l.ssi}:${l.price}:${l.cnt}:${l.slotMax ?? ""}:${l.seller}:${l.storeName}`)
    .join("|");
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
