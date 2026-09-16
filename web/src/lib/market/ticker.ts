/**
 * `sleep` e `every` sobre o relógio de `ticker.worker.ts`.
 *
 * Sem `Worker` (os testes, um navegador muito restrito) cai no `setTimeout` comum — que
 * funciona igual com a aba à vista, e só perde precisão em segundo plano.
 */

export interface Ticker {
  sleep(ms: number): Promise<void>;
  /** Chama `fn` a cada `ms`. Devolve quem cancela. */
  every(ms: number, fn: () => void): () => void;
}

type Timer = (ms: number, fn: () => void) => () => void;

function workerTimer(): Timer | null {
  if (typeof Worker === "undefined") return null;
  try {
    const worker = new Worker(new URL("./ticker.worker.ts", import.meta.url), { type: "module" });
    const callbacks = new Map<number, () => void>();
    let nextId = 1;
    worker.onmessage = (event: MessageEvent<number>) => {
      const fn = callbacks.get(event.data);
      callbacks.delete(event.data);
      fn?.();
    };
    return (ms, fn) => {
      const id = nextId++;
      callbacks.set(id, fn);
      worker.postMessage({ id, ms });
      return () => {
        callbacks.delete(id);
        worker.postMessage({ id, cancel: true });
      };
    };
  } catch {
    return null;
  }
}

const plainTimer: Timer = (ms, fn) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

let shared: Ticker | null = null;

/** Um relógio só para a página inteira: um worker basta para qualquer quantidade de timers. */
export function ticker(): Ticker {
  if (shared) return shared;
  const timer = workerTimer() ?? plainTimer;
  shared = {
    sleep: (ms) => new Promise((resolve) => void timer(Math.max(0, ms), resolve)),
    every(ms, fn) {
      let cancel = timer(ms, tick);
      let stopped = false;
      function tick() {
        if (stopped) return;
        fn();
        cancel = timer(ms, tick);
      }
      return () => {
        stopped = true;
        cancel();
      };
    },
  };
  return shared;
}
