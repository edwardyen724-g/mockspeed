#!/usr/bin/env node
// mocklint — checks a mockspeed render against the skill's rules.
//
// Jev judges every text node's role on the screen (data, label, button, nav, heading,
// explanation, placeholder) and whether it shows an edge case; code does what Jev cannot:
// counts non-data words against the budget, checks "at least one edge case", and decides
// pass or fail. Nothing is fixed; offenders are named by node.
//
//   mocklint <mock.html> [--screens <selector>] [--split <selector>] [--budget 20]
//                        [--nodes] [--json] [--model jev-latest]
//
// Screens: elements matching --screens (default: [data-screen]) are screens, named by their
// data-screen attribute. With --split, a new screen starts at every element matching the
// selector. With neither, the whole page is one screen. Add data-lint="ignore" to an
// element to leave it and its children out; add data-lint="data" to declare that an element
// and its children are data (a value, a post, something the system produced), which the
// renderer knows and a reader often cannot tell — marked nodes are counted as data, not judged.
//
// Needs TYPESAFE_API_KEY in the environment or in ./.env.local. Never prints it.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "node-html-parser";
import { TypeSafeClient } from "@typesafe-ai/sdk";

// ---- rules -------------------------------------------------------------------------------

const BUDGET_DEFAULT = 20; // non-data words per screen (labels, buttons, nav count; data does not)
const DATA_NO = 0.4;       // P(data) below this: the node's words count against the budget
const DATA_YES = 0.6;      // P(data) above this: the node is data; between: ambiguous, shown to the human
const FLAG = 0.5;          // P(placeholder | explanation | heading) above this: flagged (roles compete, so 0.5 is a majority)
const EDGE = 0.7;          // P(edge case) above this counts as an edge case
const MAX_QUESTIONS = 150; // per request; 200 verified to work, keep headroom

// The roles are defined by who wrote the text, not by how it reads. A post a user wrote is
// data even when it sounds like an explanation; "views" next to a number is a label.
const ROLES = {
  data: "Content the product would load from its data: something a user wrote or typed (a post, a message, a bio, a name, a handle, a quote, an address), a value the system measured or stored (a number, a count, a date, a time, a duration, a price, a percentage), or something the system produced for this user (a summary it wrote, an inferred description, a search phrase, an option in a list it built). Nobody on the design team wrote it.",
  label: "A word or short phrase the designer wrote to name a field, column, unit, or state that sits next to a value ('Post', 'views', 'in band', 'draft', 'valid'), possibly with values embedded in the same line.",
  button: "A caption on something the reader taps or clicks to act ('Place it', 'Export CSV', 'Deploy agent').",
  nav: "An item in a tab bar, menu, or set of links that moves the reader to another screen.",
  heading: "A title placed above a group of things that names a section of the screen and shows no value of its own.",
  explanation: "A sentence or phrase the designer wrote to tell the reader what the product does, how it works, what to do next, a hint under a field, a subtitle, or encouragement.",
  placeholder: "Text standing in for content that does not exist yet: 'your items appear here', lorem ipsum, 'Feature One', 'Item 1', 'John Doe', or a description of what would be shown instead of the thing itself.",
};

const EDGE_YES = "The node's own text is an edge value: empty, missing, a dash standing for no value, a zero, a failed, overdue, dropped, or deleted state, an answer that was not available, a value at or over a stated limit, or an entry far longer than its neighbours.";
const EDGE_NO = "The node's own text is an ordinary value, or is not data at all. Edge values elsewhere in the same row do not count.";

// ---- args --------------------------------------------------------------------------------

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(name);
const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !["--nodes", "--json", "--help"].includes(args[i - 1])));

if (!file || flag("--help")) {
  console.error("usage: mocklint <mock.html> [--screens <selector>] [--split <selector>] [--budget N] [--nodes] [--json] [--model name]");
  process.exit(2);
}

const budget = Number(opt("--budget", BUDGET_DEFAULT));
const screensSel = opt("--screens", null);
const splitSel = opt("--split", null);
const model = opt("--model", undefined);

// ---- env ---------------------------------------------------------------------------------

if (!process.env.TYPESAFE_API_KEY && existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

// ---- extract -----------------------------------------------------------------------------

const html = readFileSync(resolve(file), "utf8");
const root = parse(html, { blockTextElements: { script: false, style: false, noscript: false, pre: true } });
for (const sel of ["script", "style", "title", "noscript"]) root.querySelectorAll(sel).forEach((n) => n.remove());
const body = root.querySelector("body") ?? root;

const screenSet = new Set(root.querySelectorAll(screensSel ?? "[data-screen]"));
const splitSet = splitSel ? new Set(root.querySelectorAll(splitSel)) : new Set();

const collapse = (s) => s.replace(/\s+/g, " ").trim();
const nodes = [];
const screenNames = [];
let splitCount = 0;
let current = null;
if (!screenSet.size) { current = splitSet.size ? "screen 1" : "page"; screenNames.push(current); }

const nameFor = (el) => el.getAttribute("data-screen") || el.getAttribute("id") || `${el.rawTagName}#${screenNames.length + 1}`;

// The line a node sits in: the nearest ancestor whose text says more than the node's own, if it is line-sized.
function rowFor(el, own) {
  let p = el.parentNode;
  for (let depth = 0; p && depth < 3; depth += 1, p = p.parentNode) {
    if (p.nodeType !== 1) break;
    const t = collapse(p.text ?? "");
    if (t && t !== own) return t.length <= 200 ? t : null; // a screen-sized container is not a row
  }
  return null;
}

function walk(el, screen, trusted = false) {
  if (el.nodeType !== 1) return;
  const mark = el.getAttribute?.("data-lint");
  if (mark === "ignore") return;
  if (mark === "data") trusted = true;
  if (screenSet.has(el)) {
    screen = nameFor(el);
    if (!screenNames.includes(screen)) screenNames.push(screen);
  }
  if (splitSet.has(el)) {
    splitCount += 1;
    current = `screen ${splitCount + 1}`;
    if (!screenNames.includes(current)) screenNames.push(current);
  }
  const own = collapse(el.childNodes.filter((c) => c.nodeType === 3).map((c) => c.text).join(" "));
  if (own && /\p{L}|\p{N}/u.test(own)) {
    const row = rowFor(el, own);
    nodes.push({ id: nodes.length, screen: screen ?? current ?? "outside", tag: el.rawTagName.toLowerCase(), text: own, trusted, ...(row ? { row } : {}) });
  }
  for (const c of el.childNodes) walk(c, screen, trusted);
}
walk(body, null);

const words = (t) => (t.match(/\p{L}[\p{L}'’-]*/gu) ?? []).length;

if (flag("--nodes")) {
  for (const n of nodes) console.log(`[${n.id}] ${n.screen.padEnd(10)} <${n.tag}> ${JSON.stringify(n.text)}  (${words(n.text)}w)${n.trusted ? "  data" : ""}${n.row ? "  row: " + JSON.stringify(n.row.slice(0, 60)) : ""}`);
  console.error(`${nodes.length} nodes · screens: ${screenNames.join(", ")}`);
  process.exit(0);
}

if (!process.env.TYPESAFE_API_KEY) {
  console.error("mocklint: TYPESAFE_API_KEY is not set (environment or ./.env.local). Use --nodes to inspect without Jev.");
  process.exit(2);
}

// ---- judge -------------------------------------------------------------------------------

const client = new TypeSafeClient({ apiKey: process.env.TYPESAFE_API_KEY, ...(model ? { defaultModel: model } : {}) });

const roleQ = (i) => ({
  type: "choice",
  instructions: `What role does \`nodes[${i}]\` play on this screen? Its \`row\` is the line it sits in, for context only. Judge the role, not the writing style: a full sentence a person could have posted or written about themselves is data even if it reads like an explanation; one or two words naming what a value is ('views', 'in band') are a label.`,
  criteria: ROLES,
});
const edgeQ = (i) => ({
  type: "noul",
  instructions: `Is the text of \`nodes[${i}]\` itself an edge value? Judge only that node's text; its \`row\` says where it sits and is not being judged.`,
  criteria: { true: EDGE_YES, false: EDGE_NO },
});

async function judgeScreen(screen) {
  const mine = nodes.filter((n) => n.screen === screen);
  if (!mine.length) return { screen, usage: null, results: [] };
  const state = { screen, nodes: mine.map((n, i) => ({ id: i, tag: n.tag, text: n.text, ...(n.row ? { row: n.row } : {}) })) };
  const all = [];
  mine.forEach((n, i) => { if (!n.trusted) all.push([`r${i}`, roleQ(i)]); all.push([`x${i}`, edgeQ(i)]); });
  const chunks = [];
  for (let i = 0; i < all.length; i += MAX_QUESTIONS) chunks.push(Object.fromEntries(all.slice(i, i + MAX_QUESTIONS)));
  const answers = {};
  let tokens = 0;
  let ms = 0;
  await Promise.all(chunks.map(async (questions) => {
    const t0 = performance.now();
    const r = await client.systemOne({ state, questions });
    ms = Math.max(ms, performance.now() - t0);
    tokens += r.usage?.input_tokens ?? r.usage?.total_tokens ?? 0;
    Object.assign(answers, r.answers);
  }));
  const results = mine.map((n, i) => {
    if (n.trusted) return { ...n, role: "data", confidence: 1, p: { data: 1 }, marked: true, edge: answers[`x${i}`]?.noul ?? null, words: words(n.text) };
    const a = answers[`r${i}`];
    const p = a?.probabilities ?? {};
    return { ...n, role: a?.choice ?? null, confidence: a?.confidence ?? null, p, edge: answers[`x${i}`]?.noul ?? null, words: words(n.text) };
  });
  return { screen, usage: { tokens, ms: Math.round(ms), questions: all.length }, results };
}

const judged = await Promise.all(screenNames.map(judgeScreen));

// ---- decide ------------------------------------------------------------------------------

const report = judged.map(({ screen, usage, results }) => {
  const pd = (r) => r.p.data ?? 0;
  const nonData = results.filter((r) => pd(r) < DATA_NO);
  const ambiguous = results.filter((r) => pd(r) >= DATA_NO && pd(r) <= DATA_YES);
  const placeholders = results.filter((r) => (r.p.placeholder ?? 0) > FLAG);
  const explanations = results.filter((r) => (r.p.explanation ?? 0) > FLAG);
  const headings = results.filter((r) => (r.p.heading ?? 0) > FLAG);
  const edges = results.filter((r) => (r.edge ?? 0) > EDGE);
  const used = nonData.reduce((s, r) => s + r.words, 0);
  const usedIfAmbiguous = used + ambiguous.reduce((s, r) => s + r.words, 0);
  const fails = [];
  if (used > budget) fails.push(`non-data words ${used} / ${budget}`);
  if (placeholders.length) fails.push(`${placeholders.length} placeholder${placeholders.length > 1 ? "s" : ""}`);
  if (explanations.length) fails.push(`${explanations.length} explanatory sentence${explanations.length > 1 ? "s" : ""}`);
  const warns = [];
  if (headings.length) warns.push(`${headings.length} section heading${headings.length > 1 ? "s" : ""}`);
  return { screen, usage, used, usedIfAmbiguous, budget, fails, warns, nonData, ambiguous, placeholders, explanations, headings, edges, results };
});

const anyEdge = report.some((s) => s.edges.length);
const failed = report.some((s) => s.fails.length);

// ---- print -------------------------------------------------------------------------------

if (flag("--json")) {
  const slim = report.map(({ results, ...s }) => ({ ...s, nodes: results.map((r) => ({ id: r.id, tag: r.tag, text: r.text, words: r.words, role: r.role, marked: !!r.marked, confidence: r.confidence, p: r.p, edge: r.edge })) }));
  console.log(JSON.stringify({ file, failed, edgeCase: anyEdge, screens: slim }, null, 2));
  process.exit(failed ? 1 : 0);
}

const q = (t, w = 44) => { const s = JSON.stringify(t); return s.length > w ? s.slice(0, w - 1) + "…" : s; };
const row = (r, extra = "") => `    [${String(r.id).padStart(2)}] ${q(r.text).padEnd(46)} ${extra}`;

for (const s of report) {
  const verdict = s.fails.length ? "FAIL" : "PASS";
  const amb = s.usedIfAmbiguous > s.used ? ` (${s.usedIfAmbiguous} if the ambiguous lines count)` : "";
  console.log(`${s.screen} — ${verdict} · ${s.used} / ${s.budget} non-data words${amb}${s.warns.length ? " · warn: " + s.warns.join(", ") : ""}`);
  if (s.fails.length) console.log(`  ${s.fails.join(" · ")}`);
  if (s.nonData.length) {
    console.log("  non-data:");
    for (const r of s.nonData) console.log(row(r, `${String(r.words).padStart(2)}w  ${(r.role ?? "?").padEnd(11)} P(data) ${(r.p.data ?? 0).toFixed(2)}`));
  }
  if (s.placeholders.length) { console.log("  placeholders:"); for (const r of s.placeholders) console.log(row(r, `P ${r.p.placeholder.toFixed(2)}`)); }
  if (s.explanations.length) { console.log("  explanations:"); for (const r of s.explanations) console.log(row(r, `P ${r.p.explanation.toFixed(2)}`)); }
  if (s.headings.length) { console.log("  headings (warn):"); for (const r of s.headings) console.log(row(r, `P ${r.p.heading.toFixed(2)}`)); }
  if (s.ambiguous.length) { console.log("  ambiguous — decide yourself:"); for (const r of s.ambiguous) console.log(row(r, `${String(r.words).padStart(2)}w  ${(r.role ?? "?").padEnd(11)} P(data) ${(r.p.data ?? 0).toFixed(2)}`)); }
  if (s.edges.length) { console.log("  edge cases:"); for (const r of s.edges) console.log(row(r, `P ${r.edge.toFixed(2)}`)); }
  if (s.usage) console.log(`  jev: ${s.usage.questions} questions · ${s.usage.tokens} tokens · ${s.usage.ms} ms`);
  console.log();
}
if (!anyEdge) console.log("warn · no edge case found in the fake data (Rule 1 wants at least one — empty, overdue, zero, very long); Jev judges each value alone, so check this yourself\n");
console.log(failed ? "mocklint: FAIL" : "mocklint: PASS");
process.exit(failed ? 1 : 0);
