/**
 * O prazo da coleta.
 *
 * Regressão de um travamento real (2026-09-07): a `crawl()` do coletor parou de resolver e
 * a promessa ficou pendente para sempre. O `active` do agendador só é limpo no `finally` de
 * quem espera, então nada mais rodou — o processo ficou 34 minutos vivo, com zero socket
 * aberto e 0,2% de CPU, pulando `trading/NIDHOGG` e `market-price/FREYA` com "ainda
 * rodando" e sem coletar mais nada. Sem erro, sem queda, sem dado novo: o pior formato de
 * falha que existe.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { applyEnv, config } from "../../config.js";
import { runCrawl } from "../crawl.js";
import type { ShipTarget } from "../ship.js";

/** Um alvo que ninguém deve alcançar: chegar nele já é o teste falhando. */
const target: ShipTarget = { url: "http://invalido.invalido/ingest", secret: "x" };

let dir: string;

/**
 * O coletor falso mora em disco porque é assim que o de verdade é carregado: `loadCollector`
 * faz `import()` de um caminho, e um mock de módulo não exercitaria esse caminho.
 */
function writeCollector(body: string): string {
  const file = join(dir, `collector-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body, "utf8");
  return file;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "latam-crawl-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("uma coleta que nunca resolve termina pelo prazo, em vez de pendurar o agendador", async () => {
  const path = writeCollector(`
    export async function createCollector() {
      return {
        crawl: () => new Promise(() => {}),   // nunca resolve, nunca rejeita
        close: async () => {},
      };
    }
  `);
  applyEnv({ COLLECTOR_PATH: path });
  expect(config.collectorPath).toBe(path);

  const started = Date.now();
  const outcome = await runCrawl(target, "trading", "FREYA", () => 0, 120);

  // O contrato é o desfecho, não a mensagem: quem chama precisa que a promessa ASSENTE,
  // porque é o assentamento que limpa o `active`.
  expect(outcome.error).toMatch(/sem terminar/);
  expect(outcome.rows).toBe(0);
  expect(outcome.snapshotId).toBeNull();
  expect(Date.now() - started).toBeLessThan(5_000);
});

it("um close travado não segura o desfecho da coleta", async () => {
  const path = writeCollector(`
    export async function createCollector() {
      return {
        crawl: () => new Promise(() => {}),
        close: () => new Promise(() => {}),   // trava também no fechamento
      };
    }
  `);
  applyEnv({ COLLECTOR_PATH: path });

  // O prazo do `close` é uma constante de 30s no módulo; o do crawl é injetado. Este teste
  // prova que o `finally` não é o que trava — se fosse, ele estouraria o timeout do vitest
  // em vez de voltar com o erro da coleta.
  const outcome = await runCrawl(target, "trading", "FREYA", () => 0, 120);
  expect(outcome.error).toMatch(/sem terminar/);
}, 40_000);

it("o prazo não corta uma coleta que termina dentro dele", async () => {
  const path = writeCollector(`
    export async function createCollector() {
      return {
        crawl: async ({ onRows }) => {
          onRows([]);
          return { planned: 0, failures: 0 };
        },
        close: async () => {},
      };
    }
  `);
  applyEnv({ COLLECTOR_PATH: path });

  // Sem rede: o envio falha, e é justamente isso que separa "a coleta passou do prazo" de
  // "a coleta terminou e o POST não foi".
  const outcome = await runCrawl(target, "trading", "FREYA", () => 0, 10_000);
  expect(outcome.error).not.toMatch(/sem terminar/);
  expect(outcome.error).toMatch(/envio falhou/);
});
