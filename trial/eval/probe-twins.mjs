#!/usr/bin/env node
// probe-twins — does Jev tell "this one" from "every one like it"? (docs/plan-web-2026-09-26.md §4)
//
//   node trial/eval/probe-twins.mjs --env <env file> [--runs 2] [--out <file.json>]
//
// A new Jev question is measured on a sentence set before anything relies on it. This one is asked
// only when the element an edit acts on has twins (tree.mjs `twinsOf`): each card's price when it
// is one card's price, each nav item when it is one item. The set covers marked and unmarked,
// singular and plural, pointing words (this / these / them) and names ("the croissant price"), on
// a bakery's menu page. Unmarked, `target` is the element `which` would have found; the question
// is only whether the sentence means it alone or all of its twins. The wording jev.mjs asks (EVERY)
// is run beside the one it replaced; the results are in trial/eval/README.md.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, find, describe, twinsOf } from "../tree.mjs";
import { every, EVERY } from "../jev.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const envFile = flag("--env", process.env.TYPESAFE_ENV_FILE);
const RUNS = Number(flag("--runs", 2));
const OUT = flag("--out", null);
// The wordings tried. `app` is the one jev.mjs asks; `bare` is it without the line about plurals
// and the mark, which is what the first run showed was missing.
const TRIED = {
  app: EVERY,
  bare: "Does `said` act on only `target`, or on every one of `twins` — the same thing repeated, `target` among them? If `said` points with this, that or it, it means `target` alone; these, those or them mean every one.",
};
const WORDINGS = flag("--wordings", "app,bare").split(",");
const readKey = (name) => {
  if (process.env[name]) return process.env[name];
  if (!envFile) return null;
  const line = readFileSync(resolve(envFile), "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : null;
};
const apiKey = readKey("TYPESAFE_API_KEY");
if (!apiKey) { console.error("no TYPESAFE_API_KEY — pass --env"); process.exit(2); }

const BAKERY = parse(`app "Crumb Bakery" web
  screen "Menu"
    row #bar pad=3 fill=light justify=between align=center
      text #logo "Crumb" size=l bold
      row #links gap=4
        text #l1 "Menu" bold
        text #l2 "Order" shade=mid
        text #l3 "Visit us" shade=mid
      button #cta "Order now" primary
    col #main pad=5 gap=4
      text #hero "Today's bread" size=xl bold
      text #tag "Baked every morning at 5"
      grid #cards cols=3 gap=3
        col #c1 border pad=3 gap=2
          shape #p1 h=120
          text #n1 "Sourdough" size=l bold
          text #pr1 "$6.00"
          button #b1 "Add"
        col #c2 border pad=3 gap=2
          shape #p2 h=120
          text #n2 "Baguette" size=l bold
          text #pr2 "$3.50"
          button #b2 "Add"
        col #c3 border pad=3 gap=2
          shape #p3 h=120
          text #n3 "Croissant" size=l bold
          text #pr3 "$2.75"
          button #b3 "Add"
        col #c4 border pad=3 gap=2
          shape #p4 h=120
          text #n4 "Cinnamon roll" size=l bold
          text #pr4 "$3.25"
          button #b4 "Add"
        col #c5 border pad=3 gap=2
          shape #p5 h=120
          text #n5 "Rye loaf" size=l bold
          text #pr5 "$5.50"
          button #b5 "Add"
      table #hours
        tr #th "Day | Open"
        tr #t1 "Mon | 7am – 3pm" data
        tr #t2 "Tue | 7am – 3pm" data
        tr #t3 "Wed | 7am – 3pm" data`).root;

// The held-out apps: built by the writer in the 1b eval, with nouns the wordings never mention.
const RUN = new URL("./runs/2026-09-26-act-then-offer/", import.meta.url);
const APPS = {
  bakery: BAKERY,
  email: parse(readFileSync(new URL("email.build.outline", RUN), "utf8")).root,
  agents: parse(readFileSync(new URL("orchestration.build.outline", RUN), "utf8")).root,
};

// What Jev is shown of an element: its line, and the line of what holds it, so one card's price
// reads as that card's.
const lineIn = (root, id) => {
  const h = find(root, id);
  return h.parent ? `${describe(h.node)} · in ${describe(h.parent)}` : describe(h.node);
};

// [app, sentence, marked, target, expected]: marked is what the person clicked; target is the
// element the edit acts on (the marked one, or the one `which` finds). `held` rows are the set
// the wording was not tuned on.
const SET = [
  ["bakery", "make the prices bigger", "pr2", "pr2", "every"],
  ["bakery", "make this bigger", "pr2", "pr2", "one"],
  ["bakery", "make these bigger", "pr2", "pr2", "every"],
  ["bakery", "make this price bigger", "pr2", "pr2", "one"],
  ["bakery", "make all the prices bold", "pr2", "pr2", "every"],
  ["bakery", "make each price bold", "pr2", "pr2", "every"],
  ["bakery", "the prices should be bigger", "pr2", "pr2", "every"],
  ["bakery", "make the price bigger", "pr2", "pr2", "one"],
  ["bakery", "remove this", "pr2", "pr2", "one"],
  ["bakery", "remove the prices", "pr2", "pr2", "every"],
  ["bakery", "make it lighter", "pr2", "pr2", "one"],
  ["bakery", "make them lighter", "pr2", "pr2", "every"],
  ["bakery", "rename this to Buy", "b2", "b2", "one"],
  ["bakery", "make the prices bigger", null, "pr1", "every"],
  ["bakery", "make the croissant price bigger", null, "pr3", "one"],
  ["bakery", "make the first price bold", null, "pr1", "one"],
  ["bakery", "make every price bold", null, "pr1", "every"],
  ["bakery", "make the nav links lighter", null, "l2", "every"],
  ["bakery", "make the Order link bold", null, "l2", "one"],
  ["bakery", "make the add buttons smaller", null, "b1", "every"],
  ["bakery", "make the sourdough card darker", null, "c1", "one"],
  ["bakery", "make the cards darker", null, "c1", "every"],
  ["bakery", "remove the cards", null, "c1", "every"],
  ["bakery", "make the Tuesday row bold", null, "t2", "one"],
  ["bakery", "make the table rows bold", null, "t1", "every"],
  ["bakery", "call the add buttons Buy", null, "b1", "every"],
  // held out
  ["email", "make the times lighter", "n28", "n28", "every"],
  ["email", "make this time smaller", "n28", "n28", "one"],
  ["email", "make the names regular", "n26", "n26", "every"],
  ["email", "make Sarah's name regular", "n26", "n26", "one"],
  ["email", "remove the checkboxes", "n24", "n24", "every"],
  ["email", "remove it", "n24", "n24", "one"],
  ["email", "make that lighter", "n34", "n34", "one"],
  ["email", "make those lighter", "n34", "n34", "every"],
  ["email", "make the timestamps smaller", null, "n28", "every"],
  ["email", "make Alex's name bigger", null, "n32", "one"],
  ["email", "make the email rows taller", null, "n23", "every"],
  ["email", "remove the first email", null, "n23", "one"],
  ["email", "the times are too dark", null, "n28", "every"],
  ["agents", "make the agent names bigger", null, "n14", "every"],
  ["agents", "make Data Validator bigger", null, "n21", "one"],
  ["agents", "make the status dots bigger", "n17", "n17", "every"],
  ["agents", "make this dot darker", "n17", "n17", "one"],
  ["agents", "make the agent cards darker", null, "card", "every"],
  ["agents", "remove the Email Classifier card", null, "card", "one"],
];
const HELD = SET.findIndex((r) => r[0] !== "bakery");
// "card" is the card around the first agent's name, whatever its id.
const idOf = (app, id) => (id === "card" ? find(APPS[app], "n14").parent.id : id);

async function pool(jobs, n = 6) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

const jobs = [];
for (const wording of WORDINGS) {
  for (let run = 0; run < RUNS; run++) {
    SET.forEach(([app, said, marked, target0, expect], i) => {
      jobs.push(async () => {
        const root = APPS[app], target = idOf(app, target0);
        const twins = twinsOf(root, target);
        if (twins.length < 2) throw new Error(`${app} ${target} has no twins`);
        const r = await every({ utterance: said, target: lineIn(root, target), twins: twins.map((t) => lineIn(root, t)), marked: marked ? lineIn(root, marked) : null, apiKey, instructions: TRIED[wording] });
        const got = r.every >= 0.5 ? "every" : "one";
        return { wording, run, i, app, said, marked, target, twins: twins.length, held: i >= HELD, expect, every: Number(r.every.toFixed(3)), got, right: got === expect, ms: r.ms };
      });
    });
  }
}
const rows = await pool(jobs);

for (const wording of WORDINGS) {
  const mine = rows.filter((r) => r.wording === wording);
  const tally = (rs) => `${rs.filter((r) => r.right).length}/${rs.length}`;
  // The margin: how far the least sure right answer is from 0.5 — what a threshold has to live in.
  const everyLo = Math.min(...mine.filter((r) => r.expect === "every").map((r) => r.every));
  const oneHi = Math.max(...mine.filter((r) => r.expect === "one").map((r) => r.every));
  console.log(`\n${wording}: ${tally(mine)} right (tuned ${tally(mine.filter((r) => !r.held))}, held out ${tally(mine.filter((r) => r.held))}) · "every" ≥ ${everyLo.toFixed(2)} · "one" ≤ ${oneHi.toFixed(2)}`);
  SET.forEach(([app, said, marked, , expect], i) => {
    const rs = mine.filter((r) => r.i === i);
    const mark = rs.every((r) => r.right) ? " " : "✗";
    console.log(`  ${mark} ${expect.padEnd(5)} ${rs.map((r) => r.every.toFixed(2)).join(" ")}  ${app} ${marked ? `[${marked}] ` : ""}${said}${i === HELD ? "   ← held out from here" : ""}`);
  });
}
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nlatency: median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms, ${rows.length} calls`);
if (OUT) writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), runs: RUNS, rows }, null, 2));
