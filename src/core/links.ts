/**
 * Links externos de um item.
 *
 * Servem para o agente devolver algo clicável em vez de só números — a pessoa quer
 * conferir no site oficial e ler a descrição completa no Divine Pride.
 *
 * O link do mercado tem uma armadilha: **o site recusa caracteres especiais no
 * `searchWord`**. Verificado ao vivo — `Abelha-Rainha` responde HTTP 200 com corpo
 * vazio (a forma de recusa deste site), enquanto `Ovo de Abelha`, `Bota Temporal VIT`
 * e `Poção Vermelha` respondem normalmente. Ou seja: letras, dígitos, acentos e
 * espaço passam; hífen, colchete e pontuação quebram.
 *
 * Como a busca do site casa por substring, um nome com hífen não precisa virar link
 * quebrado nem link sem busca: basta procurar pelo maior trecho seguro do nome.
 * `Ovo de Abelha-Rainha` vira `Ovo de Abelha`, que encontra o item do mesmo jeito.
 */

import { type Dataset } from "./datasets.js";
import { type Server } from "./servers.js";
import { stripSlotSuffix } from "../util/text.js";

const DIVINE_PRIDE = "https://www.divine-pride.net/database/item";

/**
 * A busca de lojas do site oficial. É a página que uma pessoa abre no navegador, e é para
 * onde estes links levam — ela chega junto de todo item na resposta da API.
 *
 * `storeType=BUY` é o lado de quem está vendendo (o que dá para comprar), o único que este
 * site preenche. `period=ALL` pede o histórico inteiro no agregado por item.
 */
const SITE_SEARCH = "https://ro.gnjoylatam.com/pt/intro/shop-search";
const STORE_TYPE = "BUY";
const PERIOD = "ALL";

/**
 * Caracteres aceitos pelo `searchWord`.
 *
 * Espaço entra aqui porque o objetivo é o nome legível do item, e o site aceita espaço sem
 * reclamar. Letras, dígitos e acentos passam; pontuação quebra.
 */
const SAFE_SEARCH_CHAR = /[a-z0-9áàâãéèêíìîóòôõúùûüçñ ]/i;

/**
 * Maior trecho do nome que o site aceita como busca.
 *
 * Devolve `null` quando não sobra nada utilizável — melhor não oferecer link do que
 * oferecer um que responde vazio.
 */
export function searchWordFor(name: string): string | null {
  const clean = stripSlotSuffix(name);

  let best = "";
  let current = "";
  for (const ch of clean) {
    if (SAFE_SEARCH_CHAR.test(ch)) {
      current += ch;
    } else {
      if (current.trim().length > best.trim().length) best = current;
      current = "";
    }
  }
  if (current.trim().length > best.trim().length) best = current;

  const trimmed = best.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface ItemLinks {
  /** Descrição completa e atributos no Divine Pride. */
  divinePride: string;
  /** Lojas vendendo este item agora, no site oficial. Null se o nome não é buscável. */
  market: string | null;
  /** Histórico de preço agregado do item, no site oficial. */
  marketHistory: string | null;
}

/**
 * Monta os links de um item.
 *
 * A URL do mercado é a mesma que uma pessoa abre no navegador. O link de lojas abre
 * **ordenado do mais barato para o mais caro**, na primeira página: quem clica veio de um
 * preço — o mínimo da tabela, ou o alvo de um alerta que acabou de disparar — e a primeira
 * coisa que precisa achar é a loja que cobra aquilo. Com a ordenação padrão do site, esse
 * anúncio pode estar em qualquer lugar da lista.
 *
 * Vale para todo mundo por construção: a notificação do ntfy leva este mesmo `market` como
 * destino do toque, então não há uma segunda montagem de URL para manter em dia.
 */
export function linksFor(itemId: number, name: string, server: Server): ItemLinks {
  const searchWord = searchWordFor(name);

  const marketUrl = (dataset: Dataset): string | null => {
    if (searchWord === null) return null;
    // O servidor entra na URL: um link de FREYA aberto por quem joga em NIDHOGG
    // mostraria o mercado errado sem avisar.
    const params = new URLSearchParams({ serverType: server, searchWord });
    if (dataset === "trading") {
      params.set("storeType", STORE_TYPE);
      params.set("sortType", "LOW_PRICE");
      params.set("p", "1");
    } else {
      // O histórico é um agregado por item, não uma lista de anúncios: não há o que
      // ordenar por preço nem página para escolher.
      params.set("period", PERIOD);
    }
    return `${SITE_SEARCH}/${dataset}?${params.toString()}`;
  };

  return {
    divinePride: `${DIVINE_PRIDE}/${itemId}`,
    market: marketUrl("trading"),
    marketHistory: marketUrl("market-price"),
  };
}
