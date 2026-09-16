/**
 * Endereços do site oficial do mercado, e os links de um item.
 *
 * Moram no navegador desde que a coleta do servidor acabou (2026-09-15): quem consulta o
 * site agora é a aba da pessoa, então é aqui que a URL da consulta precisa existir. O link
 * que a pessoa clica e a URL que a conexão busca saem da mesma função, para não haver duas
 * montagens de URL para manter em dia.
 *
 * O link do mercado tem uma armadilha: **o site recusa caracteres especiais no
 * `searchWord`**. Verificado ao vivo — `Abelha-Rainha` responde HTTP 200 com corpo vazio (a
 * forma de recusa deste site), enquanto `Ovo de Abelha`, `Bota Temporal VIT` e `Poção
 * Vermelha` respondem normalmente. Letras, dígitos, acentos e espaço passam; hífen,
 * colchete e pontuação quebram.
 *
 * Como a busca do site casa por substring, um nome com hífen não precisa virar link quebrado
 * nem link sem busca: basta procurar pelo maior trecho seguro do nome. `Ovo de Abelha-Rainha`
 * vira `Ovo de Abelha`, que encontra o item do mesmo jeito.
 */

import type { Server } from "../server.js";

export const MARKET_ORIGIN = "https://ro.gnjoyamericas.com";

/** A busca de lojas. É o único caminho que a conexão aceita buscar — ver `bridge/bridge.ts`. */
export const TRADING_PATH = "/pt/intro/shop-search/trading";

const DIVINE_PRIDE = "https://www.divine-pride.net/database/item";

/**
 * Menor termo que a busca de lojas aceita.
 *
 * Com uma letra só o site responde vazio. Um item cujo maior trecho seguro do nome é mais
 * curto que isto não tem como ser consultado.
 */
export const MIN_SEARCH_WORD = 2;

/**
 * Quantos anúncios pedir numa consulta.
 *
 * Mil é o teto que o site devolve. Com `sortType=LOW_PRICE` a ordenação vale para o
 * resultado inteiro, não só para a página (conferido ao vivo: página 1 de 1.543 anúncios de
 * "Carta" começa no mais barato de todos). Então uma página só basta para o menor preço —
 * mesmo quando o nome do item casa com outros itens mais caros. O teto alto é para as
 * contagens de lojas e unidades saírem completas no caso comum.
 */
const CHECK_LIMIT = 1000;

/**
 * Caracteres aceitos pelo `searchWord`.
 *
 * Espaço entra aqui porque o objetivo é o nome legível do item, e o site aceita espaço sem
 * reclamar.
 */
const SAFE_SEARCH_CHAR = /[a-z0-9áàâãéèêíìîóòôõúùûüçñ ]/i;

/**
 * Os trechos do nome que o site aceita como busca, na ordem: o nome partido em cada
 * caractere recusado, sem o sufixo de slots do cliente ("Sabre [3]" → "Sabre").
 *
 * Uma regra só para o link, para a consulta de um item e para os termos de grupo do
 * planejador (`plan.ts`): se o site mudar o que aceita, muda aqui.
 */
export function safeSegments(name: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of name.replace(/\s*\[\d+\]\s*$/, "")) {
    if (SAFE_SEARCH_CHAR.test(ch)) {
      current += ch;
    } else {
      if (current.trim()) out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Maior trecho do nome que o site aceita como busca.
 *
 * Devolve `null` quando não sobra nada utilizável — melhor não oferecer link do que
 * oferecer um que responde vazio.
 */
export function searchWordFor(name: string): string | null {
  let best: string | null = null;
  for (const segment of safeSegments(name)) if (!best || segment.length > best.length) best = segment;
  return best;
}

/**
 * A busca de lojas ordenada do mais barato para o mais caro, na primeira página.
 *
 * O servidor entra na URL: um link de FREYA aberto por quem joga em NIDHOGG mostraria o
 * mercado errado sem avisar.
 */
function tradingUrl(server: Server, searchWord: string, limit?: number): string {
  const params = new URLSearchParams({
    serverType: server,
    searchWord,
    storeType: "BUY",
    sortType: "LOW_PRICE",
    p: "1",
  });
  if (limit !== undefined) params.set("limit", String(limit));
  return `${MARKET_ORIGIN}${TRADING_PATH}?${params.toString()}`;
}

/**
 * A URL que a conexão busca para um termo já escolhido (ver `plan.ts`).
 *
 * O termo vem do planejador, que só monta termos com caracteres aceitos; a checagem de tamanho
 * mínimo fica aqui mesmo assim, porque é o site que recusa, e não o planejador.
 */
export function checkUrlForTerm(term: string, server: Server): string | null {
  if (term.length < MIN_SEARCH_WORD) return null;
  return tradingUrl(server, term, CHECK_LIMIT);
}

/**
 * A página que a aba auxiliar abre: uma busca pequena e barata.
 *
 * Qualquer página do site serviria para rodar o favorito; esta é a que menos pesa e a que
 * já mostra à pessoa o que a conexão vai consultar.
 */
export const bridgeLandingUrl = (server: Server): string => tradingUrl(server, "Poring", 10);

export interface ItemLinks {
  /** Descrição completa e atributos no Divine Pride. */
  divinePride: string;
  /** Lojas vendendo este item agora, no site oficial. Null se o nome não é buscável. */
  market: string | null;
}

/**
 * Os links de um item.
 *
 * O de lojas abre **ordenado do mais barato para o mais caro**: quem clica veio de um preço
 * — o mínimo da tabela, ou o alvo de um alerta que acabou de disparar — e a primeira coisa
 * que precisa achar é a loja que cobra aquilo. A notificação do ntfy leva este mesmo link.
 */
export function linksFor(itemId: number, name: string, server: Server): ItemLinks {
  const word = searchWordFor(name);
  return {
    divinePride: `${DIVINE_PRIDE}/${itemId}`,
    market: word === null ? null : tradingUrl(server, word),
  };
}
