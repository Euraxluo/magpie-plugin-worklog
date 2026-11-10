// 数据层：全部走 OpenCode（magpie 引擎）官方 HTTP API，不碰它的库文件。
// 会话搜索:   GET /session?search=关键词&directory=…&limit=…
// 会话消息:   GET /session/{id}/message      → [{info:{role,modelID,time}, parts:[{type,text}]}]
// 引擎生命周期：magpie 里 opencode 常驻（acp）；本插件按需 spawn `opencode serve --port 4099`，
//              用完不杀（下轮复用）；起不来时按只读降级返回错误给 UI。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

const PORT = 4099;
const BASE = `http://127.0.0.1:${PORT}`;
const OPENCODE_BIN = join(os.homedir(), ".opencode/bin/opencode");
const DAY = 86400000;

let serving = null;

async function getJson(path, timeoutMs = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE + path, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function ping() {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 800);
    const r = await fetch(BASE + "/doc", { signal: ctl.signal });
    return r.ok;
  } catch { return false; }
}

export async function ensureServer() {
  if (await ping()) return { ok: true, port: PORT };
  if (!existsSync(OPENCODE_BIN)) return { ok: false, error: "未找到 ~/.opencode/bin/opencode" };
  if (!serving) {
    // cwd 必须是 HOME：opencode serve 的可见会话随 cwd 的项目域走，HOME=全局库
    serving = spawn(OPENCODE_BIN, ["serve", "--port", String(PORT)], {
      stdio: "ignore", detached: false, cwd: os.homedir(),
    });
    serving.on("exit", () => { serving = null; });
  }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ping()) return { ok: true, port: PORT };
  }
  return { ok: false, error: "opencode serve 未在 10s 内就绪" };
}

// 项目域聚合根：opencode serve 只见「cwd 域」的会话——全局域查 HOME，
// 项目域逐根并查。根列表一次引导自库的 distinct directory（人换项目时重引导即可）。
import { execFile } from "node:child_process";
import { execFileSync } from "node:child_process";

function projectRoots() {
  // 引导源：库的 distinct directory（directory 过滤是精确匹配，非前缀递归——必须用完全值）
  const DB = join(os.homedir(), ".local/share/opencode/opencode.db");
  try {
    const out = execFileSync("sqlite3", ["-json", DB, "SELECT DISTINCT directory FROM session LIMIT 300"], { encoding: "utf8", timeout: 8000 });
    const dirs = JSON.parse(out.trim() || "[]").map((r) => r.directory).filter(Boolean);
    const roots = new Set([os.homedir()]);
    for (const d of dirs) {
      if (d === os.homedir() || d.startsWith(join(os.homedir(), "Library"))) continue;
      roots.add(d);
    }
    return [...roots];
  } catch {
    return [os.homedir()];
  }
}

// ---------- 会话搜索（官方接口 + 插件侧模型/时间筛选）----------

export async function searchSessions({ q, model, directory, days, limit = 300 } = {}) {
  const up = await ensureServer();
  if (!up.ok) return up;
  const roots = directory ? [directory] : projectRoots();
  let all = [];
  const seen = new Set();
  for (const root of roots) {
    const params = new URLSearchParams({ limit: "500", directory: root });
    if (q) params.set("search", q);
    let batch;
    try { batch = await getJson(`/session?${params}`, 6000); } catch { continue; }
    for (const s of batch || []) if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
  }
  const sinceMs = days ? Date.now() - days * DAY : 0;
  const hits = all.filter((s) => {
    const upd = (s.time || {}).updated || 0;
    if (sinceMs && upd < sinceMs) return false;
    if (model && !(((s.model || {}).id || "").includes(model) || ((s.model || {}).providerID || "").includes(model))) return false;
    return true;
  }).slice(0, limit);
  return {
    ok: true,
    total: all.length,
    sessions: hits.map((s) => ({
      id: s.id,
      title: s.title || "(无题)",
      at: new Date((s.time || {}).updated || 0).toISOString(),
      created: (s.time || {}).created || 0,
      project: (s.directory || "").replace(os.homedir() + "/", ""),
      model: (s.model || {}).id || "",
      provider: (s.model || {}).providerID || "",
      cost: Number(s.cost || 0),
      tokens: ((s.tokens || {}).input || 0) + ((s.tokens || {}).output || 0),
    })),
  };
}

// ---------- 模型用量（会话维度，全走官方接口）----------

export async function modelsUsage({ days } = {}) {
  const r = await searchSessions({ days });
  if (!r.ok) return r;
  const by = new Map();
  for (const s of r.sessions) {
    const k = s.model || "(未标)";
    if (!by.has(k)) by.set(k, { model: k, provider: s.provider, sessions: 0, msgs: 0, tokens: 0, cost: 0 });
    const e = by.get(k);
    e.sessions += 1;
    e.tokens += s.tokens;
    e.cost += s.cost;
  }
  return { ok: true, models: [...by.values()].sort((a, b) => b.sessions - a.sessions) };
}

// ---------- 会话消息（正文，用于时间线与周报上下文）----------

export async function sessionEvents({ q, model, directory, days, maxSessions = 40, limit = 400 } = {}) {
  const sr = await searchSessions({ q, model, directory, days, limit: maxSessions });
  if (!sr.ok) return sr;
  const out = [];
  for (const s of [...sr.sessions].sort((a, b) => a.created - b.created)) {
    let msgs = [];
    try { msgs = await getJson(`/session/${s.id}/message`, 8000); } catch { continue; }
    for (const m of msgs) {
      const info = m.info || {};
      const text = (m.parts || []).filter((p) => p.type === "text").map((p) => p.text || "").join("\n").trim();
      if (!text || text.startsWith("<")) continue;
      out.push({
        id: info.id,
        at: new Date(((info.time || {}).created) || s.created || 0).toISOString(),
        role: info.role || "?",
        model: info.modelID || s.model,
        project: s.project,
        title: s.title,
        text: text.slice(0, 2000),
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { ok: true, events: out };
}

// ---------- 上下文打包 ----------

export async function buildContext({ q, model, directory, days = 7, maxTokens = 24000 } = {}) {
  const r = await sessionEvents({ q, model, directory, days });
  if (!r.ok) return r;
  const byDay = new Map();
  for (const e of r.events) {
    const day = e.at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const lines = [];
  let budget = maxTokens;
  const daysArr = [...byDay.keys()];
  const perDayAsst = Math.max(4, Math.floor(maxTokens / 30 / Math.max(1, daysArr.length)));
  for (const day of daysArr) {
    const evs = byDay.get(day);
    const users = evs.filter((e) => e.role === "user");
    const asst = evs.filter((e) => e.role === "assistant").slice(0, perDayAsst);
    lines.push(`## ${day}`);
    for (const e of [...users.slice(-6), ...asst]) {
      const t = `[${e.at.slice(11, 16)}][${e.role}${e.model ? "/" + e.model : ""}] ${e.project ? `(${e.project}) ` : ""}${e.text.replace(/\s+/g, " ").slice(0, 400)}`;
      const cost = Math.ceil(t.length / 2.2);
      if (cost > budget) continue;
      budget -= cost;
      lines.push(t);
    }
  }
  return { ok: true, context: lines.join("\n"), count: r.events.length, tokens: Math.ceil(lines.join("\n").length / 2.2) };
}

export async function health() {
  const up = await ping();
  return { ok: up, base: BASE, bin: OPENCODE_BIN, serving: !!serving };
}
