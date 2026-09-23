#!/usr/bin/env node
// canvas — say what you want, watch the mock assemble; mark an element, say a change.
//
//   node canvas/server.mjs [spec.json] [--port 8770] [--env <file>] [--out <file>] [--model <id>]
//
// Three layers, each doing one job. A fast model (brain.mjs) turns what was typed into short
// instructions, writing every word the mock will show. Jev (jev.mjs) decides what each
// instruction is — op, kind, screen, target, which quoted span is the content. This file turns
// Jev's answer into a policy decision — thresholds, confirmations, what to do when it is not sure —
// and ops.mjs performs the edit; the renderer draws it. Nothing outside the app writes the mock.
//
// The spec lives here, in memory. Nothing writes to a spec file unless you ask it to, and then
// to --out, not over the original. With no spec the canvas starts empty.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render, validate } from "../render/render.mjs";
import { index, apply, DESTRUCTIVE, CREATABLE } from "./ops.mjs";
import { decide, unquoted } from "./jev.mjs";
import { translate, MODEL } from "./brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- policy ------------------------------------------------------------------------------
// Thresholds are policy, not model output. Jev reports how sure it is; these lines decide what
// that buys. Destructive edits are held back for a human yes however sure the answer looked.
const FIRE = 0.5;        // below this, the sentence was not asking for a change
const ACT_OP = 0.5;      // below this, do not act on the op
const ACT_TARGET = 0.7;  // below this, fall back to the marked element or ask. 0.5-0.7 is
                         // where Jev picks a plausible neighbour — cheap to ask, expensive to guess
const ACT_SCREEN = 0.7;  // below this, an add goes to the screen being built, not Jev's guess
const ACT_STYLE = 0.6;   // tier and frame: below this, keep the kind's default
const ACT_ROUTE = 0.6;   // the docs' baseline floor: below this the route alone decides nothing,
                         // and a request goes to the writer, the more capable handler
const DEICTIC = /\b(this|that|it|these|those|here|there)\b/i;

// ---- args --------------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const specPath = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? null;
if (args.includes("--help")) {
  console.error("usage: canvas/server.mjs [spec.json] [--port 8770] [--env <file>] [--out <file>] [--model <id>]");
  process.exit(2);
}
const PORT = Number(flag("--port", 8770));
const OUT = flag("--out", specPath ? specPath.replace(/\.json$/, "") + ".canvas.json" : "canvas.spec.json");
const LLM = flag("--model", MODEL);
const WHO = LLM.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "");  // "haiku", for the log

// Keys are read, never printed, and sent only to their own API: Jev's to api.typesafe.ai, the
// translator's to api.anthropic.com. The environment wins over the --env file.
const envFile = flag("--env", process.env.TYPESAFE_ENV_FILE);
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

// ---- state -------------------------------------------------------------------------------
let spec = specPath ? JSON.parse(readFileSync(resolve(specPath), "utf8")) : { title: "new", frame: "web", screens: [] };
const errs = specPath ? validate(spec) : [];
if (errs.length) { console.error("canvas: invalid spec\n  " + errs.join("\n  ")); process.exit(2); }
const past = [];   // specs, for undo
const log = [];    // {note, op, target, ms, source, said}
let rev = 0;       // bumped when the spec changes; the page redraws the mock
let seq = 0;       // bumped when anything changes, the log included; the page re-reads /state
let busy = null;   // the request being built, while one is
const watchers = [];  // open event streams

function announce(specChanged = true) {
  if (specChanged) rev += 1;
  seq += 1;
  for (const res of watchers) res.write(`data: ${JSON.stringify({ rev, seq })}\n\n`);
}

const elements = () => index(spec).map(({ key, id, screen, kind, tier, text }) => ({ key, id, screen, kind, tier, text }));

function note(entry) {
  log.push(entry);
  if (log.length > 80) log.shift();
}

function commit(next, entry) {
  past.push(spec);
  spec = next;
  note(entry);
  announce();
}

// ---- the decision ------------------------------------------------------------------------
// One sentence in, one applied edit (or one honest refusal) out. `build` is set when the sentence
// is one line of the writer's: it remembers which screen is being built, so a line that does not
// name its screen lands where the lines before it did. `decision` is Jev's answer when the router
// already has it; `direct` marks the person's own sentence on the direct route, where anything
// that needs words written is handed to the writer instead of refused.
async function say({ utterance, marked, confirm, words, add, build = null, source = null, decision = null, direct = false }) {
  // The canvas asked "what should it say?" and this is the answer. The words are taken exactly
  // as typed — no model sees them, because they are already the thing they need to be.
  if (add && words) {
    const r = apply(spec, "add", add.anchor ?? null, { kind: add.kind, text: words, screen: add.screen });
    if (r.changed) commit(r.spec, { note: r.note, op: "add", target: add.anchor ?? add.screen, ms: 0, source: "your words" });
    return { note: r.note, changed: r.changed, ok: r.ok };
  }
  if (!apiKey) return { note: "no TYPESAFE_API_KEY — nothing can be said to this canvas; start it with --env", blocked: true };
  const els = elements();
  if (marked && !els.some((e) => e.key === marked)) marked = null;  // a new mock has nothing marked
  // A writer's line names its own target unless it says "this". Left in Jev's state, the mark
  // pulled "make the Tasks list quieter" onto the marked button and turned "add a button" into a
  // rename of it — so Jev only sees the mark when the line points at it.
  if (source && marked && !DEICTIC.test(unquoted(utterance))) marked = null;
  const d = decision ?? await decide({ utterance, marked, elements: els, screens: spec.screens, apiKey });
  const base = { op: d.op, ms: d.ms, fire: d.fire, opConfidence: d.opConfidence, targetConfidence: d.targetConfidence, said: utterance };
  const via = source ? `${source} → jev` : "jev";

  // Every sentence Jev saw is written down with what it decided, including the ones that changed
  // nothing — the log is where you watch each layer do its job.
  const done = (r, target = null, how = via) => {
    const entry = { note: r.note, op: d.op, conf: d.opConfidence, ms: d.ms, source: how, said: utterance, target };
    if (r.changed) commit(r.spec, entry);
    else { note({ ...entry, refused: true }); announce(false); }
    return { ...base, ...r, spec: undefined, target, how };
  };
  const refuse = (text, extra = {}, target = null) => done({ note: text, changed: false, ...extra }, target);
  // On the direct route, "this needs words" or "Jev is not sure" is not a dead end: the writer
  // takes it (the confidence-gated escalation in docs.typesafe.ai/patterns/confidence-routing).
  const escalate = (text, extra = {}, target = null) => (direct ? { ...base, escalate: text } : refuse(text, extra, target));

  // On the direct route the router has already judged the sentence a request; the per-line fire
  // question is for the writer's lines, and it read "this is the main thing" as a statement.
  if ((!direct && d.fire < FIRE) || d.op === "none") return escalate("not an edit — nothing changed");
  if (d.opConfidence < ACT_OP) return escalate(`unsure what that asks for (${d.op} at ${d.opConfidence.toFixed(2)})`);

  // Everything goes, on one yes. Undo brings it back.
  if (d.op === "clear") {
    if (!confirm) return refuse("clear the whole canvas? undo brings it back", { needsConfirm: true });
    return done(apply(spec, "clear"));
  }

  // Starting a mock and adding a screen take a name and nothing else. The name is a span of the
  // sentence, picked by Jev and cut out by code. From the person directly, both are writing jobs —
  // a new screen wants content — so they go to the writer.
  if (d.op === "new_mock" || d.op === "add_screen") {
    if (direct) return escalate(`${d.op === "new_mock" ? "a new app" : "a new screen"} needs writing`);
    if (!d.span) {
      return refuse(d.op === "new_mock" ? 'what is the new app called? try: start a new app "Relay"' : 'what is the screen called? try: add a screen "Runs"');
    }
    const r = d.op === "new_mock"
      ? apply(spec, "new_mock", null, { title: d.span, frame: d.frameConfidence >= ACT_STYLE ? d.frame : "web" })
      : apply(spec, "add_screen", null, { name: d.span });
    if (r.changed && build) { build.building = true; build.screen = d.op === "add_screen" ? d.span.trim() : null; }
    return done(r);
  }

  // add makes something rather than changing something, so it takes words and a place, not a
  // target. When the sentence did not carry the words, the writer writes them.
  if (d.op === "add") {
    if (!d.kind) return escalate('what should I add? try: add a button called "Export"');
    if (!CREATABLE.includes(d.kind)) return escalate(`a ${d.kind} needs its own data — write that one in the spec`);
    if (!spec.screens.length) return escalate('there is no screen yet — try: add a screen "Home"');
    const markedEl = marked ? els.find((e) => e.key === marked) : null;
    const named = d.screen && d.screenConfidence >= ACT_SCREEN ? d.screen : null;
    const screen = named ?? build?.screen ?? markedEl?.screen ?? spec.screens.at(-1).name;
    const anchor = !build?.building && markedEl && markedEl.screen === screen ? marked : null;
    const tier = d.tier && d.tierConfidence >= ACT_STYLE ? d.tier : undefined;
    if (!d.span) return escalate(`what should the ${d.kind} say?`, build ? {} : { needsWords: true, kind: d.kind, screen, anchor });
    // A table, a list or a row of numbers from the person's own sentence is almost never the
    // whole of it — the writer makes the rows.
    if (direct && ["table", "list", "row"].includes(d.kind)) return escalate(`a ${d.kind} needs rows written`);
    const r = apply(spec, "add", anchor, { kind: d.kind, text: d.span, screen, tier });
    return done(r, anchor ?? screen, source ? via : "jev + your words");
  }

  // Which element. A pointing word plus a marked element beats anything Jev inferred. Pointing
  // words inside quoted content are data, not pointing. Falling back to the marked element when
  // Jev is unsure is for a person who clicked and spoke; a writer's line names its own target,
  // and guessing the mark for it once demoted the marked list twice in one request.
  let target = null, how = via;
  if (marked && DEICTIC.test(unquoted(utterance))) { target = marked; how = `${via} · marked (you pointed)`; }
  else if (d.targetConfidence >= ACT_TARGET) target = d.target;
  else if (marked && !source) { target = marked; how = `${via} · marked (Jev unsure)`; }

  if (!target) {
    // Nobody is sure. Offer the three it liked best rather than guessing one of them — the
    // person is the handler for ambiguity, not the writer.
    const top = Object.entries(d.targets).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    return refuse("which one?", { ask: top.map((k) => els.find((e) => e.key === k)).filter(Boolean) });
  }

  if (DESTRUCTIVE.has(d.op) && !confirm) {
    const el = els.find((e) => e.key === target);
    return refuse(`remove ${el?.kind ?? ""} "${el?.text ?? target}"?`, { needsConfirm: true }, target);
  }

  if (d.op === "rename" && !d.span) {
    return escalate('rename needs the words — say it like: call it "Download"', {}, target);
  }

  return done(apply(spec, d.op, target, d.span), target, how);
}

// ---- routing -----------------------------------------------------------------------------
// Jev decides where what the person typed goes (docs.typesafe.ai/patterns/intent-routing): the
// route question is asked in the same request as every question the direct handler needs, so a
// direct edit is one Jev call and no model call. Below the confidence floor nothing acts on the
// route alone; a request goes to the writer, which is the more capable handler.
function routeOf(d) {
  const confident = d.routeConfidence >= ACT_ROUTE;
  const isRequest = d.request >= FIRE || (d.route !== "none" && confident);
  if (!isRequest) return "none";
  if (d.route === "direct" && confident) return "direct";
  return "write";
}

async function ask({ utterance, marked }) {
  if (busy) return { note: `still building "${busy}" — one request at a time`, changed: false };
  if (!apiKey) return { note: "no TYPESAFE_API_KEY — nothing can be said to this canvas; start it with --env", blocked: true };
  busy = utterance;
  const started = Date.now();
  const secs = () => ((Date.now() - started) / 1000).toFixed(1) + " s";
  note({ note: utterance, op: "ask", source: "you" });
  announce(false);
  try {
    const els = elements();
    if (marked && !els.some((e) => e.key === marked)) marked = null;
    const d = await decide({ utterance, marked, elements: els, screens: spec.screens, apiKey, routing: true });
    const route = routeOf(d);
    const why = `jev · ${d.route} ${d.routeConfidence.toFixed(2)} · request ${d.request.toFixed(2)} · ${d.ms} ms`;
    const say_ = (text, extra = {}) => { note({ op: "route", route, note: text, source: why, ...extra }); announce(false); };

    if (route === "none") {
      say_("not a request — nothing changed");
      return { note: `not a request — nothing changed (${why})`, changed: false };
    }
    if (route === "direct") {
      say_("direct — Jev decides, code applies");
      const r = await say({ utterance, marked, decision: d, direct: true });
      if (!r.escalate) {
        note({ op: "done", note: `direct · ${r.changed ? "applied" : "nothing applied"} · ${secs()}`, source: "canvas" });
        announce(false);
        return r;
      }
      note({ op: "route", route: "write", note: `handed to ${WHO} — ${r.escalate}`, source: "canvas" });
      announce(false);
    } else {
      say_(`write — ${WHO} writes the lines, Jev places each`);
    }
    return await write({ utterance, marked, secs });
  } catch (e) {
    note({ note: `error: ${e.message}`, op: "done", source: "canvas", refused: true });
    announce(false);
    return { note: `error: ${e.message}`, changed: false, error: true };
  } finally {
    busy = null;
  }
}

// ---- the writer's route ------------------------------------------------------------------
// The writer turns the request into lines; each is decided by Jev and applied while the writer is
// still writing the next. Lines are decided one at a time and in order, because each can depend
// on the one before — a screen has to exist before anything lands on it. What the writer says
// that is not an instruction (a question back, "I need more context") is shown, not decided on.
async function write({ utterance, marked, secs }) {
  if (!llmKey) return { note: "this needs writing, and there is no ANTHROPIC_API_KEY — start the canvas with --env", blocked: true };
  const els = elements();
  const markedEl = marked ? els.find((e) => e.key === marked) : null;
  const state = {
    title: spec.title ?? "mock", frame: spec.frame ?? "web", screens: spec.screens.map((s) => s.name),
    // Described the way a person would, never by key: shown keys, the writer wrote them back
    // ("make the Tasks/table1 louder") instead of naming the element or saying "this".
    elements: els.map((e) => `on ${e.screen}: ${e.kind} "${e.text}" (${e.tier})${e.key === marked ? "  <- marked" : ""}`),
    marked: markedEl ? `the ${markedEl.kind} "${markedEl.text}" on ${markedEl.screen}` : null,
  };
  const build = { building: false, screen: null };
  const prose = [];
  let queue = Promise.resolve(), last = null, applied = 0;
  const run = (line) => async () => {
    const r = await say({ utterance: line, marked, build, source: WHO });
    if (r.changed) applied += 1;
    if (r.needsConfirm || r.ask || r.needsWords) last = r;
  };
  const failed = (line) => (e) => { note({ note: `error: ${e.message}`, said: line, source: `${WHO} → jev`, refused: true }); announce(false); };
  try {
    const t = await translate({
      utterance, state, apiKey: llmKey, model: LLM,
      onLine: (line) => { queue = queue.then(run(line)).catch(failed(line)); },
      onProse: (text) => { prose.push(text); note({ op: "said", note: text, source: WHO }); announce(false); },
    });
    await queue;
    const summary = `${t.lines} lines from ${WHO} (first at ${t.firstLineMs ?? "—"} ms, ${t.outputTokens} tokens) · ${applied} applied · ${secs()}`;
    note({ note: summary, op: "done", source: "canvas" });
    announce(false);
    if (!t.lines && prose.length) return { note: `${WHO}: ${prose.join(" ")}`, changed: false };
    return { ...(last ?? {}), note: last?.note ?? summary, changed: applied > 0, applied, lines: t.lines };
  } catch (e) {
    await queue;
    throw e;
  }
}

// ---- http --------------------------------------------------------------------------------
const json = (res, body, code = 200) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const body = (req) => new Promise((ok, no) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
});

// The marking layer is injected into the render rather than built into it: the renderer stays
// the thing that draws mocks, and a mock never carries canvas machinery into a file.
const MARKER = `
<style>
  [data-id]{cursor:pointer}
  [data-id]:hover{outline:1px dashed #bbb;outline-offset:3px}
  [data-id].marked{outline:2px solid #111;outline-offset:3px}
  .pick{position:relative}
  .pick::after{content:attr(data-pick);position:absolute;top:-10px;left:-10px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center}
</style>
<script>
  const key = (n) => n.closest("[data-screen]")?.dataset.screen + "/" + n.dataset.id;
  addEventListener("click", (e) => {
    const n = e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    document.querySelectorAll(".marked").forEach((m) => m.classList.remove("marked"));
    n.classList.add("marked");
    parent.postMessage({ type: "mark", key: key(n) }, "*");
  });
  addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "mark") {
      document.querySelectorAll(".marked").forEach((n) => n.classList.remove("marked"));
      for (const n of document.querySelectorAll("[data-id]")) if (key(n) === m.key) n.classList.add("marked");
    }
    if (m.type === "pick") {
      document.querySelectorAll(".pick").forEach((n) => { n.classList.remove("pick"); n.removeAttribute("data-pick"); });
      (m.keys || []).forEach((k, i) => {
        for (const n of document.querySelectorAll("[data-id]")) if (key(n) === k) { n.classList.add("pick"); n.dataset.pick = i + 1; }
      });
    }
  });
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(readFileSync(join(HERE, "shell.html"), "utf8"));
    }
    if (url.pathname === "/mock") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      // A spec being built up arrives incomplete; an empty frame is the honest thing to draw
      // while it is still on its way.
      const html = validate(spec).length ? "<!doctype html><body style=\"background:#fff\"></body>" : render(spec);
      return res.end(html.replace("</body>", MARKER + "\n</body>"));
    }

    // The page listens here so a mock can be built from outside — one screen or one element at a
    // time — and appear as it lands rather than when it is finished.
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ rev, seq })}\n\n`);
      watchers.push(res);
      req.on("close", () => { const i = watchers.indexOf(res); if (i >= 0) watchers.splice(i, 1); });
      return;
    }

    if (url.pathname === "/new" && req.method === "POST") {
      const b = await body(req);
      past.push(spec);
      spec = { title: b.title ?? "mock", frame: b.frame ?? "web", layout: b.layout ?? undefined, screens: b.screens ?? [] };
      log.length = 0;
      log.push({ note: `new mock · ${spec.title}`, op: "new", source: "claude" });
      announce();
      return json(res, { note: `new mock · ${spec.title}`, changed: true });
    }

    // Append a screen, or an element to a named screen. Each append is validated on its own, so a
    // half-built spec never renders as a broken one.
    if (url.pathname === "/append" && req.method === "POST") {
      const b = await body(req);
      const next = structuredClone(spec);
      let note;
      if (b.screen) { next.screens.push(b.screen); note = `screen ${b.screen.name}`; }
      else if (b.element) {
        const s = next.screens.find((x) => x.name === b.to) ?? next.screens[next.screens.length - 1];
        if (!s) return json(res, { note: "no screen to append to", changed: false });
        (b.at === "top" ? s.elements.unshift(b.element) : s.elements.push(b.element));
        note = `${b.element.kind} → ${s.name}`;
      } else return json(res, { note: "append what?", changed: false });
      const errors = validate(next);
      if (errors.length) return json(res, { note: `refused — ${errors[0]}`, changed: false });
      past.push(spec); spec = next;
      log.push({ note, op: "append", source: "claude" });
      if (log.length > 40) log.shift();
      announce();
      return json(res, { note, changed: true, elements: index(spec).length });
    }
    if (url.pathname === "/state") {
      return json(res, {
        title: spec.title ?? "mock", elements: elements(), screens: spec.screens.length, log, busy,
        jev: Boolean(apiKey), llm: llmKey ? LLM : null, canUndo: past.length > 0, out: OUT,
      });
    }
    // What the person types. It goes to the translator first; /say is for answers to the
    // canvas's own questions (which one? remove it? what should it say?).
    if (url.pathname === "/ask" && req.method === "POST") {
      return json(res, await ask(await body(req)));
    }
    if (url.pathname === "/say" && req.method === "POST") {
      return json(res, await say(await body(req)));
    }
    if (url.pathname === "/op" && req.method === "POST") {
      const { op, target, arg } = await body(req);
      const r = apply(spec, op, target, arg);
      if (r.changed) commit(r.spec, { note: r.note, op, target, ms: 0, source: "you" });
      return json(res, { ...r, spec: undefined, changed: r.changed, note: r.note });
    }
    if (url.pathname === "/undo" && req.method === "POST") {
      if (!past.length) return json(res, { note: "nothing to undo", changed: false });
      spec = past.pop();
      log.push({ note: "undone", op: "undo", source: "you" });
      announce();
      return json(res, { note: "undone", changed: true });
    }
    if (url.pathname === "/save" && req.method === "POST") {
      writeFileSync(resolve(OUT), JSON.stringify(spec, null, 2) + "\n");
      return json(res, { note: `saved ${OUT}`, changed: false });
    }
    if (url.pathname === "/spec") return json(res, spec);
    res.writeHead(404).end("not found");
  } catch (e) {
    json(res, { note: `error: ${e.message}`, changed: false, error: true }, 500);
  }
}).listen(PORT, () => {
  console.error(`canvas: http://localhost:${PORT}  ·  ${specPath ?? "empty"}  ·  jev ${apiKey ? "on" : "off (no key)"}  ·  translator ${llmKey ? LLM : "off (no key)"}  ·  save → ${OUT}`);
});
