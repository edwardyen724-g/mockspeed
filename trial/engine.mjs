// trial's engine — one project's canvas: its mock, its undo, the question waiting on the person, what
// is offered, the log. `project()` makes one; every piece of state lives inside it, so two projects in
// one process never touch each other (docs/plan-web-2026-09-26.md phase 3). trial/server.mjs is the
// http shell over a map of them.
//
//   const p = project({ root, apiKey, llmKey, model });
//   await p.ask({ utterance, marked, viewing });   p.state();   p.subscribe(({ rev, seq }) => …);
//
// Every decision about meaning is Jev's (trial/jev.mjs): whether a sentence is a request, where it
// goes (direct edit, writer, nothing), which job it is (new app, add a piece, rewrite a piece,
// several changes), which screen, which gap a new piece goes into, which element an edit acts on,
// and whether "this" points at the marked element. The writer (trial/writer.mjs) only writes — a
// whole app, one piece, or a sentence split into single changes. Code applies what was decided.
//
// Where Jev is not sure — which element, which page, where a new piece goes — its top pick is done
// and the runner-up comes back as an `offer`, a one-click swap the page shows next to the text box
// with Undo (trial/turn.mjs, docs/plan-web-2026-09-26.md §3A); a swap comes back to /swap. The
// person is asked first (`choices`, answered at /answer) only before a new app when Jev is torn
// between that and another kind of change, and before clearing on an unsure answer. An offer about
// an element or a place is also numbered in the mock, where a click takes it (plan §3D). When the
// element an edit acts on has twins — each card's price — Jev says whether the sentence means it or
// every one like it, and the other reading is offered (plan §4).
//
// Before an addition, Jev says whether the thing is on the mock already ("add our phone number" on a
// site that shows one): then it is shown, or moved to the place the sentence names, and a second one
// is offered (plan §3B, checkFirst). After every build and change, three next steps sit under the
// text box, one click each: the writer's, written in the same call (plan §3E).
//
// A clicked element gets a toolbar in the mock — bigger, smaller, bold, lighter, up, down, remove,
// "All 5 like this" — and double-clicking its words edits them in place (plan §3C). Those go to
// /edit and straight onto the tree: no Jev, no writer, free. Every string the person reads comes
// from trial/words.mjs; the log's own notes, Jev's scores and timings are for ?debug=1. Runs beside
// canvas/ so the two can be compared.

import { parse, Stream, serialize, index, find, describe, shapeOf, positionOf, applyPatch, apply, gaps, screenGaps, partsOf, spotsIn, edgesOf, neighboursIn, padded, firstCopy, sharedView, twinsOf } from "./tree.mjs";
import { decide, place, spot, nextTo, which, needs, every, already, KIND_TYPES } from "./jev.mjs";
import { writeApp, writePiece, split, MODEL } from "./writer.mjs";
import { Turn, replay, applyEverywhere, applyAll, placeEverywhere, relocate, redo } from "./turn.mjs";
import * as W from "./words.mjs";

// ---- policy ------------------------------------------------------------------------------
// Thresholds are policy, not model output. Below each one, nothing acts on Jev's answer alone: a
// request goes to the more capable handler, or Jev's top pick is done with the runner-up offered
// beside the reply as a swap (act, then offer — trial/turn.mjs).
const FIRE = 0.5;        // the request gate
const ACT_ROUTE = 0.6;   // docs' floor: below it, a request goes to the writer
const ACT_OP = 0.5;      // below it, the direct edit is not trusted; the writer takes the sentence
const ACT_TARGET = 0.7;  // below it, the marked element if the sentence points at it, else Jev's
                         // top pick with the next offered
const ACT_JOB = 0.6;     // below it, Jev's likeliest kind of change with the next offered
const NEAR_TIE = 0.2;    // a new app replaces the whole mock: when it is Jev's likeliest kind of
                         // change by less than this over the next, the person says which first
const ACT_SCREEN = 0.6;  // below it, Jev's likeliest page with the next offered
const ACT_GAP = 0.5;     // at each level of a placement, below it the runner-up is offered
                         // (measured: the doubtful placements came back at 0.27 and 0.38)
const OPEN_SPOT = 0.5;   // Jev's `open` at or above it: the sentence named no spot, so an unsure
                         // placement is not the person's question
const ACT_NEXT = 0.4;    // an open sentence goes right after the element Jev says it belongs next to
                         // at or above this, else to the end of its part (measured: a filter beside
                         // the search field came back at 0.33-0.86; a note's neighbour at 0.11-0.40)
const POINTS = 0.5;      // "this" / "it" means the marked element
const ACT_SPAN = 0.5;    // below it, a rename's new words are not trusted; the writer rewrites
const ACT_FRAME = 0.6;   // below it, what a new app runs on is left to the writer
const WHOLE_HI = 0.7;    // "a whole new screen" at or above this; "on a screen" at or below
const WHOLE_LO = 0.3;    // WHOLE_LO; in between, Jev's leaning with the other offered
const NOT_THERE = 0.3;   // Jev's `exists` below this: nothing is done to a stand-in for the thing
                         // named; the likeliest are offered
const ALL = 0.5;         // Jev's `every` at or above it: the edit is made to every one like it
                         // (tree.mjs twinsOf), with "just this one" offered; below, the reverse
                         // (measured: "one" sentences at most 0.06, "every" at least 0.49)
const THERE_AT = 0.5;    // Jev's `there` at or above it: what an addition asks for is on the mock
                         // already, and is shown or moved rather than written again (measured: there
                         // at least 0.65, not there at most 0.40 — trial/eval/probe-already.mjs)
const NAMES_PAGE = 0.5;  // Jev's `page` at or above it: the addition names a page for it to go on
                         // (measured: at least 0.94 when it does, at most 0.19 when not)
// A removal is done like any other edit, with Undo offered beside the reply.
const DESTRUCTIVE = new Set(["remove", "clear"]);
// The edits that step a property, and so can be tried on each candidate to see whether they would
// change it. A move or a removal changes anything; a rename needs its words.
const PROPERTY = new Set(["bigger", "smaller", "bold", "regular", "darker", "lighter", "wider", "narrower", "taller", "shorter"]);
// The toolbar on a clicked element (docs/plan-web-2026-09-26.md §3C): the direct edits a person can
// make with no words, in the order they are shown. Rename is double-click. No model is called.
const TOOLS = ["bigger", "smaller", "bold", "regular", "lighter", "darker", "move_earlier", "move_later", "remove"];

export const blank = () => parse('app "new" web').root;

// A project: `root` is the mock it opens with (an empty canvas when none). The keys and the writer's
// model are the process's, passed in; nothing here reads the environment, the disk or the network
// except through jev.mjs and writer.mjs.
export function project({ root: start = null, apiKey = null, llmKey = null, model = MODEL } = {}) {
  const LLM = model;
  const WHO = LLM.replace(/^claude-/, "").replace(/-\d+(-\d+)*$/, "");

  // ---- state -------------------------------------------------------------------------------
  let root = start ?? blank();
  const past = [];
  const log = [];
  let rev = 0, seq = 0, busy = null;
  // The sentence waiting on the person's choice, with Jev's decision about it, so the answer carries
  // on from there instead of asking Jev again.
  let pending = null;
  // What the page offers after acting — Jev's runner-ups as swaps, Undo, "Bring back “Relay”" once a
  // new app has replaced it. Unlike a question it waits on nothing: the next request, answer, swap or
  // undo clears it. `on` numbers each set, so a stale button says so instead of acting.
  let offer = null;
  let on = 0;
  // The sentence being answered (trial/turn.mjs): what each part changed and was unsure of, for swaps.
  let turn = null;
  // The page a build is drawing, for the line under the text box while it runs.
  let drawing = null;
  // The next steps offered under the text box (plan §3E): the writer's, kept with the mock they were
  // written for, so Undo brings back the ones that went with it. A change the writer did not write
  // keeps the ones before it; a step the person took is dropped. An empty canvas offers starters.
  const nextFor = new WeakMap();
  const nextSteps = () => (screenList().length ? W.chips(root, nextFor.get(root) ?? []) : W.starters);
  // Who hears about each change: the page's event stream, once per open tab.
  const listeners = new Set();

  function announce(specChanged = true) {
    if (specChanged) rev += 1;
    seq += 1;
    for (const fn of listeners) fn({ rev, seq });
  }
  // A build streams a line every few tens of milliseconds; the page redraws at most five times a
  // second, which is as fast as a person can follow and far cheaper than a reload per line.
  let soon = null;
  const announceSoon = () => { if (!soon) soon = setTimeout(() => { soon = null; announce(); }, 200); };
  const announceNow = () => { if (soon) { clearTimeout(soon); soon = null; } announce(); };

  function note(entry) { log.push(entry); if (log.length > 160) log.shift(); announce(false); }
  // `again` makes the same change on another canvas (turn.mjs `redo`), so a swap in an earlier part
  // of the sentence can make it again after.
  function commit(next, entry, again = null) {
    if (!nextFor.has(next)) nextFor.set(next, nextFor.get(root) ?? []);
    past.push(root);
    root = next;
    if (again) turn?.step(again, entry);
    log.push(entry);
    if (log.length > 160) log.shift();
    announce();
  }

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
  // An element with what holds it, so one card's price reads as that card's (jev.mjs `every`).
  const lineIn = (id) => { const h = find(root, id); return !h ? id : h.parent ? `${describe(h.node)} · in ${describe(h.parent)}` : describe(h.node); };
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

  // Where Jev is unsure, its top pick is done and this records the rest: `conf` is the top pick's
  // confidence, each alternative { label, body } is a swap — the body is what an answer to the old
  // question posted, so a swap goes through answered() like one.
  const doubt = (ctx, conf, alts, always = false) => turn?.doubt(conf, alts, ctx, always);
  const swapFor = (label, body) => ({ label, body });

  // What a swap is about, for the mock to show it where it is (plan §3D): the element it would act on
  // instead — numbered in the mock, and a click on it takes the swap — or the place it would put a
  // piece instead, drawn as a numbered line there. Nothing for a swap about one-or-every, a page or a
  // kind of change.
  function pointsAt(b) {
    if (!b || b.all !== undefined) return null;
    if ((b.kind === "apply" || b.kind === "rewrite") && b.target && find(root, b.target)) return { pick: b.target };
    if ((b.kind === "place_in" || b.kind === "move_in") && find(root, b.into)) return { pick: b.into };
    if ((b.kind === "place" || b.kind === "move") && find(root, b.anchor)) return { drop: { anchor: b.anchor, position: b.position } };
    return null;
  }

  // What is offered once a sentence is done: for each part, the alternatives to the decision Jev was
  // least sure of; then Undo, which takes back the whole sentence, when it changed the mock and a
  // swap is offered or it removed something. A replaced app's "Bring back" stands in for Undo.
  function offering(r) {
    if (r.choices?.length) return r;
    on += 1;
    const swaps = r.error ? [] : (turn?.offers() ?? []).map(({ label, body: b, part, doubt: d, alt }) => ({ label, at: pointsAt(b), post: { path: "/swap", body: { on, part, doubt: d, alt } } }));
    const back = r.offer ?? [];
    const undo = r.changed && !back.length && (swaps.length || r.undo) ? [{ label: W.offer.undo, post: { path: "/undo", body: { on } } }] : [];
    offer = [...swaps, ...back, ...undo];
    const { undo: _, gap: __, ...rest } = r;
    return offer.length ? { ...rest, offer } : rest;
  }

  // ---- routing -----------------------------------------------------------------------------
  async function ask({ utterance, marked, viewing, chip = false }) {
    if (busy) return { note: W.reply.busy(busy), changed: false };
    if (!apiKey) return { note: W.reply.notSetUp, debug: "no TYPESAFE_API_KEY — start with --env", blocked: true };
    // A next step the person clicked is not offered again.
    if (chip && nextFor.has(root)) nextFor.set(root, nextFor.get(root).filter((c) => c !== utterance));
    busy = utterance;
    settle();
    offer = null;
    turn = new Turn(root, past.length);
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
    r = offering(r);
    said(r);
    return r;
  }

  // The reply, in the history the person reads (the log's other entries are for ?debug=1).
  // A reply that shows the person something already there (`mark`) is not a refusal.
  function said(r) { note({ op: "reply", note: r.note, say: r.note, refused: r.changed === false && !r.choices?.length && !r.mark }); }

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
    // "Add our phone number above the hours" on a page that shows one reads to Jev as a move of it
    // (direct 0.87, move 0.92) while its job answer is add, and the move's element, found by its kind
    // ("group" at 0.47), was the whole column. An addition checks first (checkFirst): it moves the one
    // there when there is one, found by Jev's "which is it?", and adds one when not — both readings.
    if (route === "direct" && (d.op === "move_earlier" || d.op === "move_later") && d.dest >= FIRE && d.job === "add") {
      note({ op: "route", route: "write", note: "an addition read as a move — checked before adding instead", source: why, said: utterance });
      route = "write";
    }
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
    // Clearing on a sure answer is done, with Undo beside the reply. On an unsure one it is asked
    // about, never quietly handed to the writer.
    if (d.op === "clear") {
      if (d.opConfidence >= ACT_OP) return clearAll(ctx);
      return asking(W.ask.clear, [answer(W.ask.clearYes, { kind: "apply", op: "clear" }, true), cancel()], { keep: ctx });
    }
    if (!nodes().length) return escalate("the canvas is empty");
    if (d.op === "none" || d.opConfidence < ACT_OP) return escalate(`no single edit (${d.op} ${d.opConfidence.toFixed(2)})`);

    const pointed = marked && d.points != null && d.points >= POINTS;
    // The sentence points at the marked element and also names a different one: the marked one is
    // acted on and the named one offered — unless it is a move that names where to go, where the
    // named one is the destination ("move this next to the search bar").
    const moveTo = (d.op === "move_earlier" || d.op === "move_later") && d.dest >= FIRE;
    if (pointed && d.targetConfidence >= ACT_TARGET && d.target !== marked && !moveTo && find(root, d.target)) {
      doubt(ctx, Math.min(d.points, d.targetConfidence), [swapFor(W.offer.target(root, d.target), { kind: "apply", op: d.op, target: d.target, span: d.span })]);
    }
    const target = pointed ? marked : await choose(ctx, { op: d.op, body: (id) => ({ kind: "apply", op: d.op, target: id, span: d.span }) });
    if (typeof target !== "string") return target;
    return editWith(ctx, d.op, target, d.span, pointed ? `jev · the marked element (points ${d.points.toFixed(2)})` : "jev");
  }

  // ---- this one, or every one like it ---------------------------------------------------------
  // Once the element is known: when it has twins (tree.mjs twinsOf — each card's price when it is one
  // card's price), Jev says whether the sentence means it alone or every one like it, and the other
  // reading is offered beside the reply. Every one being changed, a pick between two of them is no
  // longer a choice, and is not offered. Returns true for every one.
  async function plural(ctx, op, target, span) {
    if (op === "clear") return false;
    const twins = twinsOf(root, target);
    if (twins.length < 2) return false;
    const { utterance, marked } = ctx;
    // The mark, when the person clicked one of them: "make the prices bigger" with one price marked.
    const clicked = marked && twins.includes(marked) ? lineIn(marked) : null;
    const e = await every({ utterance, target: lineIn(target), twins: twins.map(lineIn), marked: clicked, context: ctx.context, apiKey });
    const all = e.every >= ALL;
    note({ op: "twins", note: `${all ? "every one like it" : "this one"} · ${twins.length} alike`, conf: all ? e.every : 1 - e.every, ms: e.ms, source: `jev · every ${e.every.toFixed(2)} of ${twins.length} alike · ${e.ms} ms`, said: utterance });
    if (all) turn?.forget((a) => a.body?.kind === "apply" && twins.includes(a.body.target));
    // "Just this one" is the one the person clicked, when they clicked one of them.
    const one = marked && twins.includes(marked) ? marked : target;
    const label = all ? W.offer.justThis(root, one) : W.offer.allLike(root, target, twins.length);
    doubt(ctx, Math.max(e.every, 1 - e.every), [swapFor(label, { kind: "apply", op, target: all ? one : target, span, all: !all })]);
    return all;
  }

  // An edit once the element is known: a move to a named place and a rename without clear words go
  // elsewhere; otherwise one-or-every is settled (unless a swap already says which) and it is made.
  async function editWith(ctx, op, target, span, how, all) {
    const { d } = ctx;
    if (!find(root, target) && op !== "clear") return { note: W.reply.gone, changed: false };
    // A move that names where it should end up is a placement, not one step.
    if ((op === "move_earlier" || op === "move_later") && d.dest >= FIRE) return { moveTo: target };
    if (op === "rename" && (!span || d.spanConfidence < ACT_SPAN)) return { escalate: "rename without clear new words", target };
    // An edit that does not apply to it ("bigger" on a picture) goes to the writer, which rewrites
    // that one; one-or-every is not asked about an edit that will not be made.
    const tried = op === "clear" ? null : applyEverywhere(root, op, target, span);
    if (tried && !tried.changed && !tried.limit) return { escalate: tried.note, target };
    if (all === undefined) all = await plural(ctx, op, target, span);
    return finishEdit(ctx, op, target, span, how, all);
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

  // The element an unmarked sentence means: Jev chooses among the candidates. Unsure, its top pick is
  // still taken and the next likeliest offered (what the edit would change before what is already as
  // far as it goes). When its answer to "is it on the mockup at all?" says no, nothing is done to a
  // stand-in: the reply says so and the likeliest are offered. Returns an id, or a reply. `body(id)`
  // is what a swap posts; `op` is the edit (none for a rewrite, which the person reads as "change").
  async function choose(ctx, { op = null, body }) {
    const { d, utterance } = ctx;
    if (d.kind === "screen") {
      const idOf = (n) => screenList().find((x) => x.text === n).id;
      const s = pickScreen(ctx, null, { body: (n) => body(idOf(n)), label: (n) => W.offer.target(root, idOf(n)) });
      return typeof s === "string" ? idOf(s) : s;
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
    const ranked = w.ranked.map((id) => pool.find((n) => n.id === id)).filter(Boolean);
    const order = [...ranked.filter((n) => !n.limit), ...ranked.filter((n) => !!n.limit)];
    const pages = (n) => (screenList().length > 1 ? n.pages : []);
    if (d.exists < NOT_THERE) {
      const top = order.slice(0, 3);
      const named = W.distinct(root, top.map((n) => n.id));
      doubt(ctx, 0, top.map((n, i) => swapFor(W.offer.doIt(root, op, n.id, named[i], pages(n)), body(n.id))));
      note({ op: "target", note: "not on the mockup: nothing done, the likeliest offered", source: `jev · exists ${d.exists.toFixed(2)}`, said: utterance, refused: true });
      return { note: W.reply.notSeen, changed: false };
    }
    const pick = known ? w.id : order[0]?.id;
    if (!pick) return { note: W.reply.noSuch(d.kind), changed: false };
    const alt = order.find((n) => n.id !== pick);
    if (alt) {
      const named = W.distinct(root, [pick, alt.id]);
      doubt(ctx, w.confidence, [swapFor(W.offer.target(root, alt.id, named[1], pages(alt)), body(alt.id))]);
    }
    note({ op: "target", note: `unsure: ${lineOf(pick)}${alt ? `, ${lineOf(alt.id)} offered` : ""}`, conf: w.confidence, source: "jev · top pick taken", said: utterance });
    return pick;
  }

  // ---- the edit ----------------------------------------------------------------------------
  // The edit once the element is known — from Jev, or from a swap: to it alone, or with `all` to every
  // one like it. An element drawn on several screens (tree.mjs `share=`) is one element: the edit is
  // made to every copy (turn.mjs applyEverywhere). A removal is done like any other edit, with Undo
  // beside the reply.
  function finishEdit(ctx, op, target, span, how, all = false) {
    const { utterance, d, marked } = ctx;
    const twins = all ? twinsOf(root, target) : [];
    const targets = twins.length >= 2 ? twins : [target];
    // Named before the edit: a removed or renamed thing is not there to be named by its old words
    // after. Every one being changed, it is named by the one the person clicked, if they clicked one.
    const what = W.name(root, targets.length > 1 && targets.includes(marked) ? marked : target);
    const across = find(root, target)?.parent?.type === "row";
    const r = applyAll(root, op, targets, span);
    // "already bold" is an answer; "has no set width" is a job for the writer, who can set one.
    if (!r.changed && !r.limit) return { escalate: r.note, target };
    const entry = { note: r.note, op, conf: d.opConfidence, ms: d.ms, source: how, said: utterance, target };
    if (r.changed) commit(r.root, entry, targets.length > 1 ? redo.edits(op, targets, span) : redo.edit(op, target, span)); else note({ ...entry, refused: true });
    const say = r.changed ? W.reply.edited(root, op, what, { copies: r.copies ?? 0, across, to: span, others: r.count - 1 }) : W.reply.limit(op, what, targets.length - 1);
    return { note: say, changed: r.changed, target, debug: r.note, undo: DESTRUCTIVE.has(op) };
  }

  // ---- the writer's jobs ---------------------------------------------------------------------
  async function writeJob(ctx) {
    const { d, fallbackTarget, depth, marked } = ctx;
    if (!llmKey) return { note: W.reply.notSetUp, debug: "this needs writing, and there is no ANTHROPIC_API_KEY — start with --env", blocked: true };
    // An empty canvas builds, whatever the sentence: there is nothing else it could be about and
    // nothing to lose, so "start a new app?" has no decision behind it (plan §3B).
    if (!screenList().length) return build(ctx);
    // Jev's answer stands. When the thing it acts on is known already (the marked element the
    // sentence points at, or the one an escalated edit was aimed at), its top answer is taken when it
    // is a change to this app (plan §3B).
    const known = fallbackTarget || (marked && d.points != null && d.points >= POINTS);
    let job = d.jobConfidence >= ACT_JOB || (known && ["add", "rewrite", "several"].includes(d.job)) ? d.job : null;
    if (!job || job === "none") {
      // Unsure what kind of change it is: Jev's likeliest kind is done and the next offered — except
      // a new app, which replaces the whole mock, when Jev is torn between that and another kind; then
      // the person says first (plan §3A). A new app is not an answer for a sentence about one of the
      // app's own elements, and a part of a split sentence is not split again.
      const ranked = Object.entries(d.jobs ?? {})
        .filter(([j]) => j !== "none" && !(known && j === "new_app") && !(depth > 0 && j === "several"))
        .sort((a, b) => b[1] - a[1]);
      const [top, next] = ranked;
      if (!top || (top[0] === "new_app" && next && top[1] - next[1] < NEAR_TIE)) {
        return asking(W.ask.job, [
          answer(W.ask.jobAdd, { kind: "job", job: "add" }, true),
          answer(W.ask.jobChange(root, fallbackTarget), { kind: "job", job: "rewrite" }),
          answer(W.ask.jobSeveral, { kind: "job", job: "several" }),
          answer(W.ask.jobNewApp, { kind: "start" }),
          cancel(),
        ], { keep: ctx });
      }
      job = top[0];
      if (next) doubt(ctx, d.jobConfidence, [swapFor(W.offer.job(root, next[0], fallbackTarget), { kind: "job", job: next[0] })]);
      note({ op: "route", route: job, note: `unsure what kind of change: ${job}${next ? `, ${next[0]} offered` : ""}`, source: `jev · job ${d.job} ${d.jobConfidence.toFixed(2)}`, said: ctx.utterance });
    }
    // A new app on a full canvas replaces it, and the old one is offered back (build).
    if (job === "new_app") return build(ctx);
    if (job === "add") return addPiece(ctx);
    if (job === "rewrite") return rewritePiece(ctx);
    // Several changes, split once: a part that is itself several is said back to the person.
    return depth > 0 ? { note: W.reply.tooMany, changed: false } : several(ctx);
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
    nextFor.set(root, t.next ?? []);
    note({ op: "said", note: `next: ${(t.next ?? []).join(" | ") || "none"}`, source: WHO });
    if (was != null) offer = [{ label: W.reply.bringBack(was), post: { path: "/undo", body: {} } }];
    return { note: W.reply.built(root, screens) + (was != null ? ` ${W.reply.replaced(was)}` : ""), changed: true, offer, debug: `built in ${secsSince(started)}` };
  }

  // Which screen a sentence is about: the marked element's when it points at it, Jev's answer when
  // Jev is sure, the screen of the element it places something next to when Jev is sure of that
  // ("under the address" — the address is on one screen), and otherwise Jev's likeliest, with the
  // next offered. A move stays on its element's screen (`fallback`) unless the sentence names
  // another. `body` and `label` make the swap: a piece or a move goes to the other page by default;
  // choose() passes its own, for a sentence about a whole page.
  function pickScreen(ctx, fallback = null, { body = (n) => ({ kind: "screen", screen: n }), label = (n) => W.offer.page(root, n) } = {}) {
    const { d, marked, viewing } = ctx;
    if (marked && d.points != null && d.points >= POINTS) return screenOf(marked);
    const known = (n) => screenList().some((s) => s.text === n);
    if (d.screen && d.screenConfidence >= ACT_SCREEN && known(d.screen)) return d.screen;
    if (fallback && known(fallback)) return fallback;
    if (d.anchorScreen && d.anchorConfidence >= ACT_SCREEN && known(d.anchorScreen)) {
      note({ op: "place", note: `on ${d.anchorScreen}, where what it names is`, conf: d.anchorConfidence, source: `jev · screen of what it names ${d.anchorConfidence.toFixed(2)}`, said: ctx.utterance });
      return d.anchorScreen;
    }
    const top = Object.entries(d.screens ?? {}).sort((a, b) => b[1] - a[1]).map(([n]) => n).filter(known);
    const likely = top.length ? top : [...new Set([viewing, ...screenList().map((s) => s.text)])].filter(known);
    const [pick, alt] = likely;
    if (alt) doubt(ctx, d.screenConfidence, [swapFor(label(alt), body(alt))]);
    note({ op: "place", note: `unsure of the page: ${pick}${alt ? `, ${alt} offered` : ""}`, conf: d.screenConfidence, source: `jev · screen ${d.screenConfidence.toFixed(2)} · top pick taken`, said: ctx.utterance });
    return pick;
  }

  // Where a whole new screen goes: Jev picks a gap between screens; below ACT_GAP its pick is still
  // taken and the next likeliest offered. Returns the gap, or a reply.
  async function pickScreenGap(ctx, list) {
    const p = await place({ utterance: ctx.utterance, gaps: list, screen: null, apiKey });
    note({ op: "place", note: `${list[p.index]?.text ?? "?"}`, conf: p.confidence, ms: p.ms, source: `jev · gap ${p.confidence.toFixed(2)} of ${list.length} · ${p.ms} ms`, said: ctx.utterance });
    const ranked = [p.index, ...p.ranked].filter((i, j, all) => i >= 0 && i < list.length && all.indexOf(i) === j).map((i) => list[i]);
    const [g, alt] = ranked;
    if (!g) return { note: W.reply.missed, debug: "jev chose no place for the new page", changed: false };
    if (p.confidence < ACT_GAP && alt) doubt(ctx, p.confidence, [swapFor(W.offer.place(root, alt), { kind: "place", anchor: alt.anchor, position: alt.position, text: alt.text })]);
    return g;
  }

  // Where a new piece or a moved element goes on a screen, top down (tree.mjs partsOf / spotsIn):
  // which part of the screen, then where in it, each Jev's choice among a few options; a level with
  // one option needs no question. Only padded places are offered, so nothing lands against the
  // artboard's edge. When Jev is unsure at a level: a sentence that leaves the spot open (Jev's
  // `open`) goes next to the element Jev says it belongs with, or else at the end of the part
  // already chosen, with Jev's pick at that level offered; otherwise Jev's pick is taken and the
  // runner-up offered — a "somewhere inside" swap carries on down from there (`from`). `skip` holds
  // an element being moved. Returns a gap { anchor, position, text }, or a reply.
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
    // A place offered instead: somewhere inside carries on down from there, a spot is final.
    const offerPlace = (conf, g) => doubt(ctx, conf, [swapFor(W.offer.place(root, g, skip),
      g.into ? { kind: `${kind}_in`, into: g.into, ...extra } : { kind, anchor: g.anchor, position: g.position, text: g.text, ...extra })]);
    for (let depth = 0; depth < 12 && opts.length; depth++) {
      const s = opts.length === 1 ? { index: 0, confidence: 1, ranked: [0], ms: 0, open: null }
        : await spot({ utterance: ctx.utterance, options: opts, screen: screenName, marked: markedLine, first, withOpen: open == null, apiKey });
      if (open == null && s.open != null) open = s.open;
      const ranked = [s.index, ...s.ranked].filter((i, j, all) => i >= 0 && i < opts.length && all.indexOf(i) === j).map((i) => opts[i]);
      const [o, runnerUp] = ranked;
      note({ op: "place", note: o?.text ?? "?", conf: s.confidence, ms: s.ms, source: `jev · ${first ? "part" : "spot"} ${s.confidence.toFixed(2)} of ${opts.length} on ${screenName}${open != null ? ` · open ${open.toFixed(2)}` : ""} · ${s.ms} ms`, said: ctx.utterance });
      if (!o) break;
      if (s.confidence < ACT_GAP) {
        // Unsure, for an open sentence: which element it belongs next to ("add a note to the Settings
        // screen" came back unsure between a settings nav and the content, and then chose the
        // Settings title). Jev's pick at this level is offered instead.
        if (open != null && open >= OPEN_SPOT) {
          const g = await openSpot(ctx, within ?? screen.id, screenName, markedLine, skip);
          if (g) {
            if (o.into || o.anchor !== g.anchor || o.position !== g.position) offerPlace(s.confidence, o);
            return g;
          }
        }
        if (runnerUp) offerPlace(s.confidence, runnerUp);
      }
      if (!o.into) return o;
      opts = [...spotsIn(root, o.into, skip), ...(first ? edgesOf(root, screen.id, o.into, skip) : [])];
      first = false;
      within = o.into;
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
  // writes only the piece; code puts it there. A swap to another place puts the same piece there
  // (`ctx.piece`, what this part wrote), rather than having it written again.
  async function addPiece(ctx, chosen = null, chosenScreen = null) {
    const { d, marked } = ctx;
    // Check before adding, unless the place was chosen or the person asked for a second one.
    if (!chosen && !chosenScreen && !ctx.from && ctx.check !== false) {
      const c = await checkFirst(ctx);
      if (c?.note) return c;
      if (c?.page) chosenScreen = c.page;
    }
    let whole = ctx.whole ?? null;
    if (whole == null) {
      whole = d.whole >= 0.5;
      // Unsure whether it is a page of its own: Jev's leaning is taken and the other offered.
      if (d.whole > WHOLE_LO && d.whole < WHOLE_HI) doubt(ctx, Math.max(d.whole, 1 - d.whole), [swapFor(W.offer.whole(root, !whole), { kind: "whole", whole: !whole })]);
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
    let w = ctx.piece?.whole === whole ? ctx.piece : null;
    if (w) note({ op: "said", note: "the same piece, put where the swap says", source: "canvas" });
    else {
      w = await writePiece({ utterance: ctx.utterance, outline: serialize(root, { ids: false }), where: gap.text, screen: whole, apiKey: llmKey, model: LLM });
      // The piece must be the shape Jev decided on. Once more with the shape spelled out, and then no.
      if (wrongShape(w.text, whole)) w = await writePiece({ utterance: ctx.utterance, outline: serialize(root, { ids: false }), where: gap.text, screen: whole, retry: true, apiKey: llmKey, model: LLM });
      if (wrongShape(w.text, whole)) {
        note({ op: "said", note: `${WHO} wrote ${whole ? "no screen line" : "a whole screen"} twice — nothing changed`, source: "canvas", refused: true });
        return { note: W.reply.missed, debug: `the writer did not write ${whole ? "a screen" : "a piece for a screen"}`, changed: false };
      }
    }
    if (turn) turn.current.piece = { ...w, whole };
    return landPiece(next, w, gap, { debug: `added ${gap.text}`, where: W.place(root, gap) });
  }

  // ---- check before adding (plan §3B) -------------------------------------------------------------
  // Before anything is written for an addition, Jev says whether the thing is on the mock already —
  // "add our phone number" on a site that shows one — which element it is, on any page, and whether
  // the sentence names a page or a place for it:
  //   it names neither                        → the one there is shown (selected, in view), nothing
  //                                             changes, and "Add another" is offered
  //   the page it asks for is the one's own   → the one there is moved to the place named, with "Keep
  //                                             both" offered; named no place on it, it is shown
  //   the page it asks for is another         → a new one is added there as asked: it is not there
  // A page, or a thing drawn on several pages, is never moved: it is shown. Returns a reply; or
  // { page }, the page an addition goes on, already chosen; or null to add as usual.
  async function checkFirst(ctx) {
    const all = nodes({ once: true });
    if (!all.length) return null;
    const a = await already({ utterance: ctx.utterance, nodes: all, viewing: ctx.viewing, apiKey });
    const id = a.there >= THERE_AT && all.some((n) => n.id === a.id) && find(root, a.id) ? a.id : null;
    note({ op: "check", note: id ? `already there: ${lineOf(id)}` : "not there yet — added", conf: a.there, ms: a.ms, source: `jev · there ${a.there.toFixed(2)} · it ${a.confidence.toFixed(2)} · open ${a.open.toFixed(2)} · page ${a.page.toFixed(2)} · ${a.ms} ms`, said: ctx.utterance });
    if (!id) return null;
    const view = sharedView(root);
    const pages = view.screens.get(id) ?? [screenOf(id)].filter(Boolean);
    const open = a.open >= OPEN_SPOT;
    const isPage = find(root, id).node.type === "screen";
    // A new page asked for, and what is there is part of one: the page is added, as asked.
    if (!isPage && (ctx.whole ?? ctx.d.whole >= 0.5)) return null;
    if (isPage || view.screens.has(id) || (open && a.page < NAMES_PAGE)) return pointOut(ctx, id, pages);
    const page = pickScreen(ctx);
    if (typeof page !== "string") return null;
    if (!pages.includes(page)) {
      note({ op: "check", note: `it is on ${pages.join(", ")}, not ${page} — added there as asked`, source: "canvas", said: ctx.utterance });
      return { page };
    }
    return open ? pointOut(ctx, id, pages) : moveExisting(ctx, id, page);
  }

  // The thing asked for, there already: shown, and a second one offered.
  function pointOut(ctx, id, pages) {
    doubt(ctx, 0, [swapFor(W.offer.another(root, id), { kind: "keep" })], true);
    note({ op: "check", note: `shown, not added: ${lineOf(id)}`, source: "canvas", said: ctx.utterance, target: id });
    return { note: W.reply.alreadyOn(root, id, pages), changed: false, mark: id, debug: `already there: ${lineOf(id)}` };
  }

  // The thing asked for, there already on the page, and the sentence names a place for it: it is moved
  // there, as a move would place it (tree.mjs partsOf / spotsIn, with it left out of the places), and
  // "Keep both" puts it back and adds a new one at that place.
  async function moveExisting(ctx, id, page) {
    const { d, marked } = ctx;
    const pointed = marked && d.points != null && d.points >= POINTS;
    // `kept`: another place taken instead is still a move of the one there, and still offers Keep both.
    const gap = await pickGap(ctx, page, { markedLine: pointed ? `${lineOf(marked)} (#${marked})` : null, kind: "move", extra: { target: id, kept: true }, skip: new Set([id]) });
    if (!gap.anchor) return gap;
    keepBoth(ctx, gap);
    const what = W.name(root, id);
    const moved = relocate(root, id, gap);
    if (!moved) return { note: W.reply.gone, changed: false };
    if (serialize(moved) === serialize(root)) {
      note({ op: "check", note: `${lineOf(id)} is already ${gap.text}`, source: "canvas", said: ctx.utterance, target: id });
      return { note: W.reply.alreadyThere(what), changed: false, mark: id };
    }
    const to = W.place(root, gap, new Set([id]));
    commit(moved, { op: "move", note: `already there — moved ${lineOf(id)} ${gap.text}`, said: ctx.utterance, target: id, source: "jev · already there, where it goes" }, redo.move(id, gap));
    note({ op: "done", note: `moved, not added · ${secsSince(ctx.started)}`, source: "canvas" });
    return { note: W.reply.alreadyMoved(what, to), changed: true, mark: id, debug: `moved ${gap.text}` };
  }

  // "Keep both": the one there put back where it was, and a new one written for the place it went to.
  const keepBoth = (ctx, gap) => doubt(ctx, 0, [swapFor(W.offer.keepBoth, { kind: "keep", anchor: gap.anchor, position: gap.position, text: gap.text })], true);

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
    return landPiece(ctx, { ...w, text }, { anchor: target, position: "replace" }, { debug: `rewrote ${lineOf(target)}`, changed: W.name(root, target) });
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
      // `moving`: a swap to another page comes back to this move, not to a new piece.
      const screenName = ctx.from ? screenOf(ctx.from) : chosenScreen ?? pickScreen({ ...ctx, moving: target }, screenOf(target));
      if (typeof screenName !== "string") return { note: W.reply.gone, changed: false };
      gap = await pickGap(ctx, screenName, { markedLine: `${lineOf(target)} (#${target}), the element being moved`, kind: "move", extra: { target }, skip: new Set([target]), from: ctx.from ?? null });
      if (!gap.anchor) return gap;
    }
    const moved = relocate(root, target, gap);
    if (!moved) return { note: W.reply.gone, changed: false };
    const r = { root: moved };
    const what = W.name(root, target);
    if (serialize(r.root) === serialize(root)) {
      note({ op: "move", note: `${lineOf(target)} is already ${gap.text}`, said: ctx.utterance, target, source: "jev · where it goes", refused: true });
      return { note: W.reply.alreadyThere(what), changed: false };
    }
    const to = W.place(root, gap, new Set([target]));
    commit(r.root, { op: "move", note: `moved ${lineOf(target)} ${gap.text}`, said: ctx.utterance, target, source: "jev · where it goes" }, redo.move(target, gap));
    note({ op: "done", note: `moved · ${secsSince(ctx.started)}`, source: "canvas" });
    return { note: W.reply.moved(what, to), changed: true, debug: `moved ${gap.text}`, gap };
  }

  // Put a written piece where it was decided (`at`: { anchor, position }), or say why not. The person
  // reads what was added and where (`where`, in words.mjs's words), or what was changed (`changed`,
  // its name before).
  function landPiece({ utterance, started }, w, at, { debug, where = null, changed = null }) {
    const placed = placeEverywhere(root, at.anchor, at.position, w.text);
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
    if (w.next?.length) nextFor.set(r.root, w.next);
    commit(r.root, { op: "piece", note: `${debug} (${w.lines} lines from ${WHO}, ${w.ms} ms)`, said: utterance, source: `${WHO} → tree` }, redo.place(at.anchor, at.position, w.text));
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
      turn?.open(root, past.length);
      const r = await handle({ utterance: parts[i], marked: ctx.marked, viewing: ctx.viewing, started: ctx.started, depth: 1, context: ctx.utterance });
      if (r.choices) {
        // Its question is put later, in turn; the one open question is the next part's to set.
        waiting.push({ i, asked: { r, pending, question }, at: turn?.at });
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
        // What its answer does, and is unsure of, belongs to its own part.
        if (turn && w.at != null) turn.at = w.at;
        return { ...w.asked.r, note: w.asked.r.note + more, changed: changed() };
      }
      if (w.after.some((j) => dropped.has(j))) {
        note({ op: "route", route: "none", note: `part ${w.i + 1} left too: it needed part ${w.after.map((j) => j + 1).join(", ")}`, source: "canvas", said: parts[w.i] });
        dropped.add(w.i);
        continue;
      }
      note({ note: parts[w.i], op: "ask", source: `part ${w.i + 1} of ${parts.length}, now that the part it needed is settled` });
      turn?.open(root, past.length);
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
    r = offering(r);
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
      r = body.op === "clear" ? clearAll(next) : await editWith(next, body.op, body.target, body.span ?? null, "jev's edit · your choice", body.all);
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
      r = await addPiece({ ...next, whole: body.whole, check: false });
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
      if (body.kept && r.gap) keepBoth(next, r.gap);
    } else if (body.kind === "move_in") {
      human(`you chose: somewhere in ${lineOf(body.into)}`);
      r = await movePiece({ ...next, from: body.into }, body.target);
      if (body.kept && r.gap) keepBoth(next, r.gap);
    } else if (body.kind === "rewrite") {
      human(`you chose ${lineOf(body.target)}`);
      r = await rewritePiece(next, body.target);
    } else if (body.kind === "keep") {
      // A second one, as the sentence asked: at the place it was moved to, or wherever it goes.
      human("you chose: a second one");
      r = await addPiece({ ...next, check: false }, body.anchor ? { anchor: body.anchor, position: body.position, text: body.text } : null);
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
    if (r.changed) commit(r.root, { note: r.note, op: "clear", source: "jev's edit", said: ctx.utterance }, redo.clear());
    else note({ note: r.note, op: "clear", refused: true });
    return { note: r.changed ? W.reply.edited(root, "clear") : W.reply.limit("clear", W.name(root, root.id)), changed: r.changed, debug: r.note, undo: true };
  }

  // A swap: the part goes back to how it was before, the alternative is done instead — as the answer
  // to the question it replaced — and the later parts' changes are made again after it.
  async function swap({ on: n, part, doubt: d, alt }) {
    if (busy) return { note: W.reply.busy(busy), changed: false };
    const back = n === on ? turn?.rewind(part, d, alt) : null;
    if (!back) {
      offer = null;
      return { note: W.reply.offerGone, changed: false, choices: [] };
    }
    settle();
    offer = null;
    busy = back.ctx.utterance ?? back.alt.label;
    note({ op: "human", note: `you took: ${back.alt.label}`, source: "you", say: back.alt.label });
    root = back.snap.root;
    past.length = back.snap.depth;
    announce();
    let r;
    try {
      r = await answered(back.alt.body, { ...back.ctx, started: Date.now(), piece: back.piece }, null, () => {});
      // The later parts' changes, made again on the swapped canvas, each in its own part's record.
      if (back.later.length) turn.open(root, past.length);
      for (const { step, root: next } of replay(root, back.later)) {
        if (next) commit(next, { ...step.entry, source: `${step.entry.source ?? ""} · made again after the swap` }, step.redo);
        else note({ ...step.entry, note: `${step.entry.note} — no longer there to make again after the swap`, refused: true });
      }
    } catch (e) {
      note({ note: `error: ${e.message}`, op: "done", source: "canvas", refused: true });
      r = { note: W.reply.error, debug: e.message, changed: false, error: true };
    } finally {
      busy = null;
      drawing = null;
    }
    r = offering({ ...r, changed: true });
    said(r);
    return r;
  }

  // ---- the toolbar and in-place words (plan §3C) ---------------------------------------------
  // What the toolbar on a clicked element offers: each edit that would change it and, when it has
  // twins, each that would change at least one of them — shown once "All 5 like this" is on. `text`
  // is its words, for a double-click to edit in place (null for what has none to edit).
  const RENAMES = new Set(["text", "button", "input", "node", "shape", "progress", "chart"]);
  function toolsFor(id) {
    const h = find(root, id);
    if (!h || h.node.type === "app" || h.node.type === "screen") return { id, tools: [], twins: [], allTools: [], text: null };
    const across = h.parent?.type === "row";
    const twins = twinsOf(root, id);
    const label = (op) => ({ op, label: W.tool.label(op, across) });
    const tools = TOOLS.filter((op) => apply(root, op, id).changed).map(label);
    const allTools = twins.length >= 2 ? TOOLS.filter((op) => applyAll(root, op, twins).changed).map(label) : [];
    const text = RENAMES.has(h.node.type) ? String(h.node.text ?? "") : null;
    return { id, tools, twins, allTools, allLabel: twins.length >= 2 ? W.tool.all(twins.length) : null, text, renameHint: text != null ? W.tool.renameHint : null };
  }

  // A toolbar button or a double-clicked name: the edit, straight on the tree — no Jev, no writer, so
  // free and instant. It ends the sentence before it (its swaps would go back past it), and is a turn
  // of its own, so a removal gets Undo beside the reply like any other.
  function toolEdit({ op, target, all = false, text = null }) {
    if (busy) return { note: W.reply.busy(busy), changed: false };
    if (!TOOLS.includes(op) && op !== "rename") return { note: W.reply.stale, debug: `no tool ${op}`, changed: false };
    if (!find(root, target)) return { note: W.reply.gone, changed: false };
    const arg = op === "rename" ? String(text ?? "").trim() : null;
    if (op === "rename" && !arg) return { note: W.reply.nothingChanged, changed: false };
    offer = null;
    turn = new Turn(root, past.length);
    const twins = all ? twinsOf(root, target) : [];
    const targets = twins.length >= 2 ? twins : [target];
    const what = W.name(root, target);
    const across = find(root, target).parent?.type === "row";
    const x = applyAll(root, op, targets, arg);
    let r;
    if (!x.changed) {
      r = { note: x.limit ? W.reply.limit(op, what, targets.length - 1) : W.reply.nothingChanged, debug: x.note, changed: false };
    } else {
      commit(x.root, { note: x.note, op, source: "you · toolbar, no model", target }, targets.length > 1 ? redo.edits(op, targets, arg) : redo.edit(op, target, arg));
      r = offering({ note: W.reply.edited(root, op, what, { copies: x.copies ?? 0, across, to: arg, others: x.count - 1 }), changed: true, debug: x.note, undo: DESTRUCTIVE.has(op) });
    }
    said(r);
    return r;
  }

  // ---- undo, start again, what the page reads -------------------------------------------------
  // The Undo button takes back one change; the Undo offered beside a reply (`on`) takes back that
  // whole sentence, all its parts.
  function undo(b = {}) {
    if (busy) return { note: W.reply.busy(busy), changed: false };
    const whole = b.on != null;
    if (whole && (b.on !== on || !turn)) { offer = null; return { note: W.reply.offerGone, changed: false, choices: [] }; }
    if (!whole && !past.length) return { note: W.reply.nothingToUndo, changed: false };
    settle();
    offer = null;
    if (whole) { root = turn.parts[0].snap.root; past.length = turn.parts[0].snap.depth; } else root = past.pop();
    turn = null;
    log.push({ note: whole ? "the whole sentence undone" : "undone", op: "undo", source: "you", say: W.reply.undone });
    announce();
    return { note: W.reply.undone, changed: true, choices: [] };
  }

  // Start again on an empty canvas; the app that was there is one click away, as after a new app
  // replaced it. A project list keeps it for good (plan phase 4).
  function startAgain() {
    if (busy) return { note: W.reply.busy(busy), changed: false };
    if (!screenList().length) return { note: W.reply.started(null), changed: false, choices: [] };
    const was = String(root.text ?? "");
    settle();
    turn = null;
    past.push(root);
    root = blank();
    offer = [{ label: W.reply.bringBack(was), post: { path: "/undo", body: {} } }];
    log.push({ note: "new — the canvas emptied", op: "new", source: "you", say: W.reply.started(was) });
    announce();
    return { note: W.reply.started(was), changed: true, choices: [], offer };
  }

  // What the page reads after every change. `text` (the engine's line) and `kind` stay for
  // trial/eval; the page shows `selected`.
  function state() {
    const els = nodes().map((n) => ({ key: n.id, id: n.id, screen: n.screen, kind: n.type, tier: "", text: n.line, selected: W.selected(root, n.id) }));
    return {
      title: root.text ?? "mock", heading: screenList().length ? root.text ?? W.ui.title : W.ui.title, status: W.status(root),
      elements: els, screens: screenList().length, log, busy, working: busy ? W.working(root, busy, drawing) : null,
      question, offer, next: busy || question ? [] : nextSteps(), jev: Boolean(apiKey), llm: llmKey ? LLM : null, canUndo: past.length > 0,
    };
  }

  return {
    ask, answer: onAnswer, swap, edit: toolEdit, undo, startAgain, tools: toolsFor, state,
    // The mock as it is now, for the shell to draw, save and export. Read it; change it only here.
    get root() { return root; },
    get version() { return { rev, seq }; },
    // `fn({ rev, seq })` after every change; the function it returns stops it.
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
