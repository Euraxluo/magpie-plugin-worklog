// magpie 插件入口：宿主加载即起服务；采集器由面板按需触发 + 宿主加载时自动增量一次。
import { startServer } from "./lib/server.mjs";
import { collect } from "./lib/collector.mjs";

const DEFAULT_PORT = 3492;
let current = null;

async function ensureServer(options) {
  const port = Number(options?.port) > 0 && Number(options.port) <= 65535 ? Number(options.port) : DEFAULT_PORT;
  if (current && current.port === port) return current;
  if (current) await current.close().catch(() => null);
  current = await startServer({ options: { port } });
  console.log(`[magpie-plugin-worklog] listening on http://127.0.0.1:${current.port}`);
  // 宿主加载 = magpie 在跑：顺手做一次增量采集（Claude/Codex/omp 新会话入流）
  collect({}).then((r) => { if (r.added) console.log(`[magpie-plugin-worklog] +${r.added} events`); }).catch(() => { });
  return current;
}

ensureServer({ port: DEFAULT_PORT }).catch((e) => console.error("[magpie-plugin-worklog] could not start:", e?.message || e));

export default {
  id: "worklog",
  server: async (input, options) => {
    await ensureServer(options || { port: DEFAULT_PORT }).catch((e) =>
      console.error("[magpie-plugin-worklog] restart failed:", e?.message || e)
    );
    return {};
  },
};
