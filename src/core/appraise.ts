/**
 * Avaliação de preço: "vender isso por X é bom negócio?"
 *
 * A resposta honesta tem dois lados, e os dois são devolvidos:
 *  - **concorrência**: quantas lojas estão mais baratas que X agora. É o que decide se
 *    o item vende hoje, e é o número que importa quando alguém quer vender rápido.
 *  - **histórico**: como X se compara à mediana dos últimos dias. É o que decide se o
 *    momento é bom, e protege de tomar o fundo de um dia atípico como referência.
 *
 * O que NÃO existe aqui: uma previsão de preço. Os dados são um retrato do que está
 * anunciado, não uma série de transações fechadas — o site não publica volume por dia,
 * só o acumulado histórico. Qualquer "vai subir" seria invenção.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Server } from "./servers.js";

import { getCache } from "../store/cache.js";
import { baseline } from "../store/read.js";
import { toBrief } from "./items.js";
import { cheapestOffers, offerSummary } from "./prices.js";
import { plural } from "../util/text.js";
import type { ItemBrief, Offer, OfferSummary } from "./types.js";

export type Verdict = "barato" | "competitivo" | "acima-do-mercado" | "caro" | "sem-dados";

export interface Appraisal {
  item: ItemBrief;
  /** O preço que se quer avaliar. */
  price: number;
  verdict: Verdict;
  /** Frase pronta em pt-BR, para o agente repetir sem reinterpretar os números. */
  summary: string;

  competition: {
    /** Lojas com preço estritamente menor. Zero significa que você seria o mais barato. */
    cheaperStores: number;
    totalStores: number;
    /** Posição percentual entre as ofertas (0 = mais barato de todos). */
    percentile: number;
    /** Maior preço que ainda deixa você como o mais barato. Null se não há concorrência. */
    undercutPrice: number | null;
    offers: OfferSummary;
    cheapest: Offer[];
  } | null;

  historical: {
    days: number;
    /** Média das medianas diárias da janela. */
    avgMedian: number;
    /** Menor preço já observado na janela. */
    minSeen: number;
    /** Quanto o preço proposto está acima (+) ou abaixo (-) da média, em %. */
    deltaPct: number;
  } | null;
}

/** Janela do histórico. 30 dias cobre o ciclo de eventos sem diluir demais. */
const WINDOW_DAYS = 30;

export function appraise(
  db: DatabaseSync,
  server: Server,
  itemId: number,
  price: number,
): Appraisal | null {
  const item = toBrief(server, itemId);
  if (!item) return null;

  const offers = offerSummary(server, itemId);
  const cheapest = cheapestOffers(server, itemId, 5);

  let competition: Appraisal["competition"] = null;
  if (offers) {
    const listings = getCache(server).listings.get(itemId) ?? [];
    const cheaperStores = listings.filter((l) => l.price < price).length;
    competition = {
      cheaperStores,
      totalStores: listings.length,
      percentile: Math.round((cheaperStores / listings.length) * 100),
      // Um zeny abaixo do mais barato já basta para aparecer primeiro na busca do jogo.
      undercutPrice: offers.min > 1 ? offers.min - 1 : null,
      offers,
      cheapest,
    };
  }

  const base = baseline(db, server, itemId, Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400);
  const historical = base
    ? {
        days: base.days,
        avgMedian: base.avgMedian,
        minSeen: base.minSeen,
        deltaPct: Math.round(((price - base.avgMedian) / base.avgMedian) * 100),
      }
    : null;

  const verdict = decide(competition, historical);
  return {
    item,
    price,
    verdict,
    summary: phrase(item, price, verdict, competition, historical),
    competition,
    historical,
  };
}

/**
 * O veredito prioriza a concorrência sobre o histórico.
 *
 * Se dez lojas estão mais baratas, não importa que o preço esteja abaixo da média do
 * mês: o item não vende. O histórico só decide quando não há com quem competir.
 */
function decide(
  competition: Appraisal["competition"],
  historical: Appraisal["historical"],
): Verdict {
  if (competition) {
    // O percentil é a fração de lojas mais baratas. 70% delas abaixo já é caro o
    // bastante para o item não sair — o corte fica logo abaixo disso.
    const { percentile } = competition;
    if (percentile === 0) return "barato";
    if (percentile <= 35) return "competitivo";
    if (percentile < 70) return "acima-do-mercado";
    return "caro";
  }
  if (historical) {
    if (historical.deltaPct <= -20) return "barato";
    if (historical.deltaPct <= 15) return "competitivo";
    if (historical.deltaPct <= 60) return "acima-do-mercado";
    return "caro";
  }
  return "sem-dados";
}

const z = (n: number) => n.toLocaleString("pt-BR");

function phrase(
  item: ItemBrief,
  price: number,
  verdict: Verdict,
  competition: Appraisal["competition"],
  historical: Appraisal["historical"],
): string {
  const parts: string[] = [];

  if (competition) {
    const { cheaperStores, totalStores, offers } = competition;
    parts.push(
      cheaperStores === 0
        ? `A ${z(price)}z você seria o mais barato dos ${totalStores} anúncios de ${item.name} (o menor hoje é ${z(offers.min)}z).`
        : `${cheaperStores} de ${totalStores} lojas vendem ${item.name} mais barato que ${z(price)}z; a mediana está em ${z(offers.median)}z.`,
    );
  } else {
    parts.push(`Ninguém está vendendo ${item.name} agora.`);
  }

  if (historical) {
    const d = historical.deltaPct;
    parts.push(
      d === 0
        ? `É exatamente a média dos últimos ${plural(historical.days, "dia", "dias")}.`
        : `Isso é ${Math.abs(d)}% ${d > 0 ? "acima" : "abaixo"} da média dos últimos ` +
          `${plural(historical.days, "dia", "dias")} (${z(historical.avgMedian)}z).`,
    );
  } else {
    parts.push("Não há histórico acumulado suficiente para comparar.");
  }

  if (verdict === "sem-dados") {
    parts.push("Sem dados de mercado, não dá para dizer se o preço é bom.");
  }

  return parts.join(" ");
}
