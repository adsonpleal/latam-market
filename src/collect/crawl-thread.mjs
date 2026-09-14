/**
 * A coleta, numa worker thread.
 *
 * O coletor passa a coleta inteira parseando páginas de até mil linhas — trabalho de CPU,
 * síncrono. Na mesma thread da API, cada página seguraria as respostas por dezenas de
 * milissegundos, numa máquina de um núcleo. Aqui ele roda ao lado; a thread principal só
 * recebe os itens prontos e grava.
 *
 * Uma thread por coleta, e não uma para sempre: `terminate()` cancela de verdade uma coleta
 * pendurada (uma promessa nunca resolvida não se cancela), e a memória volta toda entre uma
 * coleta e outra.
 *
 * JavaScript puro, sem importar nada de `src/`: a thread carrega só o coletor, e assim o
 * mesmo arquivo roda no bundle, no `tsx` e nos testes sem passo de build.
 *
 * Mensagens para a thread principal:
 *   { type: "items", batches }   itens completos (ver `collect/port.ts`)
 *   { type: "report", report }   o relatório da coleta
 *   { type: "error", message }   a coleta falhou
 * E dela: { type: "abort" } — o prazo estourou.
 */

import { parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { collectorPath, dataset, server, known } = workerData;
const controller = new AbortController();

parentPort.on("message", (message) => {
  if (message?.type === "abort") controller.abort();
});

const post = (message) => parentPort.postMessage(message);

let collector = null;
try {
  const mod = await import(pathToFileURL(resolve(collectorPath)).href);
  if (typeof mod.createCollector !== "function") {
    throw new Error(`${collectorPath} não exporta createCollector()`);
  }
  collector = await mod.createCollector();
  const report = await collector.crawl({
    dataset,
    server,
    known,
    signal: controller.signal,
    onItems: (batches) => post({ type: "items", batches }),
  });
  post({ type: "report", report });
} catch (err) {
  post({ type: "error", message: err instanceof Error ? err.message : String(err) });
} finally {
  if (collector) {
    // Com teto: um `close()` pendurado seguraria a thread, e quem espera por ela é o
    // agendador inteiro.
    await Promise.race([
      collector.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 30_000).unref()),
    ]);
  }
  // Sem isto a thread não termina: o ouvinte de "abort" mantém a porta aberta, e quem espera
  // a saída dela é o agendador inteiro. As mensagens já enviadas são entregues antes.
  parentPort.close();
}
