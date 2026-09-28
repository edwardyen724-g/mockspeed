#!/usr/bin/env node
// trial — the canvas, with the mock as a tree of primitives instead of a list of widgets.
//
//   node trial/server.mjs [mock.outline] [--port 8772] [--env <file>] [--out <file>] [--model <id>]
//                         [--build-model <id>] [--provider anthropic|openrouter]
//
// The http shell over trial/engine.mjs, which holds everything a canvas is — its mock, undo, the
// question waiting on the person, the offers, the log — once per project. The project at / opens the
// outline given here and is the one trial/eval drives; /p/new makes another at /p/<id>/, with the
// same page and the same routes under it, so two tabs edit two mocks without touching each other.
// Projects live as long as the process. Runs beside canvas/ so the two can be compared.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, serialize } from "./tree.mjs";
import { builderPrompt, exportHtml, fileName } from "./export.mjs";
import { project } from "./engine.mjs";
import { mockPage, shell } from "./page.mjs";
import { MODEL, BUILD_MODEL } from "./writer.mjs";
import * as W from "./words.mjs";

// ---- args and keys -----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(flag("--port", 8772));
const START = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? null;
const OUT = flag("--out", "trial.outline");
const LLM = flag("--model", MODEL);
const BUILD = flag("--build-model", BUILD_MODEL);
// The writer provider switch (writer.mjs PROVIDERS): OpenRouter takes OPENROUTER_API_KEY.
const PROVIDER = flag("--provider", "anthropic");
const envFile = flag("--env", process.env.TYPESAFE_ENV_FILE);
// Keys are read, never printed, and sent only to their own API.
const readKey = (name) => {
  if (process.env[name]) return process.env[name];
  if (!envFile) return null;
  try {
    const line = readFileSync(resolve(envFile), "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : null;
  } catch { return null; }
};
const apiKey = readKey("TYPESAFE_API_KEY");
const llmKey = readKey(PROVIDER === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY");

// ---- projects ----------------------------------------------------------------------------
// One engine per project id. An id the server has not seen gets an empty canvas, so a tab left open
// across a restart carries on with an empty one, as the single canvas always did.
const DEFAULT = "default";
const projects = new Map();
const open = (id, root = null) => {
  if (!projects.has(id)) projects.set(id, project({ root, apiKey, llmKey, model: LLM, buildModel: BUILD, provider: PROVIDER }));
  return projects.get(id);
};
// A saved outline (from "save spec") can be opened again; its parser warnings are logged, not fatal.
if (START) {
  const opened = parse(readFileSync(resolve(START), "utf8"));
  if (opened.warnings.length) console.error(`trial: ${START}: ${opened.warnings.length} parser warnings`);
  open(DEFAULT, opened.root);
} else open(DEFAULT);
// "save spec" writes each project to its own file: trial.outline for the one at /, trial-<id>.outline
// for the others.
const outOf = (id) => (id === DEFAULT ? OUT : OUT.replace(/(\.[^./]*)?$/, (ext) => `-${id}${ext}`));
const PROJECT_ID = /^[a-z0-9-]{1,40}$/i;

// ---- http --------------------------------------------------------------------------------
const json = (res, body, code = 200) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } }); });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // /p/<id>/<route> is project <id>'s; every other path is the default project's. The page asks
    // with relative paths, so the same page works at / and at /p/<id>/.
    let id = DEFAULT, route = url.pathname;
    const at = route.match(/^\/p\/([^/]*)(\/.*)?$/);
    if (at) {
      if (at[1] === "" || at[1] === "new") {
        res.writeHead(302, { location: `/p/${randomBytes(4).toString("hex")}/${url.search}`, "cache-control": "no-store" });
        return res.end();
      }
      if (!PROJECT_ID.test(at[1])) return res.writeHead(404).end("not found");
      if (!at[2]) { res.writeHead(302, { location: `/p/${at[1]}/${url.search}` }); return res.end(); }
      id = at[1];
      route = at[2];
    }
    const p = open(id);
    if (route === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(shell());
    }
    if (route === "/mock") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(mockPage(p.root));
    }
    if (route === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (v) => res.write(`data: ${JSON.stringify(v)}\n\n`);
      send(p.version);
      req.on("close", p.subscribe(send));
      return;
    }
    if (route === "/state") return json(res, { ...p.state(), out: outOf(id) });
    if (route === "/tools") return json(res, p.tools(url.searchParams.get("id")));
    if (route === "/edit" && req.method === "POST") return json(res, p.edit(await body(req)));
    if (route === "/ask" && req.method === "POST") return json(res, await p.ask(await body(req)));
    if (route === "/answer" && req.method === "POST") return json(res, await p.answer(await body(req)));
    if (route === "/swap" && req.method === "POST") return json(res, await p.swap(await body(req)));
    if (route === "/undo" && req.method === "POST") return json(res, p.undo(await body(req)));
    if (route === "/new" && req.method === "POST") return json(res, p.startAgain());
    if (route === "/save" && req.method === "POST") {
      writeFileSync(resolve(outOf(id)), serialize(p.root));
      return json(res, { note: W.reply.saved(outOf(id)), changed: false });
    }
    // Export: the mock as one file, and the prompt for an AI site builder — as text to copy or as a
    // file. Both are built by code from what is on the canvas now; nothing is written here.
    if (route === "/export.html" || route === "/export.md" || route === "/prompt") {
      const html = route === "/export.html";
      const head = { "content-type": `${html ? "text/html" : route === "/prompt" ? "text/plain" : "text/markdown"}; charset=utf-8`, "cache-control": "no-store" };
      if (route !== "/prompt") head["content-disposition"] = `attachment; filename="${fileName(p.root, html ? "html" : "md")}"`;
      res.writeHead(200, head);
      return res.end(html ? exportHtml(p.root) : builderPrompt(p.root));
    }
    if (route === "/spec") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end(serialize(p.root));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    json(res, { note: W.reply.error, debug: e.message, changed: false, error: true }, 500);
  }
});
// --port 0 takes any free port; the line says which (trial/test/server.test.mjs reads it).
server.listen(PORT, () => {
  console.error(`trial: http://localhost:${server.address().port}  ·  another project: /p/new  ·  jev ${apiKey ? "on" : "off (no key)"}  ·  writer ${llmKey ? `${PROVIDER === "anthropic" ? "" : PROVIDER + " "}${BUILD} builds, ${LLM} pieces` : "off (no key)"}  ·  save → ${OUT}`);
});
