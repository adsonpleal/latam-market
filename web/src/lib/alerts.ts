/**
 * Quando um alerta dispara — decidido por funções puras, sem efeito nenhum.
 *
 * O app irmão fazia essa conta dentro de um atualizador de estado do React, o que roda
 * duas vezes sob StrictMode e mandava notificação dobrada em desenvolvimento. Aqui a
 * decisão é uma função sobre um retrato: o laço chama `planAlerts`, aplica os patches numa
 * escrita só e manda os pushes depois. É também o que torna a regra testável de verdade,
 * que é o que mais importa numa lógica assim — errar aqui é mandar aviso errado, ou pior,
 * não mandar nenhum e a pessoa nunca descobrir.
 */

import type { ItemPrice } from "../api/types.js";
import type { Server } from "../api/client.js";
import { plural, zeny } from "./format.js";
import { alertKey, type Alert, type Alerts, type Direction } from "./persist.js";

/**
 * Aplica um patch, cuidando da regra de rearme.
 *
 * Mudar o alvo (ou a direção) zera o marcador de deduplicação. Sem isso, baixar o alvo
 * para um valor que o preço atual já satisfaz não avisaria nada: o marcador antigo diria
 * "já avisei nesse preço", e a pessoa concluiria que o alerta está quebrado. Quem passa
 * `lastAlertedPrice` explicitamente (o próprio laço, ao registrar um disparo) manda mais
 * que a regra.
 */
export function applyAlertPatch(current: Alert | undefined, patch: Partial<Alert>): Alert {
  const base: Alert = current ?? {
    enabled: true,
    direction: "down",
    targetPrice: 0,
    lastAlertedPrice: null,
  };
  const next: Alert = { ...base, ...patch };

  const mudouAlvo = patch.targetPrice !== undefined && patch.targetPrice !== base.targetPrice;
  const mudouDirecao = patch.direction !== undefined && patch.direction !== base.direction;
  if ((mudouAlvo || mudouDirecao) && patch.lastAlertedPrice === undefined) {
    next.lastAlertedPrice = null;
  }

  /**
   * Patch que não muda nada devolve a MESMA referência.
   *
   * É o que deixa quem chama escrever `if (merged === current) continue` e cortar o
   * re-render, sem uma função de igualdade à parte — que teria de ser lembrada toda vez que
   * `Alert` ganhasse um campo.
   */
  if (
    current &&
    next.enabled === current.enabled &&
    next.direction === current.direction &&
    next.targetPrice === current.targetPrice &&
    next.lastAlertedPrice === current.lastAlertedPrice
  ) {
    return current;
  }
  return next;
}

export interface AlertDecision {
  fire: boolean;
  /** `null` quando nada precisa ser gravado. */
  patch: Partial<Alert> | null;
}

/**
 * O alerta dispara agora?
 *
 * As duas direções são espelhos exatos, incluindo o "só reavisa se andou mais na mesma
 * direção" e o rearme ao voltar para o outro lado do alvo.
 *
 * `price` é sempre o **menor preço nas lojas abertas** (`offers.min`). Uma série só para as
 * duas direções: comprando, é quanto custa hoje; vendendo, é o preço que se precisa bater.
 * Usar a mediana na direção de alta deixaria o `lastAlertedPrice` ambíguo — marcador de
 * qual série? O histórico publicado pelo site (`market`) não entra: é outra medida, e não
 * se soma a esta (ver o cabeçalho de `core/prices.ts` no backend).
 */
export function evaluateAlert(alert: Alert, price: number | null): AlertDecision {
  if (alert.direction === "available") return evaluateAvailable(alert, price);

  // Ninguém vendendo. Não há sinal, e inventar um é pior que calar.
  if (price === null) return { fire: false, patch: null };

  const atingiu = alert.direction === "down" ? price <= alert.targetPrice : price >= alert.targetPrice;

  if (atingiu) {
    const andouMais =
      alert.lastAlertedPrice === null ||
      (alert.direction === "down" ? price < alert.lastAlertedPrice : price > alert.lastAlertedPrice);
    if (andouMais) return { fire: true, patch: { lastAlertedPrice: price } };
    // Já avisado neste preço (ou pior): silêncio, sem gravar nada.
    return { fire: false, patch: null };
  }

  // Voltou para o outro lado do alvo: rearma, para o próximo movimento avisar de novo.
  if (alert.lastAlertedPrice !== null) return { fire: false, patch: { lastAlertedPrice: null } };
  return { fire: false, patch: null };
}

/**
 * O aviso de "apareceu à venda", sem alvo.
 *
 * Avisa uma vez por aparição: enquanto houver loja vendendo, preço nenhum reavisa — quem
 * quer saber de queda usa a direção `down`. É o sumiço de TODAS as lojas que rearma, e aqui
 * `null` é sinal, ao contrário das direções de preço: é justamente o "voltou para o outro
 * lado". O `lastAlertedPrice` guarda o preço em que avisou só para servir de marcador.
 */
function evaluateAvailable(alert: Alert, price: number | null): AlertDecision {
  const armado = alert.lastAlertedPrice === null;
  if (price !== null && armado) return { fire: true, patch: { lastAlertedPrice: price } };
  if (price === null && !armado) return { fire: false, patch: { lastAlertedPrice: null } };
  return { fire: false, patch: null };
}

export interface AlertNotification {
  itemId: number;
  name: string;
  title: string;
  body: string;
  /** Link do mercado, para a notificação no celular abrir o anúncio. Pode não existir. */
  click: string | null;
}

/**
 * Tudo o que se escreve sobre um alerta, por modo, num lugar só.
 *
 * Um `Record` e não ternários espalhados: com um modo novo, o compilador aponta cada texto
 * que falta, em vez de o modo cair calado na redação de outro.
 */
const WORDING: Record<
  Direction,
  { title: string; short: (target: string) => string; long: (target: string) => string }
> = {
  down: {
    title: "Preço baixou",
    short: (t) => `↓ ${t}`,
    long: (t) => `Avisar quando o menor preço cair para ${t}`,
  },
  up: {
    title: "Preço subiu",
    short: (t) => `↑ ${t}`,
    long: (t) => `Avisar quando o menor preço subir para ${t}`,
  },
  available: {
    title: "À venda",
    short: () => "à venda",
    long: () => "Avisar quando aparecer à venda, a qualquer preço",
  },
};

/** O modo compara com um alvo? Em `available`, `targetPrice` não é lido. */
export const usesTarget = (direction: Direction): boolean => direction !== "available";

/** Rótulo curto (célula da tabela) e descrição (dica) do alerta. */
export function describeAlert(alert: Alert): { short: string; long: string } {
  const { short, long } = WORDING[alert.direction];
  const target = zeny(alert.targetPrice);
  return { short: short(target), long: long(target) };
}

export interface AlertPlan {
  patches: Array<{ key: string; patch: Partial<Alert> }>;
  notifications: AlertNotification[];
}

/**
 * Tudo o que um ciclo precisa fazer, decidido de uma vez e sem efeito colateral.
 *
 * Só avalia alertas do servidor ativo e de itens que ainda estão nos favoritos:
 * desfavoritar silencia o alerta sem apagá-lo, então reativá-lo é só favoritar de novo.
 *
 * `tradingAt` nulo é o servidor sem coleta carregada (acabou de subir), e aí todo item vem
 * sem oferta. Não há o que decidir: as direções de preço já calariam, mas o aviso de "à
 * venda" leria como "sumiu de todas as lojas", rearmaria e avisaria de novo o que já estava
 * à venda.
 */
export function planAlerts(
  server: Server,
  alerts: Alerts,
  favorites: Set<number>,
  prices: ItemPrice[],
  tradingAt: number | null,
): AlertPlan {
  const plan: AlertPlan = { patches: [], notifications: [] };
  if (tradingAt === null) return plan;

  for (const price of prices) {
    if (!favorites.has(price.itemId)) continue;

    const key = alertKey(server, price.itemId);
    const alert = alerts[key];
    if (!alert || !alert.enabled) continue;

    const min = price.offers?.min ?? null;
    const { fire, patch } = evaluateAlert(alert, min);
    if (patch) plan.patches.push({ key, patch });
    if (fire && min !== null) {
      plan.notifications.push({
        itemId: price.itemId,
        name: price.name,
        title: `${WORDING[alert.direction].title}: ${price.name}`,
        body: usesTarget(alert.direction)
          ? `Mín ${zeny(min)} — alvo ${zeny(alert.targetPrice)} (${server})`
          : `Mín ${zeny(min)} (${server})`,
        click: price.links.market,
      });
    }
  }

  return plan;
}

/**
 * Acima disto, um aviso de resumo em vez de um por item.
 *
 * Protege o limite do ntfy (60 de estouro por IP, reposto 1 a cada 5s) e, mais que isso, é
 * melhor de ler: doze notificações empilhadas no celular não se leem, uma que diz "doze
 * itens bateram o alvo" se lê.
 */
export const COALESCE_ABOVE = 5;

export interface PushMessage {
  title: string;
  body: string;
  click?: string | null;
}

/**
 * O que efetivamente vai para o celular num ciclo.
 *
 * Puro e aqui, e não dentro do laço: é a mesma classe de regra que `planAlerts` — decide o
 * que a pessoa lê — e merece o mesmo teste.
 */
export function coalesce(notifications: AlertNotification[]): PushMessage[] {
  if (notifications.length <= COALESCE_ABOVE) {
    return notifications.map((n) => ({ title: n.title, body: n.body, click: n.click }));
  }
  const primeiros = notifications
    .slice(0, 3)
    .map((n) => n.name)
    .join(", ");
  return [
    {
      title: plural(notifications.length, "alerta disparou", "alertas dispararam"),
      // O resto é sempre mais de um enquanto `COALESCE_ABOVE` for 5, mas baixar a constante
      // sem isto produziria "e mais 1 itens".
      body:
        `${primeiros} e mais ${plural(notifications.length - 3, "item", "itens")}. ` +
        `Abra a aba Favoritos para ver.`,
    },
  ];
}

/**
 * Distância que falta para o alvo, em porcentagem do preço atual.
 *
 * Positivo = ainda falta andar. Negativo = já passou do alvo. É a coluna que responde "o
 * que está quase disparando", e ordenar por ela é a razão de a aba existir.
 */
export function gapToTarget(alert: Alert | undefined, price: number | null | undefined): number | null {
  if (!alert || price === null || price === undefined || price <= 0) return null;
  // Sem alvo, não há distância: o aviso de "à venda" não tem para onde andar.
  if (!usesTarget(alert.direction)) return null;
  const delta = alert.direction === "down" ? price - alert.targetPrice : alert.targetPrice - price;
  return (delta / price) * 100;
}
