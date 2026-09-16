/**
 * O laço que consulta o site oficial pelos favoritos e dispara os alertas.
 *
 * **Mora no `App`, não na página `Favoritos`.** O react-router desmonta o elemento da rota
 * ao navegar, então na página o laço morreria ao trocar de aba interna — e alerta que só
 * funciona enquanto se está olhando para ele não serve para nada.
 *
 * **Toda consulta sai do computador da pessoa**, pela conexão na aba do mercado (ver
 * `bridge/bridge.ts`). Por isso tudo passa por uma fila só, uma requisição por vez: a cota
 * (`lib/market/budget.ts`) decide QUANDO a próxima pode sair e a quarentena
 * (`lib/market/quarantine.ts`) decide SE pode. O ciclo automático e o botão "Consultar" de
 * uma linha entram na mesma fila, e o botão não fura a cota — só fura a fila.
 *
 * **O que o ciclo consulta:** os favoritos com alerta ligado no servidor ativo, a cada
 * `intervalMin`. Favorito sem alerta não gasta requisição sozinho; a linha dele fica com a
 * última consulta e um botão para consultar na hora.
 *
 * **Quem roda o ciclo:** a aba que tem a conexão ativa e o lease (`lib/alertLease.ts`). A
 * cota, a quarentena e a hora do último ciclo vivem no `localStorage`, compartilhadas: uma
 * segunda aba, ou um recarregamento, não recomeçam a conta.
 *
 * O relógio é o do worker (`lib/market/ticker.ts`), porque timer de aba em segundo plano é
 * estrangulado — e o laço passa a maior parte da vida em segundo plano. Este hook **não**
 * re-renderiza por tempo: quem mostra idade assina o relógio de `useNow`, para o tique não
 * arrastar a árvore inteira (a tabela do inventário inclusive) a cada volta.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadItems, loadedItems, type ItemIndex } from "../lib/catalogue/catalogue.js";
import type { Server } from "../lib/server.js";
import { claimLease } from "../lib/alertLease.js";
import { coalesce, planAlerts, type AlertNotification, type CheckedItem } from "../lib/alerts.js";
import { time } from "../lib/format.js";
import { WINDOW_CAP, nextSlot, prune, usedInWindow } from "../lib/market/budget.js";
import {
  LOG_SIZE,
  barrenCheck,
  interpret,
  keepFavorites,
  parseChecks,
  parseLog,
  truncatedItems,
  type MarketCheck,
  type RequestLogEntry,
} from "../lib/market/checks.js";
import {
  EMPTY_QUARANTINE,
  activePause,
  clearChallenge,
  parseQuarantine,
  record,
  type Outcome,
  type Pause,
  type PauseKind,
  type Quarantine,
} from "../lib/market/quarantine.js";
import { ticker } from "../lib/market/ticker.js";
import { planQueries, type QueryJob } from "../lib/market/plan.js";
import { checkUrlForTerm } from "../lib/market/url.js";
import { sendNtfy } from "../lib/ntfy.js";
import {
  MARKET_CHECKS_KEY,
  MARKET_GUARD_KEY,
  MARKET_LOG_KEY,
  finiteNumber,
  isRecord,
  safeJson,
  serverItemKey,
  tabId as readTabId,
} from "../lib/persist.js";
import { useAlerts, type AlertsApi } from "./useAlerts.js";
import { useAlertsConfig, type AlertsConfigApi } from "./useAlertsConfig.js";
import { bridgeClient, useBridge, type BridgeApi } from "./useBridge.js";
import { useFavorites, type FavoritesApi } from "./useFavorites.js";
import { useItemIndex } from "./useItemIndex.js";
import { usePersistent } from "./usePersistent.js";

/** A cota, a quarentena e a hora do último ciclo — o que precisa valer entre abas. */
interface Guard {
  starts: number[];
  quarantine: Quarantine;
  lastCycleAt: number | null;
}

const EMPTY_GUARD: Guard = { starts: [], quarantine: EMPTY_QUARANTINE, lastCycleAt: null };

function parseGuard(raw: string | null): Guard | null {
  const g = safeJson(raw);
  if (!isRecord(g)) return null;
  return {
    starts: Array.isArray(g["starts"]) ? g["starts"].filter((t): t is number => finiteNumber(t) !== null) : [],
    quarantine: parseQuarantine(g["quarantine"]),
    lastCycleAt: finiteNumber(g["lastCycleAt"]),
  };
}

const EMPTY_CHECKS: Record<string, MarketCheck> = {};
const EMPTY_LOG: RequestLogEntry[] = [];
const parseChecksRaw = (raw: string | null) => (raw === null ? null : parseChecks(safeJson(raw)));
const parseLogRaw = (raw: string | null) => (raw === null ? null : parseLog(safeJson(raw)));

/** De quanto em quanto tempo o laço confere se é hora de um ciclo. */
const TICK_MS = 15_000;

/**
 * O texto de cada tipo de pausa, por audiência: o selo na aba do mercado e o push.
 *
 * Um `Record` e não ternários espalhados — com um tipo novo de recusa, o compilador aponta
 * cada texto que falta, em vez de o novo cair calado na redação de outro. É a mesma decisão
 * do `WORDING` em `lib/alerts.ts`. A faixa na tela tem texto próprio, com as instruções, em
 * `components/PauseBanner.tsx`.
 */
const PAUSE_WORDING: Record<
  PauseKind,
  { level: "warn" | "error"; badge: (p: Pause) => string; push: (p: Pause) => string }
> = {
  blocked: {
    level: "error",
    badge: (p) => `Bloqueado pelo site (429). Pausado até ${time(p.until!)}.`,
    push: (p) => `O site do mercado bloqueou seu IP (429). Nova tentativa às ${time(p.until!)}.`,
  },
  challenge: {
    level: "error",
    badge: () => "O site pediu verificação. Recarregue esta aba e clique no favorito.",
    push: () =>
      "O site pediu a verificação do Cloudflare. Abra a aba do mercado, resolva e clique no favorito Conectar latam-market.",
  },
  soft: {
    level: "warn",
    badge: (p) => `Respostas sem a lista. Pausado até ${time(p.until!)}.`,
    push: (p) => `O site respondeu sem a lista de anúncios. Nova tentativa às ${time(p.until!)}.`,
  },
};

export interface FavoriteWatch {
  favorites: FavoritesApi;
  alerts: AlertsApi;
  notify: AlertsConfigApi;
  bridge: BridgeApi;
  /** O catálogo, para nomear as linhas. `null` enquanto não chegou. */
  index: ItemIndex | null;
  /** A última consulta de um item neste servidor. */
  checkOf: (itemId: number) => MarketCheck | undefined;
  /**
   * O estado do site, cru.
   *
   * Cru porque "está pausado?" e "quanto já gastei?" dependem da HORA, e quem mostra isso
   * assina o relógio de `useNow` — ler aqui congelaria o número até a próxima mudança de
   * estado. Use `activePause` e `usedInWindow` sobre estes dois.
   */
  quarantine: Quarantine;
  starts: number[];
  /** Favoritos com alerta ligado neste servidor — o que cada ciclo consulta. */
  targets: number[];
  /** Quantas requisições um ciclo dos alertas custa, agrupado. Um por item até o catálogo chegar. */
  cycleRequests: number;
  /** Quantas requisições "atualizar todos" custa, agrupado. */
  allRequests: number;
  /** Itens na fila, na ordem em que vão sair. */
  queue: number[];
  /** Quantas requisições ainda estão na fila (cada uma pode cobrir vários itens). */
  queuedRequests: number;
  /** Itens da requisição em voo. */
  current: number[];
  lastCycleAt: number | null;
  log: RequestLogEntry[];
  fired: AlertNotification[];
  dismissFired: () => void;
  /** Consulta agora todos os itens com alerta, pela fila (a cota continua valendo). */
  checkNow: () => void;
  /** Consulta agora TODOS os favoritos deste servidor, com ou sem alerta. */
  checkAll: () => void;
  /** Consulta um item, na frente da fila. */
  checkItem: (itemId: number) => void;
  /** Esvazia a fila. A consulta em voo termina. */
  cancel: () => void;
  /** Tira a pausa de desafio, depois de a pessoa resolver a verificação no site. */
  retryChallenge: () => void;
}

export function useFavoriteWatch(server: Server): FavoriteWatch {
  const favorites = useFavorites();
  const alerts = useAlerts();
  const notify = useAlertsConfig();
  const bridge = useBridge();
  const { index } = useItemIndex();

  const { value: checks, set: setChecks, peek: peekChecks } = usePersistent(
    MARKET_CHECKS_KEY,
    EMPTY_CHECKS,
    parseChecksRaw,
  );
  // `peek` porque o laço decide o passo seguinte a partir do que acabou de gravar: a cota
  // lida em `guard` ainda não teria a requisição que ele mandou meio milissegundo atrás.
  const { value: guard, set: setGuard, peek: peekGuard } = usePersistent(MARKET_GUARD_KEY, EMPTY_GUARD, parseGuard);
  const { value: log, set: setLog } = usePersistent(MARKET_LOG_KEY, EMPTY_LOG, parseLogRaw);

  const [queue, setQueue] = useState<QueryJob[]>([]);
  const [current, setCurrent] = useState<number[]>([]);
  const [fired, setFired] = useState<AlertNotification[]>([]);

  const tabId = useRef<string>("");
  if (tabId.current === "") tabId.current = readTabId();

  const targets = useMemo(
    () => favorites.ids.filter((id) => alerts.get(server, id)?.enabled === true),
    [favorites.ids, alerts.get, server],
  );

  /**
   * Tudo o que o laço lê, sempre na versão mais recente e sem virar dependência.
   *
   * A ponte fica de fora: `bridgeClient()` é o mesmo objeto por toda a vida da página.
   */
  const deps = useRef({ server, favorites, alerts, notify, targets });
  deps.current = { server, favorites, alerts, notify, targets };

  const queueRef = useRef<QueryJob[]>([]);
  const pumping = useRef(false);
  const syncQueue = () => setQueue([...queueRef.current]);

  /** Texto do selo na aba do mercado: é lá que a pessoa olha para saber o que a aba faz. */
  const reportStatus = useCallback(() => {
    const now = Date.now();
    const g = peekGuard();
    const pause = activePause(g.quarantine, now);
    if (pause !== null) {
      const { badge, level } = PAUSE_WORDING[pause.kind];
      bridgeClient().status(badge(pause), level);
      return;
    }
    const used = usedInWindow(g.starts, now);
    bridgeClient().status(
      `${used}/${WINDOW_CAP} consultas nos últimos 15 min.`,
      used >= WINDOW_CAP ? "warn" : "ok",
    );
  }, [peekGuard]);

  /** Uma pausa começou: avisa no celular, porque quem conta com o push precisa saber que parou. */
  const announcePause = useCallback(() => {
    const { notify } = deps.current;
    const pause = activePause(peekGuard().quarantine, Date.now());
    if (!notify.ready || pause === null) return;
    const { push, level } = PAUSE_WORDING[pause.kind];
    void sendNtfy(notify.config.ntfyTopic, {
      title: "Alertas de preço pausados",
      body: push(pause),
      priority: level === "error" ? "high" : "default",
      tags: ["warning"],
    });
  }, [peekGuard]);

  /**
   * Uma requisição: gasta uma da cota e devolve o que o site disse sobre cada item coberto.
   *
   * Um item que a busca em grupo não trouxe porque a página veio cortada não recebe retrato —
   * volta em `retry`, para ser consultado sozinho, pelo nome inteiro. Os avisos voltam como
   * valor: quem os manda é o `pump`, no fim, agrupados.
   */
  const consult = useCallback(
    async (
      job: QueryJob,
      server: Server,
    ): Promise<{ outcome: Outcome | null; fired: AlertNotification[]; retry: number[] }> => {
      const url = checkUrlForTerm(job.term, server);
      if (url === null) return { outcome: null, fired: [], retry: [] };

      const startedAt = Date.now();
      setGuard((g) => ({ ...g, starts: [...prune(g.starts, startedAt), startedAt] }));
      const res = await bridgeClient().fetch(url);
      const at = Date.now();

      let result: ReturnType<typeof interpret>;
      try {
        result = interpret(res, job.itemIds, at);
      } catch {
        result = { outcome: "error", checks: new Map() };
      }
      const { outcome } = result;

      setGuard((g) => ({ ...g, quarantine: record(g.quarantine, outcome, at) }));
      setLog((prev) =>
        [
          { at: startedAt, term: job.term, items: job.itemIds.length, status: res.status, outcome, ms: at - startedAt },
          ...prev,
        ].slice(0, LOG_SIZE),
      );

      // Uma consulta de um item só já é a do nome inteiro: cortada ali, não há para onde recuar.
      const grouped = job.itemIds.length > 1;
      const retry: number[] = [];
      const written: CheckedItem[] = [];
      const updates: Record<string, MarketCheck> = {};
      for (const [itemId, check] of result.checks) {
        if (check.status === "incomplete" && grouped) {
          retry.push(itemId);
          continue;
        }
        updates[serverItemKey(server, itemId)] = check;
        written.push({ itemId, name: loadedItems()?.get(itemId)?.name ?? `#${itemId}`, check });
      }
      if (written.length === 0) return { outcome, fired: [], retry };

      const { alerts, favorites, notify } = deps.current;
      setChecks((prev) => ({ ...keepFavorites(prev, favorites.set), ...updates }));

      // Sem canal ligado não se avalia: gravar o "já avisei" sem ter avisado faria o alerta
      // calar justamente quando a pessoa ligasse o canal.
      if (!notify.ready) return { outcome, fired: [], retry };
      const plan = planAlerts(server, alerts.all, favorites.set, written);
      if (plan.patches.length > 0) alerts.patchMany(plan.patches);
      return { outcome, fired: plan.notifications, retry };
    },
    [setChecks, setGuard, setLog],
  );

  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    const fired: AlertNotification[] = [];
    try {
      while (queueRef.current.length > 0) {
        if (bridgeClient().state() !== "connected") break;
        const now = Date.now();
        if (activePause(peekGuard().quarantine, now)) break;

        const slot = nextSlot(peekGuard().starts, now);
        if (slot > now) {
          await ticker().sleep(slot - now);
          continue;
        }

        const job = queueRef.current.shift()!;
        syncQueue();
        setCurrent(job.itemIds);
        const { outcome, fired: fromJob, retry } = await consult(job, deps.current.server);
        fired.push(...fromJob);
        setCurrent([]);
        reportStatus();

        if (activePause(peekGuard().quarantine, Date.now())) {
          // Nada de "só mais um item": depois de uma recusa, a próxima requisição é a sonda,
          // e ela só sai quando a pausa acabar. A fila recomeça inteira no próximo ciclo.
          queueRef.current = [];
          syncQueue();
          if (outcome !== null) announcePause();
          break;
        }

        // A página do grupo veio cortada sem estes: cada um vai sozinho, logo em seguida. É o
        // mesmo planejador, com todos marcados para ir sozinhos.
        const index = loadedItems();
        if (retry.length > 0 && index) {
          queueRef.current = [...planQueries(retry, index, new Set(retry)).jobs, ...queueRef.current];
          syncQueue();
        }
      }
    } finally {
      pumping.current = false;
      setCurrent([]);
      if (fired.length > 0) {
        setFired((prev) => [...fired, ...prev]);
        const { notify } = deps.current;
        // `allSettled`: um push que falha não pode impedir os outros.
        await Promise.allSettled(
          coalesce(fired).map((m) => sendNtfy(notify.config.ntfyTopic, { ...m, priority: "high", tags: ["moneybag"] })),
        );
      }
    }
  }, [announcePause, consult, peekGuard, reportStatus]);

  /**
   * Planeja e enfileira. Assíncrono só por esperar o catálogo, que o planejador precisa para
   * medir os termos.
   */
  const enqueue = useCallback(
    async (ids: readonly number[], front: boolean) => {
      const index = await loadItems().catch(() => null);
      if (index === null) return;

      const queued = new Set(queueRef.current.flatMap((j) => j.itemIds));
      const fresh = ids.filter((id) => !queued.has(id));
      if (fresh.length === 0) return;

      const { server } = deps.current;
      const plan = planQueries(fresh, index, truncatedItems(peekChecks(), server));
      if (plan.unsearchable.length > 0) {
        // Nenhuma requisição gasta: não há o que perguntar ao site.
        const at = Date.now();
        setChecks((prev) => {
          const next = { ...prev };
          for (const id of plan.unsearchable) {
            const detail = index.has(id) ? "o nome não vira uma busca que o site aceite" : "item fora do catálogo";
            next[serverItemKey(server, id)] = barrenCheck("unsearchable", at, detail);
          }
          return next;
        });
      }

      queueRef.current = front ? [...plan.jobs, ...queueRef.current] : [...queueRef.current, ...plan.jobs];
      syncQueue();
      void pump();
    },
    [peekChecks, pump, setChecks],
  );

  const cancel = useCallback(() => {
    queueRef.current = [];
    syncQueue();
  }, []);

  // Trocar de servidor é outro mercado: o que estava na fila era para o anterior, e o alvo
  // de cada alerta é por servidor.
  useEffect(() => cancel(), [server, cancel]);

  /** Um ciclo sobre uma lista: marca a hora, para o tique não emendar outro logo depois. */
  const runCycle = useCallback(
    (ids: readonly number[]) => {
      setGuard((g) => ({ ...g, lastCycleAt: Date.now() }));
      void enqueue(ids, false);
    },
    [enqueue, setGuard],
  );

  /** O tique: confere a ponte, o lease e a hora do ciclo. Não faz rede nenhuma sozinho. */
  useEffect(() => {
    const tick = () => {
      const { notify, targets } = deps.current;
      if (bridgeClient().state() !== "connected") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const now = Date.now();
      // Reafirmado a cada tique: é o que distingue "a aba dona está viva" de "foi embora".
      if (!claimLease(localStorage, tabId.current, now)) return;

      // Fila parada por pausa ou ponte que caiu: retoma assim que der.
      if (queueRef.current.length > 0) {
        void pump();
        return;
      }
      if (pumping.current || activePause(peekGuard().quarantine, now)) return;

      const { lastCycleAt } = peekGuard();
      const due = lastCycleAt === null || now - lastCycleAt >= notify.config.intervalMin * 60_000;
      if (due && targets.length > 0) runCycle(targets);
    };

    tick();
    return ticker().every(TICK_MS, tick);
  }, [peekGuard, pump, runCycle]);

  const retryChallenge = useCallback(() => {
    setGuard((g) => ({ ...g, quarantine: clearChallenge(g.quarantine) }));
    void pump();
  }, [pump, setGuard]);

  // A pessoa clicou no favorito de novo na aba do mercado: é o sinal de "resolvi o desafio".
  useEffect(() => bridgeClient().onNewSession(retryChallenge), [retryChallenge]);

  // Ponte conectada ou reconectada: o selo mostra o estado atual, e a fila parada anda.
  useEffect(() => {
    if (bridge.state !== "connected") return;
    reportStatus();
    void pump();
  }, [bridge.state, pump, reportStatus]);

  const checkNow = useCallback(() => runCycle(deps.current.targets), [runCycle]);
  const checkAll = useCallback(() => runCycle(deps.current.favorites.ids), [runCycle]);
  const checkItem = useCallback((itemId: number) => void enqueue([itemId], true), [enqueue]);

  const checkOf = useCallback((itemId: number) => checks[serverItemKey(server, itemId)], [checks, server]);
  const dismissFired = useCallback(() => setFired([]), []);

  /**
   * O custo em requisições das duas ações, calculado uma vez por mudança de lista.
   *
   * O painel mostra os dois números a cada render, e o planejamento varre o catálogo. A chave
   * dos itens cortados é uma string: `checks` muda a cada consulta, mas o conjunto de cortados
   * quase nunca — e só ele muda a conta.
   */
  const soloKey = useMemo(() => [...truncatedItems(checks, server)].sort().join(","), [checks, server]);
  const { cycleRequests, allRequests } = useMemo(() => {
    if (index === null) return { cycleRequests: targets.length, allRequests: favorites.ids.length };
    const solo = new Set(soloKey ? soloKey.split(",").map(Number) : []);
    return {
      cycleRequests: planQueries(targets, index, solo).jobs.length,
      allRequests: planQueries(favorites.ids, index, solo).jobs.length,
    };
  }, [index, targets, favorites.ids, soloKey]);

  const queuedIds = useMemo(() => queue.flatMap((j) => j.itemIds), [queue]);

  return {
    favorites,
    alerts,
    notify,
    bridge,
    index,
    checkOf,
    quarantine: guard.quarantine,
    starts: guard.starts,
    targets,
    cycleRequests,
    allRequests,
    queue: queuedIds,
    queuedRequests: queue.length,
    current,
    lastCycleAt: guard.lastCycleAt,
    log,
    fired,
    dismissFired,
    checkNow,
    checkAll,
    checkItem,
    cancel,
    retryChallenge,
  };
}
