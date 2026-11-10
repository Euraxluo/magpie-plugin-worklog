// 数据层：调 magpie 自己的会话搜索接口（/api/sessions/search），搜索对象是
// claude / codex / omp / opencode 各 CLI 的会话存储 —— magpie 已经替我们把
// 四家 agent 的会话都索引好了，插件只做调用方 + 筛选器。
//
// 引擎生命周期：magpie web --addr 127.0.0.1:3495 --no-open（带 MAGPIE_WEB_KEY），
// 插件按需拉起并常驻复用；?k= 换会话 cookie 后走 /api/*。
// 这就是「magpie 的搜索会话接口」，与窗口 UI 同一套（assetserver 内部路由的 web 形态）。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const ADDR = "127.0.0.1:3495";
const BASE = `http://${ADDR}`;
const MAGPIE_BIN = "/Applications/magpie.app/Contents/MacOS/magpie";
const WEB_KEY_FILE = join(os.homedir(), ".config/magpie-plugin-worklog/web.key");
const COOKIE = "magpie_web_3495";
const DAY = 86400000;

let proc = null;
let cookieValue = null;

async function key() {
  try {
    const t = (await readFile(WEB_KEY_FILE, "utf8")).trim();
    if (t.length >= 16) return t;
  } catch { /* 生成一次 */ }
  const t = "wl-" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 14);
  await mkdir(join(os.homedir(), ".config/magpie-plugin-worklog"), { recursive: true });
  await writeFile(WEB_KEY_FILE, t + "\n", { mode: 0o600 });
  return t;
}

async function fetchJson(path, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, {
      signal: ctl.signal,
      headers: cookieValue ? { cookie: `${COOKIE}=${cookieValue}` } : {},
    });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
    catch { return { ok: false, status: res.status, error: text.slice(0, 200) }; }
  } catch (e) {
    return { ok: false, error: String(e?.cause?.code || e?.message || e) };
  } finally { clearTimeout(t); }
}

async function alive() {
  const r = await fetchJson("/api/sessions/search?agent=claude&q=__ping__", 6000).catch(() => null);
  return !!r?.ok;
}

export async function ensureServer() {
  if (cookieValue && (await alive())) return { ok: true, base: BASE };
  if (!existsSync(MAGPIE_BIN)) return { ok: false, error: "未找到 magpie 应用" };
  if (!proc) {
    const k = await key();
    proc = spawn(MAGPIE_BIN, ["web", "--addr", ADDR, "--no-open"], {
      stdio: "ignore", detached: false, env: { ...process.env, MAGPIE_WEB_KEY: k },
    });
    proc.on("exit", () => { proc = null; cookieValue = null; });
  }
  const k = await key();
  // cookie 值就是 key 本身（实测 set-cookie: magpie_web_3495=<key>）；等端口起来即可
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/?k=${encodeURIComponent(k)}`, { redirect: "manual" });
      if (res.status === 303 || res.status === 200) { cookieValue = k; break; }
    } catch { /* 还没起 */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  if (!cookieValue) return { ok: false, error: "magpie web 会话建立失败" };
  return { ok: true, base: BASE };
}

// magpie 会话索引实测覆盖（2026-11-10 探测：agent=<id>&q=the）：
// claude 131 · codex 2753 · omp 1435 · opencode 501 · cursor 426 · zcode 114 ·
// workbuddy 49 · antigravity 5 · qoder 4 · grok 7 · dsh 7；其余 22 家 agent 名下 0（装了没聊过）
const AGENTS = ["claude", "codex", "omp", "opencode", "cursor", "zcode", "workbuddy", "grok", "dsh", "antigravity", "qoder"];

// ---------- 会话搜索（magpie 官方接口）----------

export async function searchSessions({ q = "", agents, limit = 200 } = {}) {
  let up = await ensureServer();
  if (!up.ok) return up;
  const list = (agents?.length ? agents : AGENTS).filter((a) => AGENTS.includes(a));
  const out = [];
  const meta = {};
  for (const agent of list) {
    // 各 agent 索引规模不同（codex 2753 条要秒级），串行 + 60s；401 重登一次再试
    let r = await fetchJson(`/api/sessions/search?agent=${agent}&q=${encodeURIComponent(q)}&limit=${Math.min(limit, 500)}`, 60000);
    if (r.status === 401) {
      cookieValue = null;
      up = await ensureServer();
      if (!up.ok) return up;
      r = await fetchJson(`/api/sessions/search?agent=${agent}&q=${encodeURIComponent(q)}&limit=${Math.min(limit, 500)}`, 60000);
    }
    if (!r.ok) { meta[agent] = { error: r.error || r.status }; continue; }
    const d = r.json || {};
    meta[agent] = { searched: d.searched || 0, total: d.total || 0, cut: !!d.cut };
    for (const h of d.hits || []) {
      out.push({
        agent,
        id: h.id,             // 会话 id（与各 CLI 存储同构）
        role: h.role || "",
        kind: h.kind || "",
        text: `${h.before ?? ""}${h.match ?? ""}${h.after ?? ""}`.slice(0, 500),
      });
    }
  }
  return { ok: true, base: BASE, meta, hits: out.slice(0, limit) };
}

// ---------- 引擎用量（各 agent 会话规模）----------

export async function agentsUsage() {
  // 单字母查询被当空：用通用词 the 拿各 agent 的 total 规模
  const r = await searchSessions({ q: "the", limit: 1 });
  if (!r.ok) return r;
  return {
    ok: true,
    models: AGENTS.map((a) => ({
      model: a, provider: "magpie-sessions",
      sessions: r.meta?.[a]?.total ?? 0, msgs: r.meta?.[a]?.searched ?? 0,
    })),
  };
}

export async function buildContext({ q, agents, maxTokens = 24000 } = {}) {
  const r = await searchSessions({ q, agents, limit: 400 });
  if (!r.ok) return r;
  const lines = [];
  let budget = maxTokens;
  const byAgent = new Map();
  for (const h of r.hits) {
    if (!byAgent.has(h.agent)) byAgent.set(h.agent, []);
    byAgent.get(h.agent).push(h);
  }
  lines.push(`搜索: ${q || "(全量)"} · 来源 ${[...byAgent.keys()].join("/")}`);
  for (const [agent, hits] of byAgent) {
    lines.push(`## ${agent}（命中 ${hits.length}）`);
    for (const h of hits.slice(0, 120)) {
      const t = `[${h.role}/${h.kind}] …${h.text.replace(/\s+/g, " ").slice(0, 300)}`;
      const cost = Math.ceil(t.length / 2.2);
      if (cost > budget) break;
      budget -= cost;
      lines.push(t);
    }
  }
  return { ok: true, context: lines.join("\n"), count: r.hits.length, tokens: Math.ceil(lines.join("\n").length / 2.2) };
}

export async function health() {
  const ok = cookieValue ? await alive() : false;
  return { ok, base: BASE, running: !!proc || ok, agents: AGENTS };
}
