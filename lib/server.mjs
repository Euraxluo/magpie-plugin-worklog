// 宝盒哨兵同款骨架：本地服务 + Host/Origin 白名单，无 token（本机自用）。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { collect, query, stats } from "./collector.mjs";
import { generate, listRunners, buildContext } from "./report.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PORT = 3492;

let OWN = new Set();
let HOSTS = new Set();
let appHtml = null;

function originAllowed(req) {
  const o = req.headers.origin;
  return o === undefined || o === "null" || OWN.has(o);
}
function hostAllowed(req) {
  return HOSTS.has(String(req.headers.host || "").toLowerCase());
}
function corsHeaders(req) {
  const o = req.headers?.origin;
  const allow = o && OWN.has(o) ? o : "null";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    vary: "Origin",
  };
}
function send(req, res, code, body, type = "application/json; charset=utf-8", cors = true) {
  const data = typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body);
  const headers = {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(cors ? corsHeaders(req) : {}),
  };
  res.writeHead(code, headers);
  res.end(data);
}
async function readBody(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (!hostAllowed(req)) return send(req, res, 403, { error: "Host 不对" });
  if (p === "/api/ping") return send(req, res, 200, { ok: true, name: "magpie-plugin-worklog", version: "0.1.0" });
  if (!originAllowed(req)) return send(req, res, 403, { error: "Origin 不允许" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (req.method === "GET" && p === "/api/stats") return send(req, res, 200, await stats());

  if (req.method === "GET" && p === "/api/events") {
    const q = u.searchParams;
    return send(req, res, 200, await query({
      since: q.get("since") || undefined,
      until: q.get("until") || undefined,
      sources: q.get("sources")?.split(",").filter(Boolean),
      project: q.get("project") || undefined,
      q: q.get("q") || undefined,
      limit: Math.min(Number(q.get("limit")) || 300, 1000),
    }));
  }

  if (req.method === "GET" && p === "/api/runners") return send(req, res, 200, await listRunners());

  if (req.method === "POST" && p === "/api/collect") {
    const body = await readBody(req);
    return send(req, res, 200, await collect({ full: body.full === true }));
  }

  if (req.method === "POST" && p === "/api/context-preview") {
    const body = await readBody(req);
    const since = new Date(Date.now() - (body.days || 7) * 86400e3).toISOString();
    const events = await query({ since, limit: 2000 });
    return send(req, res, 200, { tokens: Math.ceil(buildContext(events).length / 2.2), text: buildContext(events, { maxTokens: body.maxTokens || 24000 }).slice(0, 6000) });
  }

  if (req.method === "POST" && p === "/api/generate") {
    const body = await readBody(req);
    return send(req, res, 200, await generate(body));
  }

  return send(req, res, 404, { error: "no route " + p });
}

async function loadAppHtml() {
  if (!appHtml) appHtml = await readFile(join(here, "app.html"), "utf8");
  return appHtml;
}

export async function startServer({ options } = {}) {
  const port = Number(options?.port) > 0 ? Number(options.port) : DEFAULT_PORT;
  HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  OWN = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "null"]);
  appHtml = null;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/" || u.pathname === "/index.html") {
      if (!hostAllowed(req)) return send(req, res, 403, { error: "Host 不对" });
      loadAppHtml()
        .then((html) => send(req, res, 200, html, "text/html; charset=utf-8", false))
        .catch((e) => send(req, res, 500, { error: e.message }));
      return;
    }
    if (u.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    handle(req, res).catch((e) => {
      try { send(req, res, 500, { error: String(e?.message || e) }); } catch { /* 已响应 */ }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return { port, close: () => new Promise((r) => server.close(r)) };
}
