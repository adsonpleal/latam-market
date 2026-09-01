/**
 * O laço que vigia os favoritos e dispara os alertas.
 *
 * **Mora no `App`, não na página `Favoritos`.** O react-router desmonta o elemento da rota
 * ao navegar, então na página o timer morreria ao trocar de aba interna — e alerta que só
 * funciona enquanto se está olhando para ele não serve para nada. É o mesmo motivo pelo
 * qual `useReplay` já vive no `App`.
 *
 * **É o único dono do fetch de preços.** A página não busca nada: lê `prices` daqui. Com as
 * duas coisas buscando, a tabela poderia mostrar um retrato diferente daquele que decidiu o
 * alerta — divergência invisível, o pior tipo.
 *
 * São dois caminhos de escrita no retrato, e só um decide alerta: o ciclo, que lê a lista
 * inteira e passa pelo `planAlerts`; e o preenchimento, que só completa favorito que o
 * retrato ainda não cobre. Um alerta de item recém-preenchido é avaliado no ciclo seguinte,
 * como já era antes de o preenchimento existir.
 *
 * `setTimeout` em cadeia em vez de `setInterval`, porque a espera muda a cada ciclo: o
 * servidor conta quando é a próxima coleta e a aba dorme até lá (ver `lib/schedule.ts`).
 *
 * Quase todo o estado que o ciclo lê vive em `ref`, e o efeito do timer depende de muito
 * pouco. Não é preciosismo: o ciclo grava `nextTradingAt`, e se isso entrasse nas
 * dependências o efeito remontaria a cada ciclo, zerando a espera — com meia hora de
 * intervalo, o laço nunca fecharia uma volta.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { batchPrices, messageOf, type Server } from "../api/client.js";
import type { Freshness, ItemPrice } from "../api/types.js";
import { LEASE_HEARTBEAT_MS, claimLease } from "../lib/alertLease.js";
import { coalesce, planAlerts, type AlertNotification } from "../lib/alerts.js";
import { sendNtfy } from "../lib/ntfy.js";
import {
  PRICES_SNAPSHOT_KEY,
  parsePricesSnapshot,
  tabId as readTabId,
  type PricesSnapshot,
} from "../lib/persist.js";
import { collectionDue, nextWaitMs } from "../lib/schedule.js";
import { useAlerts, type AlertsApi } from "./useAlerts.js";
import { useAlertsConfig, type AlertsConfigApi } from "./useAlertsConfig.js";
import { useFavorites, type FavoritesApi } from "./useFavorites.js";
import { usePersistent } from "./usePersistent.js";

export interface FavoriteWatch {
  favorites: FavoritesApi;
  alerts: AlertsApi;
  notify: AlertsConfigApi;
  /** Preço de cada favorito, do último ciclo. */
  prices: Map<number, ItemPrice>;
  /** Ids favoritados que o catálogo não conhece. */
  missing: number[];
  freshness: Freshness | null;
  /** Epoch em segundos da próxima coleta, quando o servidor sabe. Só para exibição. */
  nextTradingAt: number | null;
  /** Epoch em ms do último ciclo concluído. */
  lastRun: number | null;
  running: boolean;
  error: string | null;
  /** O que disparou desde a última baixa. Alimenta a faixa na tela e o contador na nav. */
  fired: AlertNotification[];
  dismissFired: () => void;
  /** Ação explícita: ignora o lease e a espera. */
  checkNow: () => void;
}

export function useFavoriteWatch(server: Server): FavoriteWatch {
  const favorites = useFavorites();
  const alerts = useAlerts();
  const notify = useAlertsConfig();

  /**
   * O retrato de preços vive no `localStorage`, não só em memória.
   *
   * Duas razões, as duas descobertas na tela: só uma aba roda o laço, então a segunda
   * mostraria travessões para sempre; e recarregar a página deixaria a tabela vazia até o
   * próximo ciclo, que pode estar a meia hora. Guardado, a aba não-líder acompanha a líder
   * pelo evento do `usePersistent`, e um recarregamento pinta na hora.
   */
  const { value: snapshot, set: setSnapshot } = usePersistent<PricesSnapshot | null>(
    PRICES_SNAPSHOT_KEY,
    null,
    parsePricesSnapshot,
  );

  const [lastRun, setLastRun] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fired, setFired] = useState<AlertNotification[]>([]);

  const prices = useMemo(
    () => new Map(snapshot?.prices.map((p) => [p.itemId, p]) ?? []),
    [snapshot],
  );
  const missing = snapshot?.missing ?? [];
  const freshness = snapshot?.freshness ?? null;
  const nextTradingAt = snapshot?.nextTradingAt ?? null;

  /** Identidade desta aba, estável entre recarregamentos (ver `persist.tabId`). */
  const tabId = useRef<string>("");
  if (tabId.current === "") tabId.current = readTabId();

  /** Tudo o que o ciclo lê, sempre na versão mais recente e sem virar dependência. */
  const deps = useRef({ server, favorites, alerts, notify });
  deps.current = { server, favorites, alerts, notify };

  const nextAtRef = useRef<number | null>(null);
  /** O `tradingAt` do ciclo anterior, para saber se a coleta pousou. */
  const lastTradingAt = useRef<number | null>(null);
  const runningRef = useRef(false);
  /** Ids com preenchimento em voo, para dois cliques seguidos não repetirem o primeiro. */
  const asking = useRef<Set<number>>(new Set());

  /** Devolve `true` quando o retrato lido era o mesmo do ciclo anterior. */
  const tick = useCallback(async (reason: "timer" | "manual" | "visible"): Promise<boolean> => {
    const { server, favorites, alerts, notify } = deps.current;
    const ids = favorites.ids;
    if (ids.length === 0) return false;

    // Ciclos não se sobrepõem: um manual em cima de um do timer gastaria duas requisições
    // para ler o mesmo retrato.
    if (runningRef.current) return false;

    // O clique em "Verificar agora" é ação explícita da pessoa e passa por cima do lease.
    if (reason !== "manual" && !claimLease(localStorage, tabId.current, Date.now())) {
      return false;
    }
    // Offline não queima requisição nem avança o `lastRun` — a idade na tela continua
    // dizendo a verdade sobre quando o dado foi lido de fato.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;

    runningRef.current = true;
    setRunning(true);
    try {
      const res = await batchPrices(ids, 1);
      setSnapshot({
        at: Date.now(),
        prices: res.prices,
        missing: res.missing,
        freshness: res.freshness,
        nextTradingAt: res.nextTradingAt,
      });
      nextAtRef.current = res.nextTradingAt;
      setError(null);
      setLastRun(Date.now());

      const stale = res.freshness.tradingAt === lastTradingAt.current;
      lastTradingAt.current = res.freshness.tradingAt;

      // Sem canal configurado o ciclo ainda vale — ele alimenta a tabela. O que não
      // acontece é avaliar alertas que não teriam para onde ir.
      if (!notify.ready) return stale;
      // Retrato idêntico ao anterior não produz decisão nova. O `lastAlertedPrice` já
      // impediria o aviso repetido; isto evita gastar a volta.
      if (stale && reason === "timer") return stale;

      const plan = planAlerts(server, alerts.all, favorites.set, res.prices);
      if (plan.patches.length > 0) alerts.patchMany(plan.patches);
      if (plan.notifications.length === 0) return stale;

      setFired((prev) => [...plan.notifications, ...prev]);
      await pushAll(notify.config.ntfyTopic, plan.notifications);
      return stale;
    } catch (err) {
      setError(messageOf(err, "Não foi possível checar os preços."));
      return false;
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
    // `setSnapshot` é estável (vem de `usePersistent`, com deps `[key]`), então o ciclo
    // continua sendo uma função só, criada uma vez.
  }, [setSnapshot]);

  /**
   * Completa os favoritos que o retrato ainda não cobre, sem esperar o ciclo.
   *
   * Favoritar não remonta o timer (ver logo abaixo), e faz bem em não remontar — mas até o
   * próximo despertar, que pode estar a meia hora, a linha nova aparecia como `#25697` e
   * uma fileira de travessões, porque a tabela lê tudo do retrato. Recarregar a página
   * "consertava", que é como o problema chegava a quem usa.
   *
   * A condição não é "alguém clicou na estrela", e sim "há favorito fora do retrato" — o
   * que também cobre o id colado no campo, o favorito que veio de outra aba e a linha que
   * um ciclo com erro deixou para trás.
   *
   * Por isso não passa pelo lease: a aba que a pessoa está olhando não pode ficar esperando
   * a aba líder, que pode estar congelada em segundo plano. O preço é um pedido pequeno a
   * mais por aba aberta, e é ele que paga a linha completa na hora.
   */
  const pending =
    // Retrato nenhum é o primeiro carregamento, e aí o ciclo da montagem já vai buscar
    // todos — preencher aqui seria pedir a mesma lista duas vezes.
    snapshot === null
      ? []
      : favorites.ids.filter(
          (id) => !prices.has(id) && !missing.includes(id) && !asking.current.has(id),
        );

  // A dependência do efeito é a chave, e não o array: o retrato muda a cada ciclo, e sem a
  // string estável o mesmo conjunto pendente pediria de novo a cada volta. O efeito remonta
  // a lista a partir dela.
  const pendingKey = pending.join(",");

  useEffect(() => {
    if (pendingKey === "") return;
    const ids = pendingKey.split(",").map(Number);
    // Marcados ANTES do pedido: favoritar oito itens seguidos são oito pedidos de um item,
    // e não oito pedidos com a lista crescendo. Sem isto, cada clique refazia o anterior.
    ids.forEach((id) => asking.current.add(id));

    void batchPrices(ids, 1)
      .then((res) => {
        // Atualizador, e não valor: um ciclo pode ter escrito no meio do caminho, e o
        // retrato dele é mais novo que o `snapshot` que este efeito viu nascer. Nada é
        // cancelado por um pedido novo — dois preenchimentos em voo tratam de ids
        // diferentes, e os dois têm o que acrescentar.
        setSnapshot((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                prices: [...prev.prices.filter((p) => !ids.includes(p.itemId)), ...res.prices],
                missing: [...prev.missing.filter((id) => !ids.includes(id)), ...res.missing],
              },
        );
      })
      // Silencioso de propósito: `error` é o que o ciclo apurou sobre o mercado, e um
      // preenchimento que falhou não muda isso. O ciclo seguinte traz o item de qualquer
      // jeito, e enquanto isso a linha segue com o id, como antes.
      .catch(() => {})
      // A marca vale só pelo pedido em voo. Depois dele o próprio retrato já responde
      // "este eu tenho" — e o item que for desfavoritado e favoritado de novo volta a ser
      // pedido, em vez de ficar marcado para sempre.
      .finally(() => ids.forEach((id) => asking.current.delete(id)));
  }, [pendingKey, setSnapshot]);

  /**
   * O timer liga e desliga com "há favoritos?", e não com QUANTOS há.
   *
   * Com a contagem, favoritar um item derrubava o timer, zerava a contagem de "a coleta
   * mudou?" e disparava uma leitura da lista inteira — marcar oito itens seguidos custava
   * oito varreduras completas, e desmarcar um custava outra, para reler dados que já
   * estavam na mão. O ciclo lê os ids de `deps.current`, então ele já enxerga a lista nova
   * no próximo despertar sem precisar remontar nada.
   */
  const hasFavorites = favorites.ids.length > 0;

  /**
   * O batimento do lease.
   *
   * Separado do ciclo porque as duas coisas têm ritmos muito diferentes: o ciclo dorme até a
   * próxima coleta (dezenas de minutos), o batimento reafirma a cada trinta segundos. Sem
   * ele, uma aba fechada travaria as outras por todo o intervalo de checagem — e não custa
   * nada, é uma escrita no `localStorage`.
   */
  useEffect(() => {
    if (!hasFavorites) return;
    const beat = () => void claimLease(localStorage, tabId.current, Date.now());
    beat();
    const id = window.setInterval(beat, LEASE_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [hasFavorites]);

  /**
   * O timer.
   *
   * Só existe quando há favoritos: sem nenhum, a aba não arma timer nem faz requisição. As
   * dependências são de propósito as duas coisas que mudam a CADÊNCIA — quantos itens há e
   * o intervalo de reserva — e não os dados que o ciclo produz.
   */
  useEffect(() => {
    if (!hasFavorites) return;

    // Trocar de servidor é outro mercado: o retrato anterior não serve de comparação, e
    // sem zerar isto o primeiro ciclo no mercado novo poderia se julgar repetido.
    lastTradingAt.current = null;
    nextAtRef.current = null;

    let cancelled = false;
    let handle: number | undefined;

    const schedule = (stale: boolean) => {
      if (cancelled) return;
      const ms = nextWaitMs({
        nextTradingAt: nextAtRef.current,
        stale,
        nowMs: Date.now(),
        jitter: Math.random(),
      });
      handle = window.setTimeout(() => {
        void tick("timer").then(schedule);
      }, ms);
    };

    // Um ciclo já ao montar: quem abre o app quer ver preço, não esperar a coleta.
    void tick("visible").then(schedule);

    return () => {
      cancelled = true;
      if (handle !== undefined) window.clearTimeout(handle);
    };
    // `server` entra para o mercado novo ser lido na hora, e não só no próximo ciclo — que
    // com meia hora de espera deixaria a tela mostrando os preços do mercado anterior sem
    // nenhum aviso de que trocaram.
  }, [hasFavorites, server, tick]);

  /**
   * Recuperação ao voltar para a aba.
   *
   * O navegador limita o timer a ~1 tique/min em aba oculta e pode congelá-la de vez
   * depois de alguns minutos. Então o timer não é fonte de correção.
   *
   * A condição é "já passou a hora da coleta", e não "faz tempo que não checo": só faz
   * sentido pedir de novo quando pode haver dado novo do outro lado. Voltar para a aba dez
   * vezes em cinco minutos não gera dez requisições.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // `collectionDue` já cobre "nunca checei": sem ciclo concluído, `nextAtRef` é null.
      if (collectionDue(nextAtRef.current, Date.now())) void tick("visible");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [tick]);

  const checkNow = useCallback(() => void tick("manual"), [tick]);
  const dismissFired = useCallback(() => setFired([]), []);

  return {
    favorites,
    alerts,
    notify,
    prices,
    missing,
    freshness,
    nextTradingAt,
    lastRun,
    running,
    error,
    fired,
    dismissFired,
    checkNow,
  };
}

/** Manda os pushes. O que dizer e quando agrupar é decidido em `lib/alerts.ts`. */
async function pushAll(topic: string, notifications: AlertNotification[]): Promise<void> {
  // `allSettled`: um push que falha não pode impedir os outros.
  await Promise.allSettled(
    coalesce(notifications).map((m) =>
      sendNtfy(topic, { ...m, priority: "high", tags: ["moneybag"] }),
    ),
  );
}
