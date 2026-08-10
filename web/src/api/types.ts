/**
 * O contrato da API, importado direto do backend.
 *
 * Este é o ÚNICO arquivo do `web/` que alcança `../src/`, e só por `import type`. Um
 * arquivo espelho seria mais fácil de escrever e erraria em silêncio: acrescentar um
 * campo em `ValuedItem` e esquecer de copiá-lo aqui daria uma tela que compila e mostra
 * espaço em branco. Assim o `tsc --noEmit` do `web/` quebra junto com o backend.
 *
 * `import type` some inteiro no build (ver `verbatimModuleSyntax` no tsconfig), então
 * nada de `src/` chega ao navegador — o `node:sqlite` que `core/replay.ts` importa fica
 * de fora. `src/__tests__/layering.test.ts` garante que continue sendo só tipo.
 */

import type { Appraisal } from "../../../src/core/appraise.js";
import type { SearchSort } from "../../../src/core/items.js";
import type { Deal, Mover } from "../../../src/core/movers.js";
import type { SearchPrices } from "../../../src/core/prices.js";
import type { ReplayValuation, SellCandidate, ValuedItem } from "../../../src/core/replay.js";
import type { ServiceStatus } from "../../../src/core/status.js";
import type { EquipSlot, FilterOption, ItemCategory } from "../../../src/core/taxonomy.js";
import type {
  Freshness,
  HistoryPoint,
  ItemBrief,
  ItemLinks,
  ItemPrice,
  Offer,
} from "../../../src/core/types.js";

// Só o que os componentes realmente importam. Os demais tipos acima entram apenas na
// montagem das respostas abaixo e não fazem parte da superfície pública deste módulo.
export type {
  EquipSlot,
  FilterOption,
  Freshness,
  HistoryPoint,
  ItemBrief,
  ItemCategory,
  ItemLinks,
  ItemPrice,
  Mover,
  SearchSort,
  SellCandidate,
  ServiceStatus,
  ValuedItem,
};

/** `GET /api/v1/taxonomy` — as opções de filtro, para não duplicar a taxonomia aqui. */
export interface TaxonomyResponse {
  /** Lista única para o seletor: já mistura tipo e slot na ordem certa. */
  options: FilterOption[];
}

/** O `/replay` devolve a avaliação com os candidatos a venda junto. */
export interface ReplayResponse extends ReplayValuation {
  sellCandidates: SellCandidate[];
}

/**
 * `GET /api/v1/items?q=`
 *
 * Cada linha vem com preço (`ItemPrice`, não `ItemBrief`): a tabela da busca mostra
 * "mais barato" e companhia em colunas, e a ordenação por elas acontece no servidor —
 * é o que faz a ordem valer para o total, e não só para a página carregada.
 */
export type SearchResponse = SearchPrices & { freshness: Freshness };

/** `GET /api/v1/items/:item` */
export type ItemPriceResponse = ItemPrice & { freshness: Freshness };

/** `GET /api/v1/items/:item/history` */
export interface HistoryResponse {
  itemId: number;
  points: HistoryPoint[];
}

/** `GET /api/v1/items/:item/offers` */
export interface OffersResponse {
  itemId: number;
  offers: Offer[];
  freshness: Freshness;
}

/** `GET /api/v1/items/:item/appraise?price=` */
export type AppraiseResponse = Appraisal & { freshness: Freshness };

/**
 * `GET /api/v1/prices?items=`
 *
 * `nextTradingAt` é epoch em segundos, ou `null` quando o servidor não tem agendador — é
 * o que deixa a aba Favoritos dormir até a coleta pousar em vez de perguntar em intervalo
 * fixo (ver `lib/schedule.ts`).
 */
export interface PricesResponse {
  prices: ItemPrice[];
  /** Ids pedidos que não existem no catálogo. */
  missing: number[];
  freshness: Freshness;
  nextTradingAt: number | null;
}

/** `GET /api/v1/movers` */
export interface MoversResponse {
  movers: Mover[];
  freshness: Freshness;
}

/** `GET /api/v1/deals` */
export interface DealsResponse {
  deals: Deal[];
  freshness: Freshness;
}
