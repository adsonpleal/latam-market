/**
 * O adaptador `node:http` ↔ `Request`/`Response`, com socket de verdade.
 *
 * Os testes de rota rodam em processo (`parity.test.ts`); aqui o que se prova é só a
 * tradução — onde um servidor HTTP escrito à mão costuma errar calado.
 */

import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNodeServer } from "../http.js";
import { staticHandler } from "../static.js";

let base: string;
let close: () => void;
let dir: string;
let lastUrl = "";
let aborted = false;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "latam-static-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<html>spa</html>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "assets", "app.js.gz"), gzipSync("console.log(1)"));
  const files = staticHandler(dir);

  const server = createNodeServer(
    async (request) => {
      const url = new URL(request.url);
      lastUrl = request.url;
      if (url.pathname === "/eco") {
        return new Response(await request.text(), { headers: { "x-host": url.host } });
      }
      if (url.pathname === "/lento") {
        request.signal.addEventListener("abort", () => (aborted = true));
        await new Promise((r) => setTimeout(r, 500));
        return new Response("tarde");
      }
      if (url.pathname === "/json") return Response.json({ ok: true });
      return files(request, url);
    },
    { maxBodyBytes: (p) => (p === "/eco" ? 16 : 1024) },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

/** `fetch` não deixa escolher o Host; o túnel manda o público, então o teste também manda. */
function raw(path: string, opts: { method?: string; host?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = httpRequest(
        `${base}${path}`,
        { method: opts.method ?? "GET", headers: { host: opts.host ?? "mercado.latam-tools.com.br", ...opts.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    },
  );
}

describe("createNodeServer", () => {
  it("a URL carrega o host do cabeçalho — é dele que a allowlist lê", async () => {
    const res = await raw("/eco", { method: "POST", body: "oi", host: "mercado.latam-tools.com.br" });
    expect(res.body).toBe("oi");
    expect(res.headers["x-host"]).toBe("mercado.latam-tools.com.br");
    expect(lastUrl).toBe("http://mercado.latam-tools.com.br/eco");
  });

  it("corpo acima do teto é 413, declarado ou não", async () => {
    expect((await raw("/eco", { method: "POST", body: "x".repeat(40) })).status).toBe(413);
    const chunked = await raw("/eco", {
      method: "POST",
      body: "x".repeat(40),
      headers: { "transfer-encoding": "chunked" },
    });
    expect(chunked.status).toBe(413);
  });

  it("HEAD não leva corpo", async () => {
    const res = await raw("/json", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
  });

  it("cliente que desiste aborta a requisição", async () => {
    aborted = false;
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${base}/lento`, { headers: { host: "mercado.latam-tools.com.br" } });
      req.on("error", () => resolve());
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBe(true);
  });
});

describe("staticHandler", () => {
  it("serve a SPA para caminho que não é arquivo", async () => {
    const res = await raw("/item/501");
    expect(res.status).toBe(200);
    expect(res.body).toContain("spa");
    expect(res.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
  });

  it("arquivo que não existe é 404, nunca o HTML — a borda o guardaria por um ano", async () => {
    const res = await raw("/assets/nao-existe.js");
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("asset é imutável e sai comprimido quando o cliente aceita", async () => {
    const res = await raw("/assets/app.js", { headers: { "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/immutable/);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("recusa .. escondido atrás de barra codificada", async () => {
    // `..` e `%2e%2e` a própria URL já normaliza antes de chegar aqui. `%2f` não: só vira
    // barra no `decodeURIComponent`, e é aí que um `..` apareceria.
    expect((await raw("/assets/..%2f..%2fsegredo")).status).toBe(400);
  });
});
