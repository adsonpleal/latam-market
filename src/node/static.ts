/**
 * A interface web, servida do disco.
 *
 * Faz o que o `ASSETS` do Worker fazia, com as regras de `web/public/_headers`:
 *
 *  - `/assets/*` e `/generated/*` levam hash no nome, então são imutáveis por um ano;
 *  - o HTML não pode ser: é ele que aponta para os hashes novos, e um índice cacheado deixa
 *    o navegador pedindo assets que não existem mais — tela branca até limpar o cache;
 *  - qualquer caminho que não é arquivo cai no `index.html` (a SPA), **exceto** caminhos que
 *    parecem arquivo. Um `/assets/x.js` que não existe respondido com o HTML e 200 seria
 *    guardado pela borda como imutável, por um ano, com o conteúdo errado.
 *
 * Os arquivos são indexados uma vez, no boot: um deploy reinicia o processo, então o índice
 * nunca envelhece. Versões `.br`/`.gz` geradas no build são servidas quando o cliente aceita.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

interface Entry {
  abs: string;
  size: number;
  mtimeMs: number;
  type: string;
  br: boolean;
  gz: boolean;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
const COMMON = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

export function staticHandler(root: string): (request: Request, url: URL) => Promise<Response> {
  const index = indexDir(root);

  return async (request, url) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return plain(405, "método não permitido");
    }

    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return plain(400, "caminho inválido");
    }
    if (path.includes("\0") || path.split("/").includes("..")) return plain(400, "caminho inválido");

    const entry = index.get(path) ?? index.get(path.replace(/\/?$/, "/index.html"));
    if (entry) return serve(request, path, entry);

    // Parece arquivo e não existe: 404 de verdade, sem cache. Ver o topo.
    if (path.startsWith("/assets/") || path.startsWith("/generated/") || extname(path) !== "") {
      return new Response("não encontrado", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...COMMON },
      });
    }

    const spa = index.get("/index.html");
    if (!spa) return plain(404, "interface não instalada");
    return serve(request, "/index.html", spa);
  };
}

function serve(request: Request, path: string, entry: Entry): Response {
  const immutable = path.startsWith("/assets/") || path.startsWith("/generated/");
  const etag = `W/"${entry.size.toString(16)}-${Math.floor(entry.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "content-type": entry.type,
    "cache-control": immutable ? IMMUTABLE : REVALIDATE,
    etag,
    vary: "accept-encoding",
    ...COMMON,
  };

  if (!immutable && request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  const accepts = request.headers.get("accept-encoding") ?? "";
  let file = entry.abs;
  if (entry.br && /\bbr\b/.test(accepts)) {
    file += ".br";
    headers["content-encoding"] = "br";
  } else if (entry.gz && /\bgzip\b/.test(accepts)) {
    file += ".gz";
    headers["content-encoding"] = "gzip";
  }
  return new Response(readFileSync(file), { status: 200, headers });
}

function indexDir(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let files: string[];
  try {
    files = walk(root);
  } catch {
    console.error(`[static] ${root} não existe — a interface não será servida`);
    return out;
  }
  const all = new Set(files);
  for (const abs of files) {
    if (abs.endsWith(".br") || abs.endsWith(".gz")) continue;
    const stat = statSync(abs);
    const urlPath = `/${relative(root, abs).split(sep).join("/")}`;
    out.set(urlPath, {
      abs,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      type: TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream",
      br: all.has(`${abs}.br`),
      gz: all.has(`${abs}.gz`),
    });
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...COMMON },
  });
}
