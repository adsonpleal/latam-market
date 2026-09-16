/**
 * Um relógio compartilhado, para quem só mostra idade na tela.
 *
 * "Consultado há 3 min" e a contagem regressiva de uma pausa precisam re-renderizar sozinhos,
 * sem nada ter mudado. Fazer isso com estado no `useFavoriteWatch` — que mora no `App` —
 * re-renderizava a árvore inteira a cada tique, inclusive a tabela do inventário, que pode
 * ter milhares de linhas e nada a ver com o assunto.
 *
 * Aqui cada intervalo tem uma fonte só, e quem assina re-renderiza apenas o próprio nó.
 */

import { useSyncExternalStore } from "react";

interface Clock {
  now: number;
  listeners: Set<() => void>;
  handle: ReturnType<typeof setInterval> | null;
}

const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = { now: Date.now(), listeners: new Set(), handle: null };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

/**
 * O relógio, em milissegundos, que anda de `intervalMs` em `intervalMs`.
 *
 * O timer só existe enquanto alguém assina: sem ninguém olhando a idade, nada bate.
 */
export function useNow(intervalMs: number): number {
  const clock = clockFor(intervalMs);

  return useSyncExternalStore(
    (onChange) => {
      clock.listeners.add(onChange);
      clock.handle ??= setInterval(() => {
        clock.now = Date.now();
        for (const fn of clock.listeners) fn();
      }, intervalMs);
      return () => {
        clock.listeners.delete(onChange);
        if (clock.listeners.size === 0 && clock.handle !== null) {
          clearInterval(clock.handle);
          clock.handle = null;
        }
      };
    },
    () => clock.now,
    () => clock.now,
  );
}
