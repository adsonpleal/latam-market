/**
 * Os alertas, chaveados por `servidor:item`.
 *
 * A regra de rearme não mora aqui: está em `applyAlertPatch`, puro e testado. O hook só
 * guarda e avisa quem estiver ouvindo.
 */

import { useCallback } from "react";

import type { Server } from "../api/client.js";
import { applyAlertPatch } from "../lib/alerts.js";
import { ALERTS_KEY, alertKey, parseAlerts, type Alert, type Alerts } from "../lib/persist.js";
import { usePersistent } from "./usePersistent.js";

const EMPTY: Alerts = {};

export interface AlertsApi {
  all: Alerts;
  get: (server: Server, itemId: number) => Alert | undefined;
  set: (server: Server, itemId: number, patch: Partial<Alert>) => void;
  /** Aplica vários patches numa escrita só — é o que o laço usa ao fim de um ciclo. */
  patchMany: (patches: Array<{ key: string; patch: Partial<Alert> }>, create?: boolean) => void;
  remove: (server: Server, itemId: number) => void;
  /** Quantos estão ligados neste servidor, para o cabeçalho e a barra de notificações. */
  enabledCount: (server: Server) => number;
}

export function useAlerts(): AlertsApi {
  const { value: all, set: write } = usePersistent(ALERTS_KEY, EMPTY, parseAlerts);

  /**
   * Aplica patches numa escrita só.
   *
   * `create` separa "configurar um alerta" de "registrar um disparo": sem ele, um patch do
   * laço para um alerta removido no meio do ciclo o recriaria do nada. O corte de
   * re-render vem de `applyAlertPatch` devolver a MESMA referência quando nada muda — o
   * caso comum, já que a maioria dos ciclos não move alerta nenhum.
   */
  const patchMany = useCallback(
    (patches: Array<{ key: string; patch: Partial<Alert> }>, create = false) => {
      if (patches.length === 0) return;
      write((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const { key, patch } of patches) {
          const current = next[key];
          if (!current && !create) continue;
          const merged = applyAlertPatch(current, patch);
          if (merged === current) continue;
          next[key] = merged;
          changed = true;
        }
        return changed ? next : prev;
      });
    },
    [write],
  );

  const set = useCallback(
    (server: Server, itemId: number, patch: Partial<Alert>) =>
      patchMany([{ key: alertKey(server, itemId), patch }], true),
    [patchMany],
  );

  const remove = useCallback(
    (server: Server, itemId: number) => {
      const key = alertKey(server, itemId);
      write((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _removido, ...rest } = prev;
        return rest;
      });
    },
    [write],
  );

  const get = useCallback((server: Server, itemId: number) => all[alertKey(server, itemId)], [all]);

  const enabledCount = useCallback(
    (server: Server) =>
      Object.entries(all).filter(([key, alert]) => alert.enabled && key.startsWith(`${server}:`))
        .length,
    [all],
  );

  return { all, get, set, patchMany, remove, enabledCount };
}
