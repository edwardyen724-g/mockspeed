#!/usr/bin/env node
// dev — the web app on this machine, against the real store.
//
//   node web/dev.mjs [--port 8790] [--env <file>]...
//
// The same handler as on Vercel (web/app.mjs), behind Node's http server. Settings come from the
// environment first, then web/.env.local, then each --env file (the model keys live in one of
// those; see web/README.md). Nothing is printed of them but which are set.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { app } from "./app.mjs";

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1] || 0) || 8790;
const files = [new URL("./.env.local", import.meta.url).pathname, ...args.flatMap((a, i) => (args[i - 1] === "--env" ? [resolve(a)] : []))];
const env = { ...process.env };
for (const f of files) {
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && env[m[1]] == null) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const handle = app(env);

createServer(async (req, res) => {
  try {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body, duplex: "half" });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => {
  const on = (k) => (env[k] ? "set" : "missing");
  console.error(`web: http://localhost:${PORT}  ·  store ${on("SUPABASE_URL")}/${on("MS_SERVER_KEY")}  ·  jev ${on("TYPESAFE_API_KEY")}  ·  writer ${env.WRITER_PROVIDER || "anthropic"} ${on(env.WRITER_PROVIDER === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY")}  ·  admins ${on("ADMIN_EMAILS")}`);
});
