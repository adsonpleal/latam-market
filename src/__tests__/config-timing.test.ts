/**
 * A configuração precisa chegar ao MCP, e não só existir.
 *
 * No Node o módulo era avaliado depois de `process.env` já estar pronto, então capturar
 * `config.publicUrl` no escopo do módulo funcionava. No Worker não: `env` só aparece
 * dentro do `fetch`, muito depois de os módulos serem avaliados. Uma captura no topo
 * congelaria o padrão — e o sintoma seria o agente recebendo a URL errada para mandar o
 * replay, em silêncio, porque `https://mercado.latam-tools.com.br/...` continua sendo uma
 * URL perfeitamente válida.
 *
 * Cada caso reimporta os módulos porque a memoização é por isolate, que é exatamente o
 * comportamento que se quer em produção: dentro de um isolate o ambiente não muda.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("applyEnv chega ao MCP", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("a URL pública do ambiente entra na rota anunciada ao agente", async () => {
    // A ORDEM é o teste. Os módulos são avaliados primeiro, como no arranque de um
    // isolate; só depois o ambiente chega, como no primeiro `fetch`. Com uma captura no
    // escopo do módulo — que é como este código era — as duas asserções abaixo veem o
    // endereço padrão. Importar depois de `applyEnv` passaria dos dois jeitos e não
    // testaria nada.
    const { replayUrl } = await import("../mcp/tools.js");
    const { buildInstructions } = await import("../mcp/server.js");

    const { applyEnv } = await import("../config.js");
    applyEnv({ PUBLIC_URL: "https://exemplo.test" });

    expect(replayUrl()).toBe("https://exemplo.test/api/v1/replay");
    expect(buildInstructions()).toContain("https://exemplo.test/api/v1/replay");
  });

  it("sem ambiente, cai no endereço de produção", async () => {
    const { replayUrl } = await import("../mcp/tools.js");
    expect(replayUrl()).toBe("https://mercado.latam-tools.com.br/api/v1/replay");
  });

  it("a barra sobrando no fim não vira barra dupla", async () => {
    const { replayUrl } = await import("../mcp/tools.js");
    const { applyEnv } = await import("../config.js");
    applyEnv({ PUBLIC_URL: "https://exemplo.test/" });
    expect(replayUrl()).toBe("https://exemplo.test/api/v1/replay");
  });

  it("o teto do lote em lista vem do ambiente", async () => {
    const { applyEnv, config } = await import("../config.js");
    applyEnv({ MAX_BATCH_ITEMS: "7" });
    expect(config.limits.maxBatchItems).toBe(7);
  });

  it("reaplicar o MESMO objeto é no-op; um objeto novo vale", async () => {
    const { applyEnv, config } = await import("../config.js");
    const env = { MAX_RESULTS: "5" };
    applyEnv(env);
    expect(config.limits.maxResults).toBe(5);

    // Mutar o objeto sem trocá-lo não deve custar releitura: é o caminho por requisição.
    (env as Record<string, string>)["MAX_RESULTS"] = "9";
    applyEnv(env);
    expect(config.limits.maxResults).toBe(5);

    applyEnv({ MAX_RESULTS: "9" });
    expect(config.limits.maxResults).toBe(9);
  });
});
