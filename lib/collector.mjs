// collector：把三类本地 coding agent 会话 + git 提交归一成 agent 无关事件流。
// 设计目标：录制与生成解耦——不管你明天换什么 agent/模型，周报上下文都在这里。
//
// 数据源（只读，绝不写 agent 自己的存储）：
//   claude: ~/.claude/projects/**/*.jsonl           —— 每行一条消息事件
//   codex:  ~/.codex/sessions/**/rollout-*.jsonl[.zst] —— 每行一个 response item
//   omp:    ~/.omp/agent/sessions/**/*.jsonl        —— omp 会话转写
//   git:    ~/project ~/projects 下的仓库 git log（按作者/时间过滤）
//
// 归一事件: { id, source, kind, at, cwd/project, text, refs }
// 去重：每个源文件记录 (path, size, mtime, byteOffset)，增量只读新增字节。
// 落库：~/.config/magpie-plugin-worklog/store.jsonl（事件流）+ state.json（采集游标）。
import { readdir, readFile, stat, open, mkdir, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { join, dirname, relative } from "node:path";
import os from "node:os";

const HOME = os.homedir();
const STORE_DIR = join(HOME, ".config/magpie-plugin-worklog");
const STORE = join(STORE_DIR, "store.jsonl");
const STATE = join(STORE_DIR, "state.json");
const SOURCES = {
  claude: join(HOME, ".claude/projects"),
  codex: join(HOME, ".codex/sessions"),
  omp: join(HOME, ".omp/agent/sessions"),
};
const GIT_ROOTS = [join(HOME, "project"), join(HOME, "projects")];
// 全量重扫上限（保护首次入库别把机器跑死）
const MAX_EVENT_BYTES = 256 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function run(file, args, timeoutMs = 15000, cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
    });
  });
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ---------- 游标 ----------

async function loadState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch { return { files: {}, git: {} }; }
}

async function saveState(st) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STATE, JSON.stringify(st));
}

async function appendEvents(events) {
  if (!events.length) return 0;
  await mkdir(STORE_DIR, { recursive: true });
  const fh = await open(STORE, "a");
  try {
    const buf = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fh.write(buf);
  } finally { await fh.close(); }
  return events.length;
}

// ---------- 文件枚举 ----------

async function walkJsonl(root, out = []) {
  if (!existsSync(root)) return out;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) await walkJsonl(p, out);
    else if (e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst"))) out.push(p);
  }
  return out;
}

async function readTail(path, offset) {
  // 返回 [newText, newSize]；文件被截断（轮转/重写）时返回 null 表示需要全量重读
  const st = await stat(path);
  if (st.size < offset) return null;
  if (st.size === offset) return ["", st.size];
  const fh = await open(path, "r");
  try {
    const len = Math.min(st.size - offset, MAX_EVENT_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, offset);
    return [buf.toString("utf8"), st.size];
  } finally { await fh.close(); }
}

// ---------- 归一化：每源一条 parser ----------

function parseClaudeLine(line, file) {
  // Claude Code: {"type":"user"|"assistant", "message":{...}, "cwd", "timestamp", ...}
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type !== "user" && d.type !== "assistant") return null;
  const m = d.message || {};
  let c = m.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c.filter((x) => x && x.type === "text").map((x) => x.text || "").join("\n");
  }
  text = (text || "").trim();
  if (!text || text.startsWith("<")) return null; // 系统注入/工具结果不带正文
  const proj = d.cwd ? relative(HOME, d.cwd) : projectFromClaudePath(file);
  return {
    id: sha1(`claude|${d.uuid || ""}|${text.slice(0, 200)}`),
    source: "claude",
    kind: d.type === "user" ? "prompt" : "reply",
    at: d.timestamp || fileMtimeFallback(file),
    project: proj || "",
    text: text.slice(0, 2000),
  };
}

function projectFromClaudePath(file) {
  // ~/.claude/projects/-Users-echo-project-foo/bar.jsonl → project/foo
  const m = file.match(/\.claude\/projects\/-Users-[^/]+-(.+)\/[^/]+$/);
  if (!m) return "";
  return m[1].replace(/-/g, "/");
}

function fileMtimeFallback() { return now(); }

function parseOmpLine(line, file) {
  // omp: {"type":"user"|"assistant","message":{"content":[...]}}
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  if (d.type !== "user" && d.type !== "assistant") return null;
  const m = d.message || {};
  let text = "";
  const c = m.content;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter((x) => x && x.type === "text").map((x) => x.text || "").join("\n");
  text = (text || "").trim();
  if (!text || text.startsWith("<")) return null;
  return {
    id: sha1(`omp|${d.sessionId || ""}|${text.slice(0, 200)}`),
    source: "omp",
    kind: d.type === "user" ? "prompt" : "reply",
    at: d.timestamp || d.at || now(),
    project: d.cwd ? relative(HOME, d.cwd) : "",
    text: text.slice(0, 2000),
  };
}

function parseCodexLine(line, file) {
  // Codex rollout: {"timestamp":..., "type":"response_item", "payload":{...}} 或旧版直接 payload
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const p = d.payload || d;
  // 用户消息: payload.type === "user_msg"（或 message.role=user）
  // 助手文本: payload.type === "agent_message" / message.role=assistant content 字符串
  let kind = null, text = "";
  // codex 0.167: payload.type === "message", role user/assistant,
  // content 是 [{type:"input_text"|"output_text", text}]；过滤系统注入（AGENTS.md/environment_context 等）
  const flat = (x) => {
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return x.map((i) => (typeof i === "string" ? i : i?.text || "")).join("\n");
    return "";
  };
  const stripEnv = (t) => t.split("\n").filter((ln) =>
    !/^\s*<(app-context|environment_context|INSTRUCTIONS|user_instructions|permissions|appc)[ >]/i.test(ln) &&
    !/^\s*# (AGENTS\.md|Codex 工作约定)/.test(ln)
  ).join("\n");
  if (p.role === "user" || p.type === "user_msg") {
    kind = "prompt"; text = stripEnv(flat(p.content ?? p.message ?? p.text));
  } else if (p.role === "assistant" || p.type === "agent_message") {
    kind = "reply"; text = flat(p.content ?? p.text ?? p.message);
  }
  text = (text || "").trim();
  if (!kind || !text || text.startsWith("<")) return null;
  const cwd = p.cwd || d.cwd || "";
  return {
    id: sha1(`codex|${d.id || ""}|${text.slice(0, 200)}`),
    source: "codex",
    kind,
    at: d.timestamp || now(),
    project: cwd ? relative(HOME, cwd) : "",
    text: text.slice(0, 2000),
  };
}

// zstd 解压（只对新增完整文件做一次；增量场景 codex 文件是追加型 jsonl，直接读）
async function decodeMaybeZst(path, text) {
  if (!path.endsWith(".zst")) return text;
  const r = await run("/opt/homebrew/bin/zstdcat", [path], 30000);
  return r.code === 0 ? r.out : "";
}

// ---------- 采集 ----------

const PARSERS = { claude: parseClaudeLine, codex: parseCodexLine, omp: parseOmpLine };

export async function collect({ full = false } = {}) {
  const st = await loadState();
  const events = [];
  let scanned = 0, added = 0;

  for (const [name, root] of Object.entries(SOURCES)) {
    const files = await walkJsonl(root);
    for (const f of files) {
      const stt = await stat(f).catch(() => null);
      if (!stt) continue;
      const prev = full ? null : st.files[f];
      if (prev && prev.size === stt.size && prev.mtimeMs === stt.mtimeMs) continue; // 没变
      scanned++;

      if (f.endsWith(".zst")) {
        // 压缩文件没法增量：内容 hash 相同就跳过
        const text = await decodeMaybeZst(f);
        const h = sha1(text);
        if (st.files[f] && st.files[f].hash === h) { st.files[f] = { ...stt.size ? { size: stt.size } : {}, mtimeMs: stt.mtimeMs, hash: h }; continue; }
        for (const line of text.split("\n")) {
          const e = PARSERS[name](line, f);
          if (e) events.push(e);
        }
        st.files[f] = { size: stt.size, mtimeMs: stt.mtimeMs, hash: h };
        continue;
      }

      const offset = prev ? prev.offset : 0;
      const r = await readTail(f, offset);
      if (!r) { // 全量重读
        const text = await readFile(f, "utf8").catch(() => "");
        for (const line of text.split("\n")) {
          const e = PARSERS[name](line, f);
          if (e) events.push(e);
        }
        st.files[f] = { size: (await stat(f)).size, mtimeMs: (await stat(f)).mtimeMs, offset: (await stat(f)).size };
      } else {
        const [text, newSize] = r;
        // 只处理完整行：末尾不完整的行留到下次（offset 回退到最后一个 \n）
        const lastNl = text.lastIndexOf("\n");
        const whole = lastNl >= 0 ? text.slice(0, lastNl) : "";
        for (const line of whole.split("\n")) {
          const e = PARSERS[name](line, f);
          if (e) events.push(e);
        }
        st.files[f] = { size: newSize, mtimeMs: stt.mtimeMs, offset: offset + lastNl + 1 };
      }
    }
  }

  // 去重（同 id 只留一条）
  const seen = new Set();
  const fresh = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  added = await appendEvents(fresh);
  await saveState(st);
  return { scanned, added, sources: Object.keys(SOURCES) };
}

// ---------- git 提交 ----------

export async function collectGit(sinceIso) {
  const since = sinceIso || new Date(Date.now() - 30 * 86400e3).toISOString();
  const out = [];
  for (const root of GIT_ROOTS) {
    if (!existsSync(root)) continue;
    let dirs;
    try { dirs = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of dirs) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const repo = join(root, e.name);
      if (!existsSync(join(repo, ".git"))) continue;
      const r = await run("git", ["log", `--since=${since}`, "--all", "--pretty=format:%H%x09%h%x09%aI%x09%s", "--no-merges"], 10000, repo);
      if (r.code !== 0) continue;
      for (const line of r.out.split("\n")) {
        if (!line.trim()) continue;
        const [h, short, at, subj] = line.split("\t");
        out.push({ id: `git-${h.slice(0, 12)}`, source: "git", kind: "commit", at, project: relative(HOME, repo), text: subj, refs: { sha: short } });
      }
    }
  }
  return out;
}

// ---------- 查询 ----------

export async function query({ since, until, sources, project, q, limit = 500 } = {}) {
  if (!existsSync(STORE)) return [];
  const sinceTs = since ? Date.parse(since) : 0;
  const untilTs = until ? Date.parse(until) : Infinity;
  const srcSet = sources?.length ? new Set(sources) : null;
  const ql = q?.toLowerCase();
  const out = [];
  const text = await readFile(STORE, "utf8").catch(() => "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i];
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(e.at);
    if (!(ts >= sinceTs && ts <= untilTs)) continue;
    if (srcSet && !srcSet.has(e.source)) continue;
    if (project && !e.project?.toLowerCase().includes(project.toLowerCase())) continue;
    if (ql && !e.text?.toLowerCase().includes(ql)) continue;
    out.push(e);
  }
  return out; // 新→旧
}

export async function stats() {
  const events = await query({ limit: 100000 });
  const by = {};
  for (const e of events) {
    const k = `${e.source}/${e.kind}`;
    by[k] = (by[k] || 0) + 1;
  }
  const st = await loadState();
  return { total: events.length, by, trackedFiles: Object.keys(st.files || {}).length, store: STORE, at: now() };
}
