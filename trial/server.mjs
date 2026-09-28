#!/usr/bin/env node
// trial — the canvas, with the mock as a tree of primitives instead of a list of widgets.
//
//   node trial/server.mjs [mock.outline] [--port 8772] [--env <file>] [--out <file>] [--model <id>]
//
// The http shell over trial/engine.mjs, which holds everything a canvas is — its mock, undo, the
// question waiting on the person, the offers, the log — once per project. The project at / opens the
// outline given here and is the one trial/eval drives; /p/new makes another at /p/<id>/, with the
// same page and the same routes under it, so two tabs edit two mocks without touching each other.
// Projects live as long as the process. Runs beside canvas/ so the two can be compared.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { parse, serialize } from "./tree.mjs";
import { render } from "./render.mjs";
import { builderPrompt, exportHtml, fileName } from "./export.mjs";
import { project } from "./engine.mjs";
import { MODEL } from "./writer.mjs";
import * as W from "./words.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args and keys -----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(flag("--port", 8772));
const START = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? null;
const OUT = flag("--out", "trial.outline");
const LLM = flag("--model", MODEL);
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
const llmKey = readKey("ANTHROPIC_API_KEY");

// ---- projects ----------------------------------------------------------------------------
// One engine per project id. An id the server has not seen gets an empty canvas, so a tab left open
// across a restart carries on with an empty one, as the single canvas always did.
const DEFAULT = "default";
const projects = new Map();
const open = (id, root = null) => {
  if (!projects.has(id)) projects.set(id, project({ root, apiKey, llmKey, model: LLM }));
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

// The marking layer, injected into the render (the renderer only draws). Ids are unique across the
// whole tree here, so a node's key is its id.
const MARKER = `
<style>
  [data-id]{cursor:pointer}
  [data-id]:hover{outline:1px dashed #bbb;outline-offset:2px}
  [data-id].marked{outline:2px solid #111;outline-offset:2px}
  [data-id].twin{outline:2px dashed #111;outline-offset:2px}
  .pick{position:relative}
  .pick::after{content:attr(data-pick);position:absolute;top:-10px;left:-10px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center;z-index:9;zoom:var(--unzoom,1)}
  /* The toolbar and the word editor are the canvas's, not the mock's: drawn over it, at true size
     however far the page zooms the mock out (see pos()). */
  #ms-bar{position:absolute;z-index:50;height:0}
  #ms-bar .in{display:flex;gap:2px;padding:3px;background:#111;border-radius:6px;white-space:nowrap;
    box-shadow:0 2px 8px rgba(0,0,0,.25);font:12px/1 system-ui,-apple-system,sans-serif;width:max-content}
  #ms-bar button{font:inherit;color:#fff;background:transparent;border:0;border-radius:4px;padding:6px 8px;cursor:pointer}
  #ms-bar button:hover{background:#333}
  #ms-bar button.on{background:#fff;color:#111}
  #ms-bar .sep{width:1px;background:#444;margin:3px 2px}
  #ms-edit{position:absolute;z-index:60;margin:0;padding:0 2px;border:0;outline:2px solid #111;background:#fff;color:#111;box-sizing:border-box}
  .ms-drop{position:absolute;z-index:40;background:#111;border-radius:2px;cursor:pointer}
  .ms-drop::after{content:attr(data-pick);position:absolute;left:-22px;top:50%;margin-top:-9px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center;zoom:var(--unzoom,1)}
</style>
<script>
  const byId = (k) => document.querySelector('[data-id="' + CSS.escape(k) + '"]');
  const CHROME = "#ms-bar, #ms-edit, .ms-drop";
  // The page zooms the whole mock out to fit (shell.html fitMock); positions here are in the mock's
  // own pixels, which is what an absolutely placed element inside it is measured in.
  const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;
  function pos(el) {
    if (el.offsetParent === undefined) {
      const r = el.getBoundingClientRect(), z = zoom();
      return { left: r.left / z + scrollX, top: r.top / z + scrollY, width: r.width / z, height: r.height / z };
    }
    let left = 0, top = 0;
    for (let n = el; n; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, width: el.offsetWidth, height: el.offsetHeight };
  }
  const tell = (m) => parent.postMessage(m, "*");
  function mark(key) {
    document.querySelectorAll(".marked").forEach((m) => m.classList.remove("marked"));
    if (key) byId(key)?.classList.add("marked");
  }

  addEventListener("click", (e) => {
    if (e.target.closest(CHROME)) return;
    // An edge's label is drawn apart from its edge (so no line crosses it) and points back at it.
    const f = e.target.closest("[data-for]");
    const n = f ? byId(f.dataset.for) : e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    // A numbered thing is an offer: clicking it takes it, as its button beside the text box would.
    if (n.classList.contains("pick")) return tell({ type: "take", n: Number(n.dataset.pick) });
    mark(n.dataset.id);
    tell({ type: "mark", key: n.dataset.id });
  }, true);

  // ---- the toolbar -------------------------------------------------------------------------
  // What the page sends once an element is marked: the edits that would change it, and — when it
  // has twins — those that would change them, shown with "All 5 like this" on.
  let bar = null, allOn = false, wantWords = null;
  function drawBar() {
    document.getElementById("ms-bar")?.remove();
    document.querySelectorAll(".twin").forEach((n) => n.classList.remove("twin"));
    const el = bar && byId(bar.id);
    if (!el || !el.classList.contains("marked")) return;
    if (allOn) for (const k of bar.twins) if (k !== bar.id) byId(k)?.classList.add("twin");
    const list = allOn ? bar.allTools : bar.tools;
    if (!list.length && !bar.allLabel) return;
    const wrap = document.createElement("div");
    wrap.id = "ms-bar";
    const inner = document.createElement("div");
    inner.className = "in";
    // True size at any zoom: the wrapper sits in the mock's pixels, the buttons undo the zoom.
    inner.style.zoom = String(1 / zoom());
    const button = (label, on, act, title) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (on) b.className = "on";
      if (title) b.title = title;
      b.addEventListener("click", (e) => { e.preventDefault(); act(); });
      inner.appendChild(b);
    };
    if (bar.allLabel) {
      button(bar.allLabel, allOn, () => { allOn = !allOn; tell({ type: "all", key: bar.id, on: allOn }); drawBar(); });
      if (list.length) inner.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
    }
    for (const t of list) button(t.label, false, () => tell({ type: "tool", key: bar.id, op: t.op, all: allOn }), bar.renameHint);
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    const p = pos(el), h = inner.offsetHeight / zoom(), w = inner.offsetWidth / zoom();
    // Inside what is in view, clear of the scrollbar.
    const room = document.documentElement.clientWidth / zoom() + scrollX;
    wrap.style.left = Math.max(4, Math.min(p.left, room - w - 4)) + "px";
    // Above it, or under it where there is no room above.
    wrap.style.top = (p.top - h - 8 >= 0 ? p.top - h - 8 : p.top + p.height + 8) + "px";
  }

  // ---- words, edited where they are ----------------------------------------------------------
  function editWords(el) {
    document.getElementById("ms-edit")?.remove();
    const p = pos(el), cs = getComputedStyle(el);
    const inp = document.createElement("input");
    inp.id = "ms-edit";
    inp.value = bar.text;
    Object.assign(inp.style, { left: p.left + "px", top: p.top + "px", width: Math.max(p.width, 140) + "px", height: p.height + "px",
      font: cs.font, letterSpacing: cs.letterSpacing, textAlign: cs.textAlign === "center" ? "center" : "left" });
    document.body.appendChild(inp);
    inp.focus();
    inp.select();
    const key = el.dataset.id, was = bar.text;
    // Once: taking the editor out blurs it, and a blur is also a way to finish.
    let closed = false;
    const done = (keep) => {
      if (closed) return;
      closed = true;
      const v = inp.value.trim();
      inp.remove();
      if (keep && v && v !== was) tell({ type: "rename", key, text: v });
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    inp.addEventListener("blur", () => done(true));
  }
  addEventListener("dblclick", (e) => {
    if (e.target.closest(CHROME)) return;
    const n = e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    // The toolbar's word for it may still be on its way from the page; edit once it lands.
    if (bar && bar.id === n.dataset.id) { if (bar.text != null) editWords(n); }
    else wantWords = n.dataset.id;
  }, true);

  // ---- offers, where they are ----------------------------------------------------------------
  // Each offer about an element numbers it; each about a place draws a numbered line there.
  function drops(list) {
    document.querySelectorAll(".ms-drop").forEach((n) => n.remove());
    for (const d of list || []) {
      const el = byId(d.anchor);
      if (!el) continue;
      const p = pos(el), z = zoom(), t = 3 / z;
      const inside = d.position === "inside_start" || d.position === "inside_end";
      const box = inside ? el : el.parentElement;
      const across = box && getComputedStyle(box).flexDirection.startsWith("row");
      const start = d.position === "before" || d.position === "inside_start";
      const line = document.createElement("div");
      line.className = "ms-drop";
      line.dataset.pick = d.n;
      if (across) {
        const x = inside ? (start ? p.left + t : p.left + p.width - 2 * t) : (start ? p.left - 2 * t : p.left + p.width + t);
        Object.assign(line.style, { left: x + "px", top: p.top + "px", width: t + "px", height: p.height + "px" });
      } else {
        const y = inside ? (start ? p.top + t : p.top + p.height - 2 * t) : (start ? p.top - 2 * t : p.top + p.height + t);
        Object.assign(line.style, { left: p.left + "px", top: y + "px", width: p.width + "px", height: t + "px" });
      }
      line.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); tell({ type: "take", n: d.n }); });
      document.body.appendChild(line);
    }
  }

  addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "mark") {
      mark(m.key);
      // A reply about something already there brings it into view, on whichever page it is.
      if (m.reveal && m.key) byId(m.key)?.scrollIntoView({ block: "center", inline: "center" });
      if (!m.key || m.key !== bar?.id) { bar = null; allOn = false; }
      drawBar();
    }
    if (m.type === "tools") {
      allOn = Boolean(m.allOn) && m.tools.twins.length >= 2;
      bar = m.tools;
      drawBar();
      if (wantWords === bar.id) { wantWords = null; if (bar.text != null) editWords(byId(bar.id)); }
    }
    if (m.type === "pick") {
      // Numbers at true size, like the toolbar, however far the mock is zoomed out.
      document.documentElement.style.setProperty("--unzoom", String(1 / zoom()));
      document.querySelectorAll(".pick").forEach((n) => { n.classList.remove("pick"); n.removeAttribute("data-pick"); });
      // keys[i] is the element offer i + 1 is about, or null.
      (m.keys || []).forEach((k, i) => { const n = k && byId(k); if (n) { n.classList.add("pick"); n.dataset.pick = i + 1; } });
      drops(m.drops);
    }
  });
</script>`;

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
      // The page's own words ({{placeholder}} and the rest) are words.mjs's, like everything else.
      const escHtml = (t) => String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
      return res.end(readFileSync(join(HERE, "shell.html"), "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(W.ui, k) ? escHtml(W.ui[k]) : m)));
    }
    if (route === "/mock") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      let html;
      try { html = render(p.root); } catch (e) { html = `<!doctype html><body><pre style="color:#666">render failed: ${String(e.message).replace(/</g, "&lt;")}</pre></body>`; }
      return res.end(html.includes("</body>") ? html.replace("</body>", MARKER + "\n</body>") : html + MARKER);
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
  console.error(`trial: http://localhost:${server.address().port}  ·  another project: /p/new  ·  jev ${apiKey ? "on" : "off (no key)"}  ·  writer ${llmKey ? LLM : "off (no key)"}  ·  save → ${OUT}`);
});
