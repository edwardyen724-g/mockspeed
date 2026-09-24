#!/usr/bin/env node
// run — the through-the-app test. Every sentence goes to the running trial app's /ask, the same
// request the page's text box sends, so Jev routes and decides everything it would for a person.
//
//   node trial/server.mjs --env <env file>          (in another terminal, or via .claude/launch.json)
//   node trial/eval/run.mjs <out-dir> [--port 8772] [--only rent,crm]
//
// For each request in prompts.json: build the app, then twelve follow-ups that put Jev to work —
// find an element nobody marked, act on a marked one, remove, place a new piece, a whole screen,
// rewrite "the main list", split two changes, move to a named place, a quoted screen name, and a
// question that should change nothing. Where the app asks the person, this script plays the person
// for the two answers a test needs — "start a new app" and "yes, remove it" — and records every
// other question ("which one?", "where should it go?") as asked, then leaves it.
//
// Writes <out-dir>/results.json (every step with its slice of the app's log: Jev's route, job,
// screen and gap decisions with confidences, questions, answers, what changed) and each app's
// outline after the build and after all follow-ups. Why test through the app and never call the
// writer directly: a direct call skips Jev, and then the test says nothing about the product.
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const outArg = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!outArg) { console.error("usage: node trial/eval/run.mjs <out-dir> [--port 8772]"); process.exit(2); }
const OUT = resolve(outArg);
const BASE = `http://localhost:${flag("--port", 8772)}`;
mkdirSync(OUT, { recursive: true });
const prompts = JSON.parse(readFileSync(join(HERE, "prompts.json"), "utf8"));
// --only rent,crm: a smoke test on some of the apps before a full run.
const only = flag("--only", null)?.split(",");
if (only) for (const k of Object.keys(prompts)) if (!only.includes(k)) delete prompts[k];

const post = (p, b) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const state = () => fetch(BASE + "/state").then((r) => r.json());
const spec = () => fetch(BASE + "/spec").then((r) => r.text());

const results = [];
for (const key of Object.keys(prompts)) {
  const steps = [];
  let viewing = null;

  async function say(sentence, { marked = null, kind }) {
    const t0 = Date.now();
    const human = [];
    const asked = [];
    let r = await post("/ask", { utterance: sentence, marked, viewing });
    // Answer the questions a test needs answered, as the person would; record the rest.
    while (r.choices?.length) {
      const start = r.choices.find((c) => c.post.body.kind === "start");
      const yes = r.choices.find((c) => c.post.body.kind === "apply" && /^yes/.test(c.label));
      asked.push({ question: r.note, options: r.choices.map((c) => c.label) });
      const pick = start ?? yes;
      if (!pick) {
        const leave = r.choices.find((c) => c.post.body.kind === "cancel");
        await post("/answer", leave ? leave.post.body : { kind: "cancel" });
        break;
      }
      human.push(pick.label);
      r = await post("/answer", pick.post.body);
    }
    const ms = Date.now() - t0;
    // The app keeps its last 160 log entries; a step's entries are the ones after its own "ask".
    const all = (await state()).log;
    const at = all.map((e) => e.op === "ask" && e.note === sentence).lastIndexOf(true);
    const log = at >= 0 ? all.slice(at) : [];
    // Jev's decisions in the step: routes (and whether a split part waits), elements, places.
    const jev = log.filter((e) => ["route", "target", "place"].includes(e.op) && /^jev/.test(e.source ?? "")).length;
    steps.push({ kind, sentence, marked, reply: r.note, changed: Boolean(r.changed), asked, human, jev, ms, log });
    return r;
  }

  const t0 = Date.now();
  await say(prompts[key], { kind: "build" });
  const buildMs = Date.now() - t0;
  writeFileSync(join(OUT, `${key}.build.outline`), await spec());
  const els = (await state()).elements;
  viewing = els[0]?.screen ?? null;
  const button = els.find((e) => e.kind === "button") ?? els.find((e) => e.kind === "text");

  await say("make the title bigger", { kind: "edit · find it unmarked" });
  await say("make the navigation darker", { kind: "edit · find a container unmarked" });
  await say("make this bigger", { kind: "edit · marked", marked: button?.key ?? null });
  await say("remove the last button", { kind: "edit · destructive" });
  await say("add a search field at the top", { kind: "add · Jev places it" });
  await say("is this layout too busy?", { kind: "question · should change nothing" });
  await say("add a settings screen", { kind: "add · a whole screen" });
  await say("turn the main list into a table", { kind: "rewrite · Jev picks the element" });
  await say("add a filter and make the title bigger", { kind: "several · split, then each through Jev" });
  const now = (await state()).elements;
  const label = now.find((e) => e.kind === "button")?.text.match(/"([^"]+)"/)?.[1];
  const lastScreen = [...new Set(now.map((e) => e.screen).filter(Boolean))].slice(-1)[0];
  const txt = now.find((e) => e.kind === "text");
  // Skipped when the app has no button left by now (an earlier step may have removed the last).
  if (label) await say(`move the ${label} button to the top of the screen`, { kind: "move · to a named place" });
  if (lastScreen) await say(`add a note to the "${lastScreen}" screen`, { kind: "add · a quoted screen name" });
  if (txt) await say("make this bold and move it to the top", { kind: "several · pointing at the marked element", marked: txt.key });

  writeFileSync(join(OUT, `${key}.final.outline`), await spec());
  const jevCalls = steps.reduce((s, x) => s + x.jev, 0);
  const humans = steps.reduce((s, x) => s + x.human.length, 0);
  results.push({ key, prompt: prompts[key], buildMs, jevCalls, humans, viewing, markedForStep4: button ? { key: button.key, line: button.text } : null, steps });
  const sym = (x) => (x.asked.length && !x.human.length ? "?" : x.changed ? "✓" : "·");
  console.log(`${key.padEnd(14)} build ${(buildMs / 1000).toFixed(1)} s · ${jevCalls} Jev · ${humans} human · ${steps.map(sym).join("")}`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
}
console.log(`done · ${results.reduce((s, r) => s + r.jevCalls, 0)} Jev decisions · ${results.reduce((s, r) => s + r.humans, 0)} human decisions → ${OUT}`);
