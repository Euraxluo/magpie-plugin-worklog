// magpie 引擎直查：本地 OpenCode 库（~/.local/share/opencode/opencode.db）就是权威数据源。
// 不再自建 jsonl 采集——magpie 自身已把所有会话（含 model/provider/cost/tokens）存进库里，
// 插件只做「查询 + 筛选 + 上下文打包」，零复制、零游标、天然增量。
//
// 视角：
//   events   —— 消息级时间线（role/model/project/text），供周报上下文与时间线 UI
//   models   —— 模型/引擎用量统计（你上周用过哪些模型、各多少条、多少 session）
//   sessions —— 会话级列表（title/model/cost/tokens/项目）
import { execFile } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const DB = join(os.homedir(), ".local/share/opencode/opencode.db");

function sql(query, subs = {}) {
  // sqlite3 CLI 不吃占位符参数：调用方保证只内联 Number()/转义后的值（本机自用，无外部输入）
  const q = query.replace(/\{(\w+)\}/g, (_, k) => String(subs[k]));
  return new Promise((resolve) => {
    if (!existsSync(DB)) return resolve({ ok: false, rows: [], error: "no opencode.db" });
    const args = ["-json", DB, q];
    execFile("sqlite3", args, { timeout: 15000, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, rows: [], error: String(stderr || err.message).slice(0, 300) });
      let rows = [];
      try { rows = stdout.trim() ? JSON.parse(stdout) : []; } catch { rows = []; }
      resolve({ ok: true, rows });
    });
  });
}

const DAY = 86400000;

// ---------- 事件时间线（消息级）----------

export async function events({ days = 7, model, provider, project, role, q, limit = 300 } = {}) {
  const subs = { since: Math.trunc(Date.now() - days * DAY), limit: Math.trunc(Math.min(limit, 2000)) };
  const esc = (s) => String(s).replace(/'/g, "''");
  const conds = ["m.time_created >= {since}"];
  if (model) { conds.push("COALESCE(json_extract(m.data,'$.modelID'), json_extract(s.metadata,'$.model.id')) LIKE '%" + esc(model) + "%'"); }
  if (provider) { conds.push("COALESCE(json_extract(m.data,'$.providerID'), json_extract(s.metadata,'$.model.providerID')) LIKE '%" + esc(provider) + "%'"); }
  if (role) { conds.push("json_extract(m.data,'$.role') = '" + esc(role) + "'"); }
  if (project) { conds.push("(s.directory LIKE '%" + esc(project) + "%' OR s.title LIKE '%" + esc(project) + "%')"); }
  if (q) { conds.push("m.data LIKE '%" + esc(q) + "%'"); }

  const where = conds.join(" AND ");
  const { ok, rows, error } = await sql(`
    SELECT m.id, m.time_created,
           json_extract(m.data,'$.role') AS role,
           json_extract(m.data,'$.modelID') AS model,
           json_extract(m.data,'$.providerID') AS provider,
           json_extract(m.data,'$.path.cwd') AS cwd,
           s.title AS session_title, s.directory AS session_dir,
           -- 会话内最近一次 assistant 消息的模型：给 user 消息回填模型维度（模型筛选用）
           (SELECT json_extract(m2.data,'$.modelID') FROM message m2
              WHERE m2.session_id = m.session_id
                AND json_extract(m2.data,'$.role') = 'assistant'
                AND m2.time_created <= m.time_created
              ORDER BY m2.time_created DESC LIMIT 1) AS session_model,
           (SELECT group_concat(json_extract(p.data,'$.text'), char(10))
              FROM part p WHERE p.message_id = m.id
               AND json_extract(p.data,'$.type') = 'text') AS text
    FROM message m JOIN session s ON s.id = m.session_id
    WHERE ${where}
    ORDER BY m.time_created DESC
    LIMIT {limit}`, subs);

  if (!ok) return { ok, events: [], error };
  const out = rows
    .map((r) => ({
      id: r.id,
      at: new Date(Number(r.time_created)).toISOString(),
      role: r.role || "?",
      model: r.model || r.session_model || "",
      provider: r.provider || "",
      project: (r.cwd || r.session_dir || "").replace(os.homedir() + "/", "") || r.session_title?.slice(0, 30) || "",
      title: r.session_title || "",
      text: (r.text || "").split("\n").filter(Boolean).join("\n").slice(0, 2000),
    }))
    .filter((e) => e.text && !e.text.startsWith("<"));
  return { ok: true, events: out };
}

// ---------- 模型用量 ----------

export async function models({ days = 7 } = {}) {
  const since = Date.now() - days * DAY;
  const { ok, rows, error } = await sql(`
    SELECT COALESCE(json_extract(m.data,'$.modelID'), json_extract(s.metadata,'$.model.id')) AS model,
           COALESCE(json_extract(m.data,'$.providerID'), json_extract(s.metadata,'$.model.providerID')) AS provider,
           COUNT(*) AS msgs,
           COUNT(DISTINCT m.session_id) AS sessions
    FROM message m JOIN session s ON s.id = m.session_id
    WHERE m.time_created >= {since} AND json_extract(m.data,'$.role') = 'assistant'
    GROUP BY model, provider ORDER BY msgs DESC LIMIT 50`, { since: Math.trunc(since) });
  if (!ok) return { ok, models: [], error };
  return { ok: true, models: rows.map((r) => ({ model: r.model || "(未标)", provider: r.provider || "?", msgs: r.msgs, sessions: r.sessions })) };
}

// ---------- 会话列表 ----------

export async function sessions({ days = 7, limit = 100 } = {}) {
  const since = Date.now() - days * DAY;
  const { ok, rows, error } = await sql(`
    SELECT s.id, s.title, s.time_created, s.time_updated, s.cost,
           s.tokens_input, s.tokens_output, s.directory,
           COALESCE(json_extract(s.metadata,'$.model.id'), '') AS model
    FROM session s
    WHERE s.time_updated >= {since}
    ORDER BY s.time_updated DESC LIMIT {limit}`, { since: Math.trunc(since), limit: Math.trunc(Math.min(limit, 500)) });
  if (!ok) return { ok, sessions: [], error };
  return {
    ok: true,
    sessions: rows.map((r) => ({
      id: r.id, title: r.title || "(无题)",
      at: new Date(Number(r.time_updated)).toISOString(),
      project: (r.directory || "").replace(os.homedir() + "/", ""),
      model: r.model || "",
      cost: Number(r.cost || 0),
      tokens: Number(r.tokens_input || 0) + Number(r.tokens_output || 0),
    })),
  };
}

// ---------- 上下文打包（周报用）----------

export async function buildContext({ days = 7, model, provider, project, maxTokens = 24000 } = {}) {
  const { events: evs } = await events({ days, model, provider, project, limit: 2000 });
  const byDay = new Map();
  for (const e of evs) {
    const day = e.at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const lines = [];
  let budget = maxTokens;
  const days2 = [...byDay.keys()];
  const perDayAsst = Math.max(4, Math.floor(maxTokens / 30 / Math.max(1, days2.length)));
  for (const day of days2) {
    const evs2 = byDay.get(day);
    const users = evs2.filter((e) => e.role === "user");
    const asst = evs2.filter((e) => e.role === "assistant").slice(0, perDayAsst);
    lines.push(`## ${day}`);
    for (const e of [...users.slice(-8), ...asst]) {
      const t = `[${e.at.slice(11, 16)}][${e.role}${e.model ? "/" + e.model : ""}] ${e.project ? `(${e.project}) ` : ""}${e.text.replace(/\s+/g, " ").slice(0, 400)}`;
      const cost = Math.ceil(t.length / 2.2);
      if (cost > budget) continue;
      budget -= cost;
      lines.push(t);
    }
  }
  return { context: lines.join("\n"), count: evs.length, tokens: Math.ceil(lines.join("\n").length / 2.2) };
}

export async function health() {
  const { ok, error } = await sql("SELECT COUNT(*) n FROM message");
  const m = await models({ days: 1 }).catch(() => ({ models: [] }));
  return { ok, db: DB, error: error || null, models24h: m.models?.length ?? 0 };
}
