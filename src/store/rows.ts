/**
 * As linhas que entram no banco.
 *
 * É o contrato de ingestão: o coletor produz estas formas, `writeRows` as consome. Mora
 * em `store/` porque é aqui que ele é cobrado — o coletor é um componente à parte, com a
 * sua própria cópia destas interfaces, e nada além do formato liga os dois.
 *
 * ⚠ **Nada valida isto em tempo de execução.** `writeRows` passa os campos direto para o
 * SQLite, e vários deles caem num `?? null` ou `|| ""` no caminho — então um campo renomeado
 * do lado do coletor não vira erro, vira coluna vazia gravada em silêncio. Se um dia isso
 * doer, o lugar de checar é o primeiro lote de cada coleta, em `crawl-worker.ts`, contra um
 * schema do zod (que já é dependência): um lote por run é de graça e transforma deriva muda
 * em coleta abortada.
 *
 * Os nomes dos campos são os do site, não os nossos: renomeá-los na entrada só criaria um
 * segundo vocabulário para manter em dia. Quanto menos campo aqui, menos o outro repositório
 * precisa continuar produzindo — só entra o que o `store/` realmente lê.
 */

/**
 * O que toda linha traz, e o que `upsertItemsFromRows` lê da união sem olhar o dataset.
 *
 * Está separado por isso: é exatamente o conjunto que o caminho comum depende. Antes os
 * dois tipos repetiam os campos e só compilava porque a repetição era idêntica.
 */
export interface IdentifiedRow {
  itemId: number;
  itemName: string;
  databaseImgPath: string | null;
  databaseType: string | null;
}

/** Um anúncio de loja do dataset `trading`. */
export interface TradingRow extends IdentifiedRow {
  mapId: number;
  /** Id único da vaga de loja (64 bits, chega como string). */
  ssi: string;
  storeName: string;
  itemPrice: number;
  itemCnt: number;
  slotMaxCount: string;
  storeTypeName: string;
  itemSellerCharName: string;
}

/** Uma linha agregada por item do dataset `market-price`. */
export interface MarketPriceRow extends IdentifiedRow {
  totalItemCnt: number;
  minItemPrice: number;
  maxItemPrice: number;
  avgItemPrice: number;
}

export type Row = TradingRow | MarketPriceRow;

/** Uma entrada do latam-items.json (chaveado pelo id do item em string). */
export interface LatamItem {
  name: string;
  description?: string;
  aegisName?: string;
  slots?: number;
}
