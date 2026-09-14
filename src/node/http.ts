/**
 * `node:http` ↔ `Request`/`Response`.
 *
 * Só tradução: a lógica toda está em `app.ts`, que fala Web. Três cuidados que não são
 * tradução pura:
 *
 *  - **a URL sai do cabeçalho `Host`**. `hostAllowed` lê `url.hostname` (é o que o Worker
 *    expunha), então o host tem que estar na URL. O servidor escuta só em 127.0.0.1, e quem
 *    fala com ele é o túnel, que repassa o Host público;
 *  - **o corpo tem teto aqui mesmo**, antes de chegar ao `app`: o Worker tinha limite de
 *    corpo imposto pela plataforma, e um processo Node aceitaria um upload infinito;
 *  - **cliente que desiste aborta a requisição** (`request.signal`), para uma consulta cara
 *    não seguir para ninguém.
 */

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

export interface HttpOptions {
  /** Teto de corpo por caminho. O que não casar usa `defaultBytes`. */
  maxBodyBytes: (pathname: string) => number;
}

export function createNodeServer(
  app: (request: Request) => Promise<Response>,
  opts: HttpOptions,
): Server {
  const server = createServer((req, res) => {
    void handle(app, opts, req, res);
  });
  // O túnel mantém conexões abertas por bastante tempo; um keep-alive curto aqui faria cada
  // requisição dele abrir uma conexão nova.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  return server;
}

async function handle(
  app: (request: Request) => Promise<Response>,
  opts: HttpOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }

    let body: ReadableStream<Uint8Array> | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const limit = opts.maxBodyBytes(url.pathname);
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit) {
        return send(res, method, tooLarge(limit));
      }
      body = limited(Readable.toWeb(req) as ReadableStream<Uint8Array>, limit);
    }

    const request = new Request(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      // Obrigatório para corpo em stream no `fetch` do Node.
      duplex: "half",
    } as RequestInit);

    await send(res, method, await app(request));
  } catch (err) {
    if (controller.signal.aborted) return;
    if (err instanceof BodyTooLarge) {
      if (!res.headersSent) await send(res, "POST", tooLarge(err.limit));
      else res.destroy();
      return;
    }
    console.error("[http] falha na tradução da requisição:", err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ erro: "erro interno" }));
  }
}

async function send(res: ServerResponse, method: string, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  const noBody = method === "HEAD" || response.status === 204 || response.status === 304;
  if (noBody || response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (!res.write(chunk)) await once(res, "drain");
  }
  res.end();
}

class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`corpo maior que ${limit} bytes`);
  }
}

function tooLarge(limit: number): Response {
  return new Response(JSON.stringify({ erro: `corpo maior que o limite de ${limit} bytes` }), {
    status: 413,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Conta os bytes que passam e corta no teto — para corpo sem `content-length`. */
function limited(stream: ReadableStream<Uint8Array>, limit: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > limit) controller.error(new BodyTooLarge(limit));
        else controller.enqueue(chunk);
      },
    }),
  );
}
