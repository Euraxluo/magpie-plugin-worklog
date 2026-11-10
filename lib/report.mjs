// 生成器：从归一事件流出周报草稿。
// 关键设计：agent 无关。三种执行器——
//   codex exec / claude -p / local（纯模板，不调任何模型，保底）
// 随时切换，事件流不变。上下文按 token 预算裁剪（prompt 优先，reply 采样）。
import { execFile } from "node:child_process";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectGit, query } from "./collector.mjs";

const HOME = os.homedir();
const OUT_DIR = join(HOME, ".config/magpie-plugin-worklog/reports");

function run(file, args, timeoutMs, input) {
  return new Promise((resolve) => {
    const p = execFile(file, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, input }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
    });
    if (input) p.stdin?.end(input);
  });
}

// ---------- 上下文打包（裁剪到预算内）----------

function estimateTokens(n) { return Math.ceil(n / 2.2); } // 中英混排粗估

export function buildContext(events, { maxTokens = 24000 } = {}) {
  const prompts = events.filter((e) => e.kind === "prompt");
  const others = events.filter((e) => e.kind !== "prompt");
  // 时间正序、按天分桶
  const byDay = new Map();
  for (const e of [...prompts, ...others].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const day = e.at.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  // prompt 全保，reply 每天最多采样 N 条（预算不够就从 reply 尾部开始丢）
  const lines = [];
  let budget = maxTokens;
  const days = [...byDay.keys()];
  const perDayReply = Math.max(2, Math.floor(budget / 40 / Math.max(1, days.length)));
  for (const day of days) {
    const evs = byDay.get(day);
    const ps = evs.filter((e) => e.kind === "prompt");
    const rs = evs.filter((e) => e.kind !== "prompt").slice(-perDayReply);
    lines.push(`## ${day}`);
    for (const e of [...ps, ...rs]) {
      const t = `[${e.at.slice(11, 16)}][${e.source}][${e.kind}] ${e.project ? `(${e.project}) ` : ""}${e.text.replace(/\s+/g, " ").slice(0, 400)}`;
      const cost = estimateTokens(t.length);
      if (cost > budget) continue;
      budget -= cost;
      lines.push(t);
    }
  }
  return lines.join("\n");
}

const SYSTEM_HINT = `你是周报助手。根据下面的工作事件流水（来自本地 coding agent 会话与 git 提交的归一记录），
产出一份中文周报：
- 按主题归类（不要逐条罗列），每个主题给 1-3 句结论性描述
- 突出：做了什么、改了什么文件/仓库、解决了什么问题
- 结尾给「下周可继续」清单
- 只用给定材料，不编造`;

// ---------- 三种执行器 ----------

export const runners = {
  codex: {
    label: "Codex CLI",
    available: async () => (await run("which", ["codex"], 3000)).code === 0,
    models: ["默认(config.toml)", "group/glm-5.3", "group/gpt-6.1-sol"],
    async gen(ctx, { model } = {}) {
      // codex exec [OPTIONS] [PROMPT]：`-` 从 stdin 读；模型用 -c model= 传（exec 下 -m 必须在子命令前）
      const args = ["exec", "--skip-git-repo-check"];
      if (model && !model.startsWith("默认")) args.push("-c", `model=\"${model}\"`);
      args.push("-");
      const r = await run("codex", args, 300000, `${SYSTEM_HINT}\n\n<events>\n${ctx}\n</events>`);
      if (r.code !== 0) return { ok: false, text: r.out + r.err };
      // 输出末尾带 tokens used 统计，剪掉
      const cut = r.out.lastIndexOf("\ntokens used");
      return { ok: true, text: cut > 0 ? r.out.slice(0, cut) : r.out };
    },
  },
  claude: {
    label: "Claude Code CLI",
    available: async () => (await run("which", ["claude"], 3000)).code === 0,
    models: ["默认(settings)", "sonnet", "opus", "haiku", "group/gemini-3-8-flash[1m]"],
    async gen(ctx, { model } = {}) {
      const args = ["-p", "--output-format", "text"];
      if (model && !model.startsWith("默认")) args.unshift("--model", model);
      const r = await run("claude", args, 300000, `${SYSTEM_HINT}\n\n<events>\n${ctx}\n</events>`);
      return { ok: r.code === 0, text: r.out || r.err };
    },
  },
  local: {
    label: "本地模板（不调模型）",
    available: async () => true,
    models: ["—"],
    async gen(ctx) {
      // 保底：按天/项目分组的结构化摘要，零模型依赖
      const lines = ctx.split("\n");
      const byProj = new Map();
      for (const l of lines) {
        const m = l.match(/^\[(\d{2}:\d{2})\]\[(\w+)\]\[(\w+)\]\]? ?\(([^)]*)\) ?(.*)/) || l.match(/^\[(\d{2}:\d{2})\]\[(\w+)\]\[(\w+)\] ?(.*)/);
        if (!m) continue;
        if (!m) {
          if (/^[^#>]/.test(l) && l.trim()) {
            if (!byProj.has("(未分组)")) byProj.set("(未分组)", []);
            byProj.get("(未分组)").push(l.slice(0, 80));
          }
          continue;
        }
        // 两种匹配：带 (project) 的 5 组，或不带的（m[4] 是正文）
        const proj = m[5] !== undefined ? (m[4] || "(无项目)") : "(无项目)";
        const text = (m[5] !== undefined ? m[5] : m[4]) || "";
        if (!byProj.has(proj)) byProj.set(proj, []);
        byProj.get(proj).push(text.slice(0, 80));
      }
      const out = ["# 周报（本地模板版）", ""];
      for (const [p, items] of byProj) {
        out.push(`## ${p}`);
        out.push(...items.slice(0, 8).map((t) => `- ${t}`));
        out.push("");
      }
      out.push("> 提示：切换到 Codex/Claude CLI 可获得真正的归纳式周报（本模式不调模型）。");
      return { ok: true, text: out.join("\n") };
    },
  },
};

// ---------- 入口 ----------

export async function generate({ days = 7, runner = "local", model, maxTokens } = {}) {
  const since = new Date(Date.now() - days * 86400e3).toISOString();
  const events = await query({ since, limit: 2000 });
  const commits = await collectGit(since);
  const ctx = buildContext([...events, ...commits], { maxTokens });
  const r = runners[runner] || runners.local;
  const res = await r.gen(ctx, { model });
  if (!res.ok) return { ok: false, error: res.text.slice(0, 500), ctxPreview: ctx.slice(0, 1500) };

  await mkdir(OUT_DIR, { recursive: true });
  const at = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17);
  const file = join(OUT_DIR, `weekly-${at}.md`);
  await writeFile(file, `<!-- runner=${runner} model=${model || "default"} events=${events.length} commits=${commits.length} at=${new Date().toISOString()} -->\n\n${res.text}\n`);
  return { ok: true, file, events: events.length, commits: commits.length, text: res.text.slice(0, 4000) };
}

export async function listRunners() {
  const out = {};
  for (const [k, r] of Object.entries(runners)) out[k] = { label: r.label, available: await r.available().catch(() => false), models: r.models };
  return out;
}
