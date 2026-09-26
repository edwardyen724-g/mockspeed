#!/usr/bin/env node
// trial — the canvas, with the mock as a tree of primitives instead of a list of widgets.
//
//   node trial/server.mjs [mock.outline] [--port 8772] [--env <file>] [--out <file>] [--model <id>]
//
// Every decision about meaning is Jev's (trial/jev.mjs): whether a sentence is a request, where it
// goes (direct edit, writer, nothing), which job it is (new app, add a piece, rewrite a piece,
// several changes), which screen, which gap a new piece goes into, which element an edit acts on,
// and whether "this" points at the marked element. The writer (trial/writer.mjs) only writes — a
// whole app, one piece, or a sentence split into single changes. Code applies what was decided.
//
// Decisions that belong to the person — removing something, which element or gap when Jev is not
// sure — come back as `choices`, which the page shows next to the text box; the answer comes back
// to /answer. Every string the person reads comes from trial/words.mjs; the log's own notes, Jev's
// scores and timings are for ?debug=1. Runs beside canvas/ so the two can be compared.

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, Stream, serialize, index, find, describe, shapeOf, positionOf, applyPatch, apply, gaps, screenGaps, placeAt, partsOf, spotsIn, edgesOf, neighboursIn, padded, copiesOf, firstCopy, sharedView, mirrorsOf } from "./tree.mjs";
import { render } from "./render.mjs";
import { decide, place, spot, nextTo, which, needs, KIND_TYPES } from "./jev.mjs";
import { writeApp, writePiece, split, MODEL } from "./writer.mjs";
import * as W from "./words.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- policy ------------------------------------------------------------------------------
// Thresholds are policy, not model output. Below each one, nothing acts on Jev's answer alone:
// a request goes to the more capable handler, or the person is asked.
const FIRE = 0.5;        // the request gate
const ACT_ROUTE = 0.6;   // docs' floor: below it, a request goes to the writer
const ACT_OP = 0.5;      // below it, the direct edit is not trusted; the writer takes the sentence
const ACT_TARGET = 0.7;  // below it, the marked element if the sentence points at it, else ask
const ACT_JOB = 0.6;     // below it, the person says what kind of change it is
const ACT_SCREEN = 0.6;  // below it, the screen the person is looking at
const ACT_GAP = 0.5;     // at each level of a placement, below it the person picks where the new
                         // piece goes (measured: the doubtful placements came back at 0.27 and 0.38)
const OPEN_SPOT = 0.5;   // Jev's `open` at or above it: the sentence named no spot, so an unsure
                         // placement is not the person's question
const ACT_NEXT = 0.4;    // an open sentence goes right after the element Jev says it belongs next to
                         // at or above this, else to the end of its part (measured: a filter beside
                         // the search field came back at 0.33-0.86; a note's neighbour at 0.11-0.40)
const POINTS = 0.5;      // "this" / "it" means the marked element
const ACT_SPAN = 0.5;    // below it, a rename's new words are not trusted; the writer rewrites
const ACT_FRAME = 0.6;   // below it, what a new app runs on is left to the writer
const WHOLE_HI = 0.7;    // "a whole new screen" at or above this; "on a screen" at or below
const WHOLE_LO = 0.3;    // WHOLE_LO; in between, the person says which
const NOT_THERE = 0.3;   // Jev's `exists` below this, against a sure `which`: the person is asked
const DESTRUCTIVE = new Set(["remove", "clear"]);
// The edits that step a property, and so can be tried on each candidate to see whether they would
// change it. A move or a removal changes anything; a rename needs its words.
const PROPERTY = new Set(["bigger", "smaller", "bold", "regular", "darker", "lighter", "wider", "narrower", "taller", "shorter"]);

// ---- args and keys -----------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const PORT = Number(flag("--port", 8772));
const START = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? null;
const OUT = flag("--out", "trial.outline");
const LLM = flag("--model", MODEL);
const WHO = LLM.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "");
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

// ---- state -------------------------------------------------------------------------------
const blank = () => parse('app "new" web').root;
// A saved outline (from "save spec") can be opened again; its parser warnings are logged, not fatal.
let root = blank();
if (START) {
  const opened = parse(readFileSync(resolve(START), "utf8"));
  root = opened.root;
  if (opened.warnings.length) console.error(`trial: ${START}: ${opened.warnings.length} parser warnings`);
}
const past = [];
const log = [];
let rev = 0, seq = 0, busy = null;
// The sentence waiting on the person's choice, with Jev's decision about it, so the answer carries
// on from there instead of asking Jev again.
let pending = null;
// What the page offers after acting — "Bring back “Relay”" once a new app has replaced it. Unlike a
// question it waits on nothing: the next request, answer or undo clears it.
let offer = null;
// The page a build is drawing, for the line under the text box while it runs.
let drawing = null;
const watchers = [];

function announce(specChanged = true) {
  if (specChanged) rev += 1;
  seq += 1;
  for (const res of watchers) res.write(`data: ${JSON.stringify({ rev, seq })}\n\n`);
}
// A build streams a line every few tens of milliseconds; the page redraws at most five times a
// second, which is as fast as a person can follow and far cheaper than a reload per line.
let soon = null;
const announceSoon = () => { if (!soon) soon = setTimeout(() => { soon = null; announce(); }, 200); };
const announceNow = () => { if (soon) { clearTimeout(soon); soon = null; } announce(); };

function note(entry) { log.push(entry); if (log.length > 160) log.shift(); announce(false); }
function commit(next, entry) { past.push(root); root = next; log.push(entry); if (log.length > 160) log.shift(); announce(); }

// What Jev and the page see of the tree: every node but the root, one line each — its description
// and, for a container, what it is made of ("a list of 5 rows"), so "the list" can be told apart
// from the rows inside it and the screen around it. For Jev (`once`), a shared element is shown
// once, on all the screens its copies are on (tree.mjs sharedView); the page sees every node.
const nodes = ({ once = false } = {}) => {
  const view = once ? sharedView(root) : { hidden: new Set(), screens: new Map() };
  return index(root).filter((n) => n.node !== root && !view.hidden.has(n.id)).map((n) => {
    const shape = shapeOf(n.node);
    const screen = view.screens.get(n.id)?.join(", ") ?? n.screen;
    return { id: n.id, screen, line: shape ? `${describe(n.node)} · ${shape}` : describe(n.node), type: n.type };
  });
};
const screenList = () => root.children.filter((s) => s.type === "screen");
const lineOf = (id) => { const h = find(root, id); return h ? describe(h.node) : id; };
const screenOf = (id) => index(root).find((n) => n.id === id)?.screen ?? null;
const secsSince = (t) => ((Date.now() - t) / 1000).toFixed(1) + " s";

// A question for the person. The page shows the buttons next to the text box; each posts its
// answer to /answer with the question's number, so an answer can only ever settle the question it
// was offered for — a stale button says so instead of acting on a later question. The open
// question is also in /state, so a reload or a second tab shows it again. `pick` numbers the
// elements the choices are about, in the mock.
let qn = 0;
let question = null;
function asking(text, choices, { pick = [], keep = {} } = {}) {
  const q = ++qn;
  const stamped = choices.map((c) => ({ ...c, post: { ...c.post, body: { ...c.post.body, q } } }));
  pending = { ...keep, q };
  question = { text, choices: stamped, pick };
  note({ op: "choice", note: text, source: "you decide", choices: choices.map((c) => c.label) });
  return { note: text, changed: false, choices: stamped, pick };
}
const answer = (label, body, primary = false) => ({ label, primary, post: { path: "/answer", body } });
const cancel = () => answer(W.LEAVE, { kind: "cancel" });
function settle() { pending = null; question = null; }

// ---- routing -----------------------------------------------------------------------------
async function ask({ utterance, marked, viewing }) {
  if (busy) return { note: W.reply.busy(busy), changed: false };
  if (!apiKey) return { note: W.reply.notSetUp, debug: "no TYPESAFE_API_KEY — start with --env", blocked: true };
  busy = utterance;
  settle();
  offer = null;
  note({ note: utterance, op: "ask", source: "you", say: utterance });
  let r;
  try {
    r = await handle({ utterance, marked, viewing, started: Date.now(), depth: 0 });
  } catch (e) {
    note({ note: `error: ${e.message}`, op: "done", source: "canvas", refused: true });
    r = { note: W.reply.error, debug: e.message, changed: false, error: true };
  } finally {
    busy = null;
    drawing = null;
  }
  said(r);
  return r;
}

// The reply, in the history the person reads (the log's other entries are for ?debug=1).
function said(r) { note({ op: "reply", note: r.note, say: r.note, refused: r.changed === false && !r.choices?.length }); }

// One sentence, from Jev's first decision to the change on the canvas (or the question to the
// person). `depth` is 1 for the parts of a sentence the writer split; `context` is then the whole
// sentence, which Jev reads to resolve "this" in a part.
async function handle({ utterance, marked, viewing, started, depth, context = null }) {
  // (`depth` also keeps a split part from being split again: its job answer is about the part.)
  const all = nodes({ once: true });
  // A mark on a later copy of a shared element stands for the element, shown to Jev as its first copy.
  if (marked && find(root, marked)) marked = firstCopy(root, marked);
  if (marked && !all.some((n) => n.id === marked)) marked = null;
  const d = await decide({ utterance, marked, nodes: all, screens: screenList().map((s) => s.text), viewing, context, apiKey });
  const why = `jev · ${d.route} ${d.routeConfidence.toFixed(2)} · request ${d.request.toFixed(2)}${d.job ? ` · ${d.job} ${d.jobConfidence.toFixed(2)}` : ""}${d.points != null ? ` · points ${d.points.toFixed(2)}` : ""} · ${d.ms} ms`;
  const ctx = { utterance, marked, viewing, d, started, depth, context };
  const confident = d.routeConfidence >= ACT_ROUTE;
  const gate = d.request >= FIRE;
  // Jev asks itself twice whether this is a request — the gate, and the route's "none". When both
  // are sure and they disagree, the sentence is a change: in a mock editor a sentence is a change
  // unless it is a question (docs/plan-web-2026-09-26.md §3B, decided 2026-09-26), and Undo takes it
  // back. The person is no longer asked "change the mockup, or is it a remark?".
  const disagree = confident && gate !== (d.route !== "none");
  if (disagree) note({ op: "route", route: "?", note: "Jev's gate and route disagree — taken as a change", source: why, said: utterance });
  let route = disagree ? (d.route !== "none" ? d.route : "write") : confident ? d.route : gate ? "write" : "none";
  // A direct edit is one change by definition. When Jev's own job answer is confidently "several",
  // the direct route cannot carry the sentence ("make this bold and move it to the top" routed
  // direct at 0.96 with job several at 0.80, and the move was lost), so it goes to be split.
  if (route === "direct" && d.job === "several" && d.jobConfidence >= ACT_JOB && depth === 0) route = "write";
  return proceed(ctx, route, why);
}

async function proceed(ctx, route, why) {
  const { utterance } = ctx;
  if (route === "none") {
    note({ op: "route", route, note: "not a request — nothing changed", source: why, said: utterance });
    return { note: W.reply.notAChange, debug: why, changed: false };
  }
  if (route === "direct") {
    note({ op: "route", route, note: `direct — ${ctx.d.op} ${ctx.d.opConfidence.toFixed(2)}`, source: why, said: utterance });
    const r = await direct(ctx);
    if (r.moveTo) return movePiece(ctx, r.moveTo);
    if (!r.escalate) return r;
    note({ op: "route", route: "write", note: `handed to the writer — ${r.escalate}`, source: "canvas", said: utterance });
    return writeJob({ ...ctx, fallbackTarget: r.target ?? null });
  }
  note({ op: "route", route, note: "write", source: why, said: utterance });
  return writeJob(ctx);
}

// ---- direct edits ------------------------------------------------------------------------
// Jev's decision applied as one concrete edit. Anything it cannot do alone — no confident op, new
// words needed, an edit that does not apply to what was pointed at — goes to the writer instead.
async function direct(ctx) {
  const { marked, d } = ctx;
  const escalate = (why, target = null) => ({ escalate: why, target });
  // Clearing is asked about at any confidence: it is never quietly handed to the writer.
  if (d.op === "clear") {
    return asking(W.ask.clear, [answer(W.ask.clearYes, { kind: "apply", op: "clear" }, true), cancel()], { keep: ctx });
  }
  if (!nodes().length) return escalate("the canvas is empty");
  if (d.op === "none" || d.opConfidence < ACT_OP) return escalate(`no single edit (${d.op} ${d.opConfidence.toFixed(2)})`);

  const pointed = marked && d.points != null && d.points >= POINTS;
  // The sentence points at the marked element and also names a different one: the person says which.
  if (pointed && d.targetConfidence >= ACT_TARGET && d.target !== marked) {
    return asking(W.ask.pointedOrNamed(d.op), [
      answer(W.ask.pointedChoice(root, marked), { kind: "apply", op: d.op, target: marked, span: d.span }, true),
      answer(W.ask.namedChoice(root, d.target), { kind: "apply", op: d.op, target: d.target, span: d.span }),
      cancel(),
    ], { pick: [marked, d.target], keep: ctx });
  }
  const target = pointed ? marked : await choose(ctx, { op: d.op, body: (id) => ({ kind: "apply", op: d.op, target: id, span: d.span }) });
  if (typeof target !== "string") return target;
  return finishEdit(ctx, d.op, target, d.span, pointed ? `jev · the marked element (points ${d.points.toFixed(2)})` : "jev");
}

// ---- which element -----------------------------------------------------------------------
// The elements a sentence can mean: those of the kind Jev named, less the screens (a whole screen
// is the kind "screen", which the screen question answers) and bare wrappers — a container that is
// its parent's only child and has no fill or border draws nothing a person could point at, and its
// words are its child's, so it only ever stood in for the thing inside it. For an edit that steps
// a property, the elements it would change and those already as far as it goes ("already the
// largest size" is an answer, and the title a person names may be one), said so; failing both,
// all of them, and the writer takes an edit that does not apply. Each is labelled with where it
// sits: among its siblings, the part of the screen it is in, the largest text on its screen.
// Measured 2026-09-23 against the same labels without the part and with only the elements the edit
// would change: top pick right 29/35 vs 22/35 — "make the title bigger" with the title already xxl
// 5/5 vs 0/5, "the main list" away from the side nav on two more apps — and one nav lost, to an
// already-dark top bar at 0.55, which is asked.
const SIZE_STEPS = ["xs", "s", "m", "l", "xl", "xxl"];
function candidates(kind, op) {
  const types = KIND_TYPES[kind] ?? [];
  const all = index(root);
  const bare = (n) => {
    const h = find(root, n.id);
    return h?.parent?.children.length === 1 && n.node.children?.length > 0 && n.node.props?.fill == null && !n.node.props?.border;
  };
  // A shared element is offered once, as its first copy, on all its screens.
  const view = sharedView(root);
  let pool = all.filter((n) => n.node !== root && n.type !== "screen" && types.includes(n.type) && !bare(n) && !view.hidden.has(n.id));
  const limit = new Set();
  if (PROPERTY.has(op) && pool.length) {
    const tried = pool.map((n) => ({ n, r: apply(root, op, n.id) }));
    const fits = tried.filter((t) => t.r.changed || t.r.limit);
    if (fits.length) pool = fits.map((t) => t.n);
    for (const t of fits) if (t.r.limit) limit.add(t.n.id);
  }
  const size = (n) => SIZE_STEPS.indexOf(n.node.props?.size ?? "m");
  const largest = new Set();
  // The part of the screen each element is in, in partsOf's words ("the left side of the screen").
  const part = new Map();
  for (const s of screenList()) {
    const texts = all.filter((n) => n.screen === s.text && n.type === "text");
    const top = Math.max(-1, ...texts.map(size));
    if (top >= SIZE_STEPS.indexOf("l")) for (const n of texts) if (size(n) === top) largest.add(n.id);
    for (const p of partsOf(root, s.id)) {
      const where = p.text.split(" — ").pop();
      for (const d of index(find(root, p.into).node)) part.set(d.id, d.id === p.into ? where : `in ${where.split(",")[0]}`);
    }
  }
  return pool.map((n) => {
    const shape = shapeOf(n.node);
    const place = [positionOf(root, n.id), largest.has(n.id) ? `the largest text on ${n.screen}` : "", part.get(n.id) ?? "",
      limit.has(n.id) ? `already as far as ${op} goes` : ""].filter(Boolean).join(", ");
    const pages = view.screens.get(n.id) ?? [n.screen].filter(Boolean);
    return { id: n.id, screen: pages.join(", "), pages, place, limit: limit.has(n.id), line: shape ? `${describe(n.node)} · ${shape}` : describe(n.node) };
  });
}

// The element an unmarked sentence means: Jev chooses among the candidates, and acts when it is
// sure and its answer to "is it on the mockup at all?" does not say no. Otherwise the person picks
// from Jev's three likeliest — with a note when Jev does not see the thing named. Returns an id,
// or a reply (a question, or "there is no button"). `body(id)` is the answer a choice posts; `op`
// is the edit (none for a rewrite, which the person reads as "change").
async function choose(ctx, { op = null, body }) {
  const { d, utterance } = ctx;
  if (d.kind === "screen") {
    const s = pickScreen(ctx);
    return typeof s === "string" ? screenList().find((x) => x.text === s).id : s;
  }
  const pool = candidates(d.kind, op);
  if (!pool.length) {
    note({ op: "target", note: `no ${d.kind} on the mockup`, source: `jev · kind ${d.kind} ${d.kindConfidence.toFixed(2)}`, said: utterance, refused: true });
    return { note: W.reply.noSuch(d.kind), changed: false };
  }
  const w = pool.length === 1 ? { id: pool[0].id, confidence: 1, ranked: [pool[0].id], ms: 0 } : await which({ utterance, pool, viewing: ctx.viewing, apiKey });
  const known = pool.some((n) => n.id === w.id);
  note({ op: "target", note: known ? lineOf(w.id) : "?", conf: w.confidence, ms: w.ms, source: `jev · element ${w.confidence.toFixed(2)} of ${pool.length} (${d.kind} ${d.kindConfidence.toFixed(2)}) · exists ${d.exists.toFixed(2)} · ${w.ms} ms`, said: utterance });
  if (known && w.confidence >= ACT_TARGET && d.exists >= NOT_THERE) return w.id;
  // The person is offered what the edit would change, before what is already as far as it goes.
  const ranked = w.ranked.map((id) => pool.find((n) => n.id === id));
  const top = [...ranked.filter((n) => !n.limit), ...ranked.filter((n) => n.limit)].slice(0, 3);
  const many = screenList().length > 1;
  const named = W.distinct(root, top.map((n) => n.id));
  return asking(W.ask.which(op ?? "change", { seen: d.exists >= 0.5 }),
    [...top.map((n, i) => answer(W.ask.whichChoice(root, n.id, i, many ? n.pages : [], named[i]), body(n.id), i === 0 && d.exists >= 0.5)), cancel()],
    { pick: top.map((n) => n.id), keep: ctx });
}

// ---- shared elements ---------------------------------------------------------------------
// An element drawn on several screens (tree.mjs `share=`) is one element: a change made to one of
// its copies, or to anything in one, is made to every copy.
function applyEverywhere(op, target, arg) {
  const r = apply(root, op, target, arg);
  if (!r.changed) return r;
  let tree = r.root, more = 0;
  for (const c of copiesOf(root, target)) {
    const x = apply(tree, op, c.id, arg);
    if (x.changed) { tree = x.root; more += 1; }
  }
  return more ? { ...r, root: tree, copies: more, note: `${r.note} · and on ${more} other screen${more === 1 ? "" : "s"}, where it is shared` } : r;
}

// The patch that puts `text` at a place (tree.mjs placeAt), and at the same place in every other
// copy when the place is inside a shared element. A shared element rewritten stays shared: its
// replacement keeps the name. Returns { patch, copies } or null.
function placeEverywhere(anchor, position, text) {
  const key = find(root, anchor)?.node.props?.share;
  if (position === "replace" && key != null) {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.trim() && !/^\s/.test(l) && !/^\s*\/\//.test(l));
    if (i >= 0 && !/\bshare=/.test(lines[i])) lines[i] = `${lines[i].replace(/\s+$/, "")} share=${key}`;
    text = lines.join("\n");
  }
  const first = placeAt(root, anchor, position, text);
  if (!first) return null;
  const more = mirrorsOf(root, anchor, position).map((a) => placeAt(root, a, position, text)).filter(Boolean);
  return { patch: first + more.join(""), copies: more.length };
}

// The edit once the element is known — from Jev, or from the person's choice (`chosen`: they
// picked it, and for a removal that is their yes).
function finishEdit(ctx, op, target, span, how, chosen = false) {
  const { utterance, d } = ctx;
  if (!find(root, target) && op !== "clear") return { note: W.reply.gone, changed: false };
  // A move that names where it should end up is a placement, not one step.
  if ((op === "move_earlier" || op === "move_later") && d.dest >= FIRE) return { moveTo: target };
  if (op === "rename" && (!span || d.spanConfidence < ACT_SPAN)) return { escalate: "rename without clear new words", target };
  if (DESTRUCTIVE.has(op) && !chosen) {
    return asking(W.ask.remove(root, target), [answer(W.ask.removeYes, { kind: "apply", op, target, chosen: true }, true), cancel()], { pick: [target], keep: ctx });
  }
  // Named before the edit: a removed or renamed thing is not there to be named by its old words after.
  const what = W.name(root, target);
  const across = find(root, target)?.parent?.type === "row";
  const r = applyEverywhere(op, target, span);
  // "already bold" is an answer; "has no set width" is a job for the writer, who can set one.
  if (!r.changed && !r.limit) return { escalate: r.note, target };
  const entry = { note: r.note, op, conf: d.opConfidence, ms: d.ms, source: how, said: utterance, target };
  if (r.changed) commit(r.root, entry); else note({ ...entry, refused: true });
  const say = r.changed ? W.reply.edited(root, op, what, { copies: r.copies ?? 0, across, to: span }) : W.reply.limit(op, what);
  return { note: say, changed: r.changed, target, debug: r.note };
}

// ---- the writer's jobs ---------------------------------------------------------------------
async function writeJob(ctx) {
  const { d, fallbackTarget, depth, marked } = ctx;
  if (!llmKey) return { note: W.reply.notSetUp, debug: "this needs writing, and there is no ANTHROPIC_API_KEY — start with --env", blocked: true };
  // An empty canvas builds, whatever the sentence: there is nothing else it could be about and
  // nothing to lose, so "start a new app?" has no decision behind it (plan §3B).
  if (!screenList().length) return build(ctx);
  // Jev's answer stands. Below its threshold the person says what kind of change it is — unless
  // the thing it acts on is known already (the marked element the sentence points at, or the one
  // an escalated edit was aimed at): then Jev's top answer is taken (plan §3B), when it is a change
  // to this app. A new app from a sentence about one of its elements is not taken on a low score.
  const known = fallbackTarget || (marked && d.points != null && d.points >= POINTS);
  const job = d.jobConfidence >= ACT_JOB || (known && ["add", "rewrite", "several"].includes(d.job)) ? d.job : null;
  // A new app on a full canvas replaces it, and the old one is offered back (build).
  if (job === "new_app") return build(ctx);
  if (job === "add") return addPiece(ctx);
  if (job === "rewrite") return rewritePiece(ctx);
  if (job === "several") {
    if (depth > 0) return { note: W.reply.tooMany, changed: false };
    return several(ctx);
  }
  return asking(W.ask.job, [
    answer(W.ask.jobAdd, { kind: "job", job: "add" }, true),
    answer(W.ask.jobChange(root, fallbackTarget), { kind: "job", job: "rewrite" }),
    answer(W.ask.jobSeveral, { kind: "job", job: "several" }),
    answer(W.ask.jobNewApp, { kind: "start" }),
    cancel(),
  ], { keep: ctx });
}

// A new app, drawn line by line as the writer streams it onto an empty canvas. What it runs on is
// Jev's answer when Jev is sure of it; otherwise the writer's. On a full canvas it replaces the app
// there, which is offered back ("Bring back “Relay”") — until there is a project list to keep it in.
async function build({ utterance, started, d }) {
  const before = root;
  const was = screenList().length ? String(root.text ?? "") : null;
  past.push(before);
  const stream = new Stream();
  let screens = 0;
  const replies = [];
  const frame = d?.frame && d.frameConfidence >= ACT_FRAME ? d.frame : null;
  let t;
  try {
    t = await writeApp({
      utterance, frame, apiKey: llmKey, model: LLM,
      onLine: (line) => {
        if (/^\s*\/\//.test(line)) { replies.push(line.replace(/^\s*\/\/\s*/, "")); return; }
        const { node } = stream.push(line);
        root = stream.root;
        if (node?.type === "screen") { screens += 1; drawing = node.text ?? ""; log.push({ op: "screen", note: `screen "${node.text ?? ""}"`, source: WHO }); }
        announceSoon();
      },
    });
  } catch (e) {
    // A build that breaks off leaves the app that was there, not half of a new one.
    root = before;
    past.pop();
    announceNow();
    throw e;
  }
  announceNow();
  if (!screenList().length) {
    root = before;
    past.pop();
    announce();
    note({ op: "said", note: replies.join(" ") || `${WHO} wrote no screens`, source: WHO });
    note({ op: "done", note: `no build · ${secsSince(started)}`, source: "canvas" });
    return { note: replies.join(" ") || W.reply.wroteNothing, debug: `${WHO} wrote no screens`, changed: false };
  }
  const warn = stream.warnings.length ? ` · ${stream.warnings.length} parser warnings` : "";
  note({ op: "done", note: `built "${root.text}"${frame ? ` (${frame}, as Jev decided)` : ""}: ${screens} screens, ${index(root).length - 1} nodes from ${t.lines} lines (first at ${t.firstLineMs} ms, ${t.outputTokens} tokens) · ${secsSince(started)}${warn}`, source: "canvas" });
  for (const w of stream.warnings.slice(0, 5)) note({ op: "said", note: `parser: ${w}`, source: "tree" });
  if (was != null) offer = [{ label: W.reply.bringBack(was), post: { path: "/undo", body: {} } }];
  return { note: W.reply.built(root, screens) + (was != null ? ` ${W.reply.replaced(was)}` : ""), changed: true, offer, debug: `built in ${secsSince(started)}` };
}

// Which screen a sentence is about: the marked element's when it points at it, Jev's answer when
// Jev is sure, the screen of the element it places something next to when Jev is sure of that
// ("under the address" — the address is on one screen), and otherwise the person's choice among
// Jev's likeliest — a question, returned as is. A move stays on its element's screen (`fallback`)
// unless the sentence names another.
function pickScreen(ctx, fallback = null) {
  const { d, marked, viewing } = ctx;
  if (marked && d.points != null && d.points >= POINTS) return screenOf(marked);
  const known = (n) => screenList().some((s) => s.text === n);
  if (d.screen && d.screenConfidence >= ACT_SCREEN && known(d.screen)) return d.screen;
  if (fallback && known(fallback)) return fallback;
  if (d.anchorScreen && d.anchorConfidence >= ACT_SCREEN && known(d.anchorScreen)) {
    note({ op: "place", note: `on ${d.anchorScreen}, where what it names is`, conf: d.anchorConfidence, source: `jev · screen of what it names ${d.anchorConfidence.toFixed(2)}`, said: ctx.utterance });
    return d.anchorScreen;
  }
  const top = Object.entries(d.screens ?? {}).sort((a, b) => b[1] - a[1]).map(([n]) => n).filter(known).slice(0, 3);
  const likely = top.length ? top : screenList().slice(0, 3).map((s) => s.text);
  return asking(W.ask.page(root), [
    ...likely.map((n, i) => answer(W.ask.pageChoice(root, n, viewing), { kind: "screen", screen: n }, i === 0)),
    cancel(),
  ], { keep: ctx });
}

// Where a whole new screen goes: Jev picks a gap between screens; below ACT_GAP the person picks
// from Jev's three likeliest. Returns the gap, or a question.
async function pickScreenGap(ctx, list) {
  const p = await place({ utterance: ctx.utterance, gaps: list, screen: null, apiKey });
  note({ op: "place", note: `${list[p.index]?.text ?? "?"}`, conf: p.confidence, ms: p.ms, source: `jev · gap ${p.confidence.toFixed(2)} of ${list.length} · ${p.ms} ms`, said: ctx.utterance });
  if (p.index >= 0 && p.confidence >= ACT_GAP) return list[p.index];
  const top = p.ranked.slice(0, 3).map((i) => list[i]);
  return asking(W.ask.where,
    [...top.map((g, i) => answer(W.ask.whereChoice(root, g, i), { kind: "place", anchor: g.anchor, position: g.position, text: g.text }, i === 0)), cancel()],
    { pick: top.map((g) => g.anchor), keep: ctx });
}

// Where a new piece or a moved element goes on a screen, top down (tree.mjs partsOf / spotsIn):
// which part of the screen, then where in it, each Jev's choice among a few options; a level with
// one option needs no question. Only padded places are offered, so nothing lands against the
// artboard's edge. When Jev is unsure: a sentence that leaves the spot open (Jev's `open`) goes
// next to the element Jev says it belongs with, or else at the end of the part already chosen —
// the person never named a spot to be asked about; otherwise the person picks from Jev's three
// likeliest, and a "somewhere inside" answer carries on down from there (`from`). `skip` holds an
// element being moved. Returns a gap { anchor, position, text }, or a reply.
async function pickGap(ctx, screenName, { markedLine = null, kind = "place", extra = {}, skip = new Set(), from = null } = {}) {
  const screen = screenList().find((s) => s.text === screenName);
  if (!screen || (from && !find(root, from))) return { note: W.reply.gone, changed: false };
  let opts = from ? spotsIn(root, from, skip) : partsOf(root, screen.id, skip);
  let first = !from, within = from, open = null;
  // A screen with no padded part at all has only its own gaps to offer.
  if (!from && !opts.length) {
    const inside = new Set([...skip].flatMap((id) => { const h = find(root, id); return h ? index(h.node).map((n) => n.id) : []; }));
    opts = gaps(root, screen.id).filter((g) => !inside.has(g.anchor));
    first = false;
  }
  for (let depth = 0; depth < 12 && opts.length; depth++) {
    const s = opts.length === 1 ? { index: 0, confidence: 1, ranked: [0], ms: 0, open: null }
      : await spot({ utterance: ctx.utterance, options: opts, screen: screenName, marked: markedLine, first, withOpen: open == null, apiKey });
    if (open == null && s.open != null) open = s.open;
    const o = opts[s.index];
    note({ op: "place", note: o?.text ?? "?", conf: s.confidence, ms: s.ms, source: `jev · ${first ? "part" : "spot"} ${s.confidence.toFixed(2)} of ${opts.length} on ${screenName}${open != null ? ` · open ${open.toFixed(2)}` : ""} · ${s.ms} ms`, said: ctx.utterance });
    if (o && s.confidence >= ACT_GAP) {
      if (!o.into) return o;
      opts = [...spotsIn(root, o.into, skip), ...(first ? edgesOf(root, screen.id, o.into, skip) : [])];
      first = false;
      within = o.into;
      continue;
    }
    // Unsure even of the part, for an open sentence: which element on the whole screen it belongs
    // next to ("add a note to the Settings screen" came back unsure between a settings nav and the
    // content, and then chose the Settings title).
    if (open != null && open >= OPEN_SPOT) {
      const g = await openSpot(ctx, within ?? screen.id, screenName, markedLine, skip);
      if (g) return g;
    }
    const top = s.ranked.slice(0, 3).map((i) => opts[i]);
    return asking(W.ask.where,
      [...top.map((g, i) => answer(W.ask.whereChoice(root, g, i, skip), g.into ? { kind: `${kind}_in`, into: g.into, ...extra } : { kind, anchor: g.anchor, position: g.position, text: g.text, ...extra }, i === 0)), cancel()],
      { pick: top.map((g) => g.into ?? g.anchor), keep: ctx });
  }
  return { note: W.reply.noPlace(root, screenName), changed: false };
}

// A sentence that leaves the spot open, once its part is chosen: right after the element Jev says
// it belongs next to, or at the end of the part. null when neither is inside the padding.
async function openSpot(ctx, within, screenName, markedLine, skip) {
  const els = neighboursIn(root, within, skip);
  if (els.length) {
    const n = els.length === 1 ? { id: els[0].id, confidence: 1, ms: 0 } : await nextTo({ utterance: ctx.utterance, elements: els, screen: screenName, marked: markedLine, apiKey });
    const known = els.some((e) => e.id === n.id);
    note({ op: "place", note: known ? `next to ${lineOf(n.id)}` : "?", conf: n.confidence, ms: n.ms, source: `jev · open spot, belongs next to ${n.confidence.toFixed(2)} of ${els.length} · ${n.ms} ms`, said: ctx.utterance });
    if (known && n.confidence >= ACT_NEXT) return { anchor: n.id, position: "after", text: `right after ${lineOf(n.id)}` };
  }
  if (!padded(root, within)) return null;
  return { anchor: within, position: "inside_end", text: `at the end of ${lineOf(within)}` };
}

// A new piece: Jev decides whether it is a whole screen, which screen, and which gap; the writer
// writes only the piece; code puts it there.
async function addPiece(ctx, chosen = null, chosenScreen = null) {
  const { d, marked } = ctx;
  let whole = ctx.whole ?? null;
  if (whole == null) {
    if (d.whole >= WHOLE_HI) whole = true;
    else if (d.whole <= WHOLE_LO) whole = false;
    else {
      const here = ctx.viewing ?? screenList()[0].text;
      return asking(W.ask.whole(root), [
        answer(W.ask.wholeNew(root), { kind: "whole", whole: true }, d.whole >= 0.5),
        answer(W.ask.wholeOn(root, here), { kind: "whole", whole: false }, d.whole < 0.5),
        cancel(),
      ], { keep: ctx });
    }
  }
  const next = { ...ctx, whole };
  let gap = chosen;
  if (!gap) {
    if (whole) gap = await pickScreenGap(next, screenGaps(root));
    else {
      // `from`: the person chose "somewhere inside" a container; placing carries on down from it.
      const screenName = ctx.from ? screenOf(ctx.from) : chosenScreen ?? pickScreen(next);
      if (typeof screenName !== "string") return screenName;
      const pointed = marked && d.points != null && d.points >= POINTS;
      gap = await pickGap(next, screenName, { markedLine: pointed ? `${lineOf(marked)} (#${marked})` : null, from: ctx.from ?? null });
    }
    if (!gap.anchor) return gap;
  }
  if (!find(root, gap.anchor)) return { note: W.reply.gone, changed: false };
  let w = await writePiece({ utterance: ctx.utterance, outline: serialize(root, { ids: false }), where: gap.text, screen: whole, apiKey: llmKey, model: LLM });
  // The piece must be the shape Jev decided on. Once more with the shape spelled out, and then no.
  if (wrongShape(w.text, whole)) w = await writePiece({ utterance: ctx.utterance, outline: serialize(root, { ids: false }), where: gap.text, screen: whole, retry: true, apiKey: llmKey, model: LLM });
  if (wrongShape(w.text, whole)) {
    note({ op: "said", note: `${WHO} wrote ${whole ? "no screen line" : "a whole screen"} twice — nothing changed`, source: "canvas", refused: true });
    return { note: W.reply.missed, debug: `the writer did not write ${whole ? "a screen" : "a piece for a screen"}`, changed: false };
  }
  return landPiece(next, w, placeEverywhere(gap.anchor, gap.position, w.text), { debug: `added ${gap.text}`, where: W.place(root, gap) });
}

// A piece written as a whole screen starts with a screen line; one for an existing screen has none.
function wrongShape(text, whole) {
  if (/^\s*\/\//.test(text)) return false;
  const top = text.split("\n").filter((l) => l.trim() && !/^\s/.test(l));
  const screens = top.filter((l) => /^screen\b/i.test(l)).length;
  return whole ? !/^screen\b/i.test(top[0] ?? "") : screens > 0;
}

// A rewrite: Jev chooses the element (the marked one when the sentence points at it, the one an
// escalated edit was already aimed at, else Jev's choice among the elements of the kind it named),
// the writer writes its replacement, code swaps it in.
async function rewritePiece(ctx, chosen = null) {
  const { utterance, marked, d, fallbackTarget } = ctx;
  const pointed = marked && d.points != null && d.points >= POINTS;
  const target = chosen ?? (pointed ? marked : fallbackTarget ?? await choose(ctx, { body: (id) => ({ kind: "rewrite", target: id }) }));
  if (typeof target !== "string") return target;
  const hit = find(root, target);
  if (!hit) return { note: W.reply.gone, changed: false };
  const isScreen = hit.node.type === "screen";
  const args = { utterance, outline: serialize(root, { ids: false }), replacing: serialize(hit.node, { ids: false }), screen: isScreen, apiKey: llmKey, model: LLM };
  let w = await writePiece(args);
  if (wrongShape(w.text, isScreen)) w = await writePiece({ ...args, retry: true });
  // A screen's replacement that still arrives without its screen line keeps the screen, with the
  // piece inside it: structure, so that a rewrite never dissolves a screen into its neighbours.
  let text = w.text;
  if (isScreen && wrongShape(text, true)) text = `screen "${String(hit.node.text ?? "").replace(/"/g, "'")}"\n` + text.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n");
  if (!isScreen && wrongShape(text, false)) {
    return { note: W.reply.missed, debug: "the writer wrote a whole screen for one element", changed: false };
  }
  return landPiece(ctx, { ...w, text }, placeEverywhere(target, "replace", text), { debug: `rewrote ${lineOf(target)}`, changed: W.name(root, target) });
}

// A move to a place the sentence names: Jev picks the place on the element's screen (top down, as
// for a new piece, with the element itself left out of the places), and code moves the element
// there with its ids, so it is the same element afterwards. A place that is where it already is
// ("move it to the top" for the first item of a column) is said, not done.
async function movePiece(ctx, target, chosen = null, chosenScreen = null) {
  const hit = find(root, target);
  if (!hit) return { note: W.reply.gone, changed: false };
  let gap = chosen;
  if (!gap) {
    const screenName = ctx.from ? screenOf(ctx.from) : chosenScreen ?? pickScreen(ctx, screenOf(target));
    if (typeof screenName !== "string") {
      // The person's screen answer comes back to this move, not to a new piece.
      if (pending) pending.moving = target;
      return screenName;
    }
    gap = await pickGap(ctx, screenName, { markedLine: `${lineOf(target)} (#${target}), the element being moved`, kind: "move", extra: { target }, skip: new Set([target]), from: ctx.from ?? null });
    if (!gap.anchor) return gap;
  }
  const text = serialize(hit.node);
  const without = applyPatch(root, `remove ${target}\n`).root;
  if (!find(without, gap.anchor)) return { note: W.reply.gone, changed: false };
  const r = applyPatch(without, placeAt(without, gap.anchor, gap.position, text));
  const what = W.name(root, target);
  if (serialize(r.root) === serialize(root)) {
    note({ op: "move", note: `${lineOf(target)} is already ${gap.text}`, said: ctx.utterance, target, source: "jev · where it goes", refused: true });
    return { note: W.reply.alreadyThere(what), changed: false };
  }
  const to = W.place(root, gap, new Set([target]));
  commit(r.root, { op: "move", note: `moved ${lineOf(target)} ${gap.text}`, said: ctx.utterance, target, source: "jev · where it goes" });
  note({ op: "done", note: `moved · ${secsSince(ctx.started)}`, source: "canvas" });
  return { note: W.reply.moved(what, to), changed: true, debug: `moved ${gap.text}` };
}

// Put a written piece where it was decided, or say why not. The person reads what was added and
// where (`where`, in words.mjs's words), or what was changed (`changed`, its name before).
function landPiece({ utterance, started }, w, placed, { debug, where = null, changed = null }) {
  const patch = placed?.patch ?? null;
  const copies = placed?.copies ?? 0;
  if (copies) debug += ` · and on ${copies} other screen${copies === 1 ? "" : "s"}, where it is shared`;
  if (!patch || /^\s*\/\//.test(w.text)) {
    // The writer answered in words instead of writing a piece; the person reads its words.
    const said = w.text.replace(/^\s*\/\/\s*/gm, "").trim();
    note({ op: "said", note: said || `${WHO} wrote nothing`, source: WHO });
    note({ op: "done", note: `no change · ${secsSince(started)}`, source: "canvas" });
    return { note: said || W.reply.wroteNothing, changed: false };
  }
  const say = changed != null ? W.reply.changed(root, changed, copies) : W.reply.added(root, W.pieceName(root, w.text), where, copies);
  const r = applyPatch(root, patch);
  commit(r.root, { op: "piece", note: `${debug} (${w.lines} lines from ${WHO}, ${w.ms} ms)`, said: utterance, source: `${WHO} → tree` });
  for (const x of r.warnings.slice(0, 5)) note({ op: "said", note: `parser: ${x}`, source: "tree", refused: true });
  note({ op: "done", note: `${debug} · ${secsSince(started)}`, source: "canvas" });
  return { note: say, changed: true, debug };
}

// Several changes: the writer cuts the sentence into single changes, keeping the person's own
// words for what they point at, and each goes back through Jev on its own, with the whole
// sentence as context.
async function several(ctx) {
  const s = await split({ utterance: ctx.utterance, marked: Boolean(ctx.marked), apiKey: llmKey, model: LLM });
  note({ op: "split", note: s.parts.join(" / "), source: `${WHO} · ${s.parts.length} parts · ${s.ms} ms`, said: ctx.utterance });
  if (!s.parts.length) return { note: W.reply.noChanges, changed: false };
  return runParts({ ctx, parts: s.parts, done: [], waiting: [], dropped: [] });
}

// The parts, in order. A part that needs the person waits for the answer, and so does a later part
// Jev says needs a waiting part done first ("add a card and make it bold"); the parts that do not
// go ahead meanwhile — "make the title bigger" no longer waits on where "add a filter" goes. Then
// the waiting parts are settled one at a time (nextPart).
async function runParts(rest) {
  const { ctx, parts } = rest;
  const done = [...rest.done], waiting = [...rest.waiting];
  for (let i = 0; i < parts.length; i++) {
    note({ note: parts[i], op: "ask", source: `part ${i + 1} of ${parts.length}` });
    const open = waiting.map((w) => w.i);
    if (open.length) {
      const dep = await needs({ utterance: parts[i], earlier: open.map((j) => parts[j]).join("; "), context: ctx.utterance, apiKey });
      const wait = dep.noul >= FIRE;
      note({ op: "route", route: wait ? "wait" : "go", note: wait ? `waits for part ${open.map((j) => j + 1).join(", ")}` : `does not need part ${open.map((j) => j + 1).join(", ")} — goes ahead`, source: `jev · needs an earlier part ${dep.noul.toFixed(2)} · ${dep.ms} ms`, said: parts[i] });
      if (wait) { waiting.push({ i, after: open }); continue; }
    }
    const r = await handle({ utterance: parts[i], marked: ctx.marked, viewing: ctx.viewing, started: ctx.started, depth: 1, context: ctx.utterance });
    if (r.choices) {
      // Its question is put later, in turn; the one open question is the next part's to set.
      waiting.push({ i, asked: { r, pending, question } });
      pending = null;
      question = null;
      continue;
    }
    done.push(r);
  }
  return nextPart({ ...rest, done, waiting });
}

// The next waiting part: its question, put to the person now, or — for a part that waited on
// another — the part itself, run now that what it needed is settled. A part whose earlier part the
// person left is dropped with it.
async function nextPart(rest) {
  const { ctx, parts } = rest;
  const done = [...rest.done], waiting = [...rest.waiting];
  const dropped = new Set(rest.dropped ?? []);
  const changed = () => done.some((r) => r.changed);
  while (waiting.length) {
    const w = waiting.shift();
    const left = waiting.length;
    const more = left ? W.reply.more(left) : "";
    const carry = { ctx, parts, done, waiting, dropped: [...dropped], current: w.i };
    if (w.asked) {
      pending = { ...w.asked.pending, rest: carry };
      question = w.asked.question;
      return { ...w.asked.r, note: w.asked.r.note + more, changed: changed() };
    }
    if (w.after.some((j) => dropped.has(j))) {
      note({ op: "route", route: "none", note: `part ${w.i + 1} left too: it needed part ${w.after.map((j) => j + 1).join(", ")}`, source: "canvas", said: parts[w.i] });
      dropped.add(w.i);
      continue;
    }
    note({ note: parts[w.i], op: "ask", source: `part ${w.i + 1} of ${parts.length}, now that the part it needed is settled` });
    const r = await handle({ utterance: parts[w.i], marked: ctx.marked, viewing: ctx.viewing, started: ctx.started, depth: 1, context: ctx.utterance });
    if (r.choices) {
      if (pending) pending.rest = carry;
      return { ...r, note: r.note + more, changed: changed() };
    }
    done.push(r);
  }
  return { note: done.map((r) => r.note).join(" ") || W.reply.nothingChanged, changed: changed() };
}

// The person's answer to a question the canvas asked.
async function onAnswer(body) {
  if (busy) {
    // Too soon: the question stays up, under the text box, to be answered when this finishes.
    return { note: W.reply.busyAnswer(busy), changed: false, ...(question ?? {}) };
  }
  if (!pending || body.q !== pending.q) {
    settle();
    return { note: W.reply.stale, changed: false, choices: [] };
  }
  // What the person picked, in the words they were offered, for the history they read.
  const picked = question?.choices.find((c) => JSON.stringify(c.post.body) === JSON.stringify(body))?.label ?? null;
  const human = (text) => note({ op: "human", note: text, source: "you", ...(picked ? { say: picked } : {}) });
  const ctx = pending;
  const rest = ctx.rest ?? null;
  settle();
  offer = null;
  if (body.kind === "cancel") {
    human("left as it is");
    if (!rest) { const r = { note: W.reply.left, changed: false }; said(r); return r; }
  }
  busy = ctx.utterance ?? body.kind;
  const next = { ...ctx, started: Date.now() };
  let r;
  try {
    r = await answered(body, next, rest, human);
  } catch (e) {
    note({ note: `error: ${e.message}`, op: "done", source: "canvas", refused: true });
    r = { note: W.reply.error, debug: e.message, changed: false, error: true };
  } finally {
    busy = null;
    drawing = null;
  }
  said(r);
  return r;
}

async function answered(body, next, rest, human) {
  let r;
  if (body.kind === "cancel") {
    // A part of a split sentence the person left: the other waiting parts are still theirs to
    // settle, and a part that needed this one is left with it.
    return await nextPart({ ...rest, dropped: [...(rest.dropped ?? []), rest.current] });
  } else if (body.kind === "apply") {
    human(body.target ? `you chose ${lineOf(body.target)}` : "you said yes");
    r = body.op === "clear" ? clearAll(next) : finishEdit(next, body.op, body.target, body.span ?? null, "jev's edit · your choice", true);
    if (r.moveTo) r = await movePiece(next, r.moveTo);
    else if (r.escalate) r = await writeJob({ ...next, fallbackTarget: r.target ?? null });
  } else if (body.kind === "proceed") {
    human("you said: change the mockup");
    r = await proceed(next, next.d.route !== "none" ? next.d.route : "write", "your answer");
  } else if (body.kind === "start") {
    human("you chose: start a new app");
    r = await build(next);
  } else if (body.kind === "whole") {
    human(body.whole ? "you chose: a new screen" : "you chose: on a screen that is there");
    r = await addPiece({ ...next, whole: body.whole });
  } else if (body.kind === "screen") {
    human(`you chose the ${body.screen} screen`);
    r = next.moving ? await movePiece(next, next.moving, null, body.screen) : await addPiece(next, null, body.screen);
  } else if (body.kind === "place") {
    human(`you chose: ${body.text}`);
    r = await addPiece(next, { anchor: body.anchor, position: body.position, text: body.text });
  } else if (body.kind === "place_in") {
    human(`you chose: somewhere in ${lineOf(body.into)}`);
    r = await addPiece({ ...next, from: body.into });
  } else if (body.kind === "move") {
    human(`you chose: ${body.text}`);
    r = await movePiece(next, body.target, { anchor: body.anchor, position: body.position, text: body.text });
  } else if (body.kind === "move_in") {
    human(`you chose: somewhere in ${lineOf(body.into)}`);
    r = await movePiece({ ...next, from: body.into }, body.target);
  } else if (body.kind === "rewrite") {
    human(`you chose ${lineOf(body.target)}`);
    r = await rewritePiece(next, body.target);
  } else if (body.kind === "job") {
    human(`you chose: ${body.job}`);
    r = await writeJob({ ...next, d: { ...next.d, job: body.job, jobConfidence: 1 } });
  } else {
    return { note: W.reply.stale, debug: `unknown answer ${body.kind}`, changed: false };
  }
  // The parts of a split sentence that were waiting on this answer carry on now.
  if (rest && !r.choices) return await nextPart({ ...rest, done: [...rest.done, r] });
  if (rest && r.choices && pending) pending.rest = rest;
  return r;
}

function clearAll(ctx) {
  const r = apply(root, "clear", null);
  if (r.changed) commit(r.root, { note: r.note, op: "clear", source: "jev's edit · your yes", said: ctx.utterance });
  else note({ note: r.note, op: "clear", refused: true });
  return { note: r.changed ? W.reply.edited(root, "clear") : W.reply.limit("clear", W.name(root, root.id)), changed: r.changed, debug: r.note };
}

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
  .pick{position:relative}
  .pick::after{content:attr(data-pick);position:absolute;top:-10px;left:-10px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center;z-index:9}
</style>
<script>
  const byId = (k) => document.querySelector('[data-id="' + CSS.escape(k) + '"]');
  addEventListener("click", (e) => {
    // An edge's label is drawn apart from its edge (so no line crosses it) and points back at it.
    const f = e.target.closest("[data-for]");
    const n = f ? byId(f.dataset.for) : e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll(".marked").forEach((m) => m.classList.remove("marked"));
    n.classList.add("marked");
    parent.postMessage({ type: "mark", key: n.dataset.id }, "*");
  }, true);
  addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "mark") {
      document.querySelectorAll(".marked").forEach((n) => n.classList.remove("marked"));
      if (m.key) byId(m.key)?.classList.add("marked");
    }
    if (m.type === "pick") {
      document.querySelectorAll(".pick").forEach((n) => { n.classList.remove("pick"); n.removeAttribute("data-pick"); });
      (m.keys || []).forEach((k, i) => { const n = byId(k); if (n) { n.classList.add("pick"); n.dataset.pick = i + 1; } });
    }
  });
</script>`;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      // The page's own words ({{placeholder}} and the rest) are words.mjs's, like everything else.
      const escHtml = (t) => String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
      return res.end(readFileSync(join(HERE, "shell.html"), "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(W.ui, k) ? escHtml(W.ui[k]) : m)));
    }
    if (url.pathname === "/mock") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      let html;
      try { html = render(root); } catch (e) { html = `<!doctype html><body><pre style="color:#666">render failed: ${String(e.message).replace(/</g, "&lt;")}</pre></body>`; }
      return res.end(html.includes("</body>") ? html.replace("</body>", MARKER + "\n</body>") : html + MARKER);
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ rev, seq })}\n\n`);
      watchers.push(res);
      req.on("close", () => { const i = watchers.indexOf(res); if (i >= 0) watchers.splice(i, 1); });
      return;
    }
    if (url.pathname === "/state") {
      // `text` (the engine's line) and `kind` stay for trial/eval; the page shows `selected`.
      const els = nodes().map((n) => ({ key: n.id, id: n.id, screen: n.screen, kind: n.type, tier: "", text: n.line, selected: W.selected(root, n.id) }));
      return json(res, {
        title: root.text ?? "mock", heading: screenList().length ? root.text ?? W.ui.title : W.ui.title, status: W.status(root),
        elements: els, screens: screenList().length, log, busy, working: busy ? W.working(root, busy, drawing) : null,
        question, offer, jev: Boolean(apiKey), llm: llmKey ? LLM : null, canUndo: past.length > 0, out: OUT,
      });
    }
    if (url.pathname === "/ask" && req.method === "POST") return json(res, await ask(await body(req)));
    if (url.pathname === "/answer" && req.method === "POST") return json(res, await onAnswer(await body(req)));
    if (url.pathname === "/undo" && req.method === "POST") {
      if (busy) return json(res, { note: W.reply.busy(busy), changed: false });
      if (!past.length) return json(res, { note: W.reply.nothingToUndo, changed: false });
      settle();
      offer = null;
      root = past.pop();
      log.push({ note: "undone", op: "undo", source: "you", say: W.reply.undone });
      announce();
      return json(res, { note: W.reply.undone, changed: true, choices: [] });
    }
    // Start again on an empty canvas; the app that was there is one click away, as after a new app
    // replaced it. A project list keeps it for good (plan phase 3).
    if (url.pathname === "/new" && req.method === "POST") {
      if (busy) return json(res, { note: W.reply.busy(busy), changed: false });
      if (!screenList().length) return json(res, { note: W.reply.started(null), changed: false, choices: [] });
      const was = String(root.text ?? "");
      settle();
      past.push(root);
      root = blank();
      offer = [{ label: W.reply.bringBack(was), post: { path: "/undo", body: {} } }];
      log.push({ note: "new — the canvas emptied", op: "new", source: "you", say: W.reply.started(was) });
      announce();
      return json(res, { note: W.reply.started(was), changed: true, choices: [], offer });
    }
    if (url.pathname === "/save" && req.method === "POST") {
      writeFileSync(resolve(OUT), serialize(root));
      return json(res, { note: W.reply.saved(OUT), changed: false });
    }
    if (url.pathname === "/spec") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end(serialize(root));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    json(res, { note: W.reply.error, debug: e.message, changed: false, error: true }, 500);
  }
}).listen(PORT, () => {
  console.error(`trial: http://localhost:${PORT}  ·  jev ${apiKey ? "on" : "off (no key)"}  ·  writer ${llmKey ? LLM : "off (no key)"}  ·  save → ${OUT}`);
});
