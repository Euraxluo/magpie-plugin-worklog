// 独立跑（调试用）：node serve.mjs
import { startServer } from "./lib/server.mjs";

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3492;
const info = await startServer({ options: { port } });
console.log(`worklog service on http://127.0.0.1:${info.port}`);
