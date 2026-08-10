/** O canal do ntfy. A cadência de checagem não se configura — ver `lib/schedule.ts`. */

import { useCallback } from "react";

import {
  ALERTS_CONFIG_KEY,
  DEFAULT_ALERTS_CONFIG,
  parseAlertsConfig,
  type AlertsConfig,
} from "../lib/persist.js";
import { usePersistent } from "./usePersistent.js";

export interface AlertsConfigApi {
  config: AlertsConfig;
  update: (patch: Partial<AlertsConfig>) => void;
  /** O canal está de fato utilizável — ligado E com tópico preenchido. */
  ready: boolean;
}

export function useAlertsConfig(): AlertsConfigApi {
  const { value: config, set: write } = usePersistent(
    ALERTS_CONFIG_KEY,
    DEFAULT_ALERTS_CONFIG,
    parseAlertsConfig,
  );

  const update = useCallback(
    (patch: Partial<AlertsConfig>) => write((prev) => ({ ...prev, ...patch })),
    [write],
  );

  return { config, update, ready: config.ntfyEnabled && config.ntfyTopic.trim() !== "" };
}
