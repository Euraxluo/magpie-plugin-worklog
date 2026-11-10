// 生成器：从归一事件流出周报草稿。
// 关键设计：agent 无关。三种执行器——
//   codex exec / claude -p / local（纯模板，不调任何模型，保底）
// 随时切换，事件流不变。上下文按 token 预算裁剪（prompt 优先，reply 采样）。
import { execFile } from "node:child_process";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildContext } from "./collector.mjs";

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
        const m = l.match(/^\[\d{2}:\d{2}\]\[([^\]]+)\] ?\(([^)]*)\) ?(.*)/) || l.match(/^\[\d{2}:\d{2}\]\[([^\]]+)\] ?(.*)/);
        if (!m) continue;
        if (!m) {
          if (/^[^#>]/.test(l) && l.trim()) {
            if (!byProj.has("(未分组)")) byProj.set("(未分组)", []);
            byProj.get("(未分组)").push(l.slice(0, 80));
          }
          continue;
        }
        const proj = m[2] && m[3] !== undefined ? (m[2] || "(无项目)") : (m[2] || "(无项目)");
        const text = (m[3] !== undefined ? m[3] : m[2]) || "";
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

export async function generate({ days = 7, runner = "local", model, filterModel, provider, project, maxTokens } = {}) {
  const { context, count } = await buildContext({ days, model: filterModel, provider, project, maxTokens });
  const r = runners[runner] || runners.local;
  const res = await r.gen(context, { model });
  if (!res.ok) return { ok: false, error: res.text.slice(0, 500), ctxPreview: context.slice(0, 1500) };

  await mkdir(OUT_DIR, { recursive: true });
  const at = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 17);
  const file = join(OUT_DIR, `weekly-${at}.md`);
  await writeFile(file, `<!-- runner=${runner} model=${model || "default"} events=${count} filter=${filterModel || "all"} at=${new Date().toISOString()} -->\n\n${res.text}\n`);
  return { ok: true, file, events: count, text: res.text.slice(0, 4000) };
}

export async function listRunners() {
  const out = {};
  for (const [k, r] of Object.entries(runners)) out[k] = { label: r.label, available: await r.available().catch(() => false), models: r.models };
  return out;
}
