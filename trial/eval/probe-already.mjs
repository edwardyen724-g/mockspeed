#!/usr/bin/env node
// probe-already — check before adding: does Jev tell when what a sentence asks to add is on the
// mock already?
//
//   node trial/eval/probe-already.mjs --env <env file> [--runs 2] [--wordings app,bare] [--out <file.json>]
//
// A new Jev question is measured on a sentence set before anything relies on it. This one is asked
// before an addition: is the thing already there (`there`), which element is it (`it`), does the
// sentence name a place on a screen for it (`open`, the wording spot() already asks), and does it
// name a page (`page`). The results are in trial/eval/README.md. The set covers the
// thing there and not there; there, with a place named on its own page, on another page, and none;
// "another" / "a second" / a thing only of the same kind; and sentences whose place names an
// element that is there when the thing to add is not ("an email address under our phone number"),
// which is where decide()'s `exists` reads yes. Bakery rows tune the wording; the email and CRM
// apps, built by the writer in the 1b eval, are held out.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, index, describe, shapeOf, sharedView } from "../tree.mjs";
import { already, THERE } from "../jev.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const envFile = flag("--env", process.env.TYPESAFE_ENV_FILE);
const RUNS = Number(flag("--runs", 2));
const OUT = flag("--out", null);
// The wordings tried: `app` is the one jev.mjs asks; `bare` is the plain question without the lines
// about "another" and the place, to see whether they are needed.
const TRIED = {
  app: THERE,
  bare: "Is the thing `said` asks to add already on the mockup described in `elements`?",
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

const BAR = (current) => `    row pad=3 fill=light justify=between align=center share=top
      text "Crumb" size=l bold
      row gap=4
        text "Home"${current === "Home" ? " bold" : " shade=mid"}
        text "Menu"${current === "Menu" ? " bold" : " shade=mid"}
        text "Visit us"${current === "Visit us" ? " bold" : " shade=mid"}
      button "Order now" primary`;
const BAKERY = parse(`app "Crumb Bakery" web
  screen "Home"
${BAR("Home")}
    col #homemain pad=5 gap=4
      shape #heroimg "Fresh loaves on the counter" h=320
      text #hero "Bread baked every morning at 5" size=xxl bold
      text #tag "Sourdough, pastries and coffee on Elm Street since 2009"
      row gap=2
        button #seemenu "See the menu" primary
        button #findus "Find us"
  screen "Menu"
${BAR("Menu")}
    col #main pad=5 gap=4
      text #menuh "Today's bread" size=xl bold
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
  screen "Visit us"
${BAR("Visit us")}
    row #visit pad=5 gap=5
      col #info gap=3 w=420
        text #visith "Visit us" size=xl bold
        col #addrbox gap=1
          text #addrl "Address" size=s shade=mid
          text #addr "412 Elm Street, Portland, OR"
        col #phonebox gap=1
          text #phonel "Phone" size=s shade=mid
          text #phone "(503) 555-0142"
        col #hoursbox gap=1
          text #hoursl "Hours" size=s shade=mid
          table #hours
            tr "Day | Open"
            tr "Mon – Fri | 7am – 3pm" data
            tr "Sat – Sun | 8am – 2pm" data
      shape #map "Map" grow h=360`).root;

const RUN = new URL("./runs/2026-09-26-act-then-offer/", import.meta.url);
const APPS = {
  bakery: BAKERY,
  email: parse(readFileSync(new URL("email.build.outline", RUN), "utf8")).root,
  crm: parse(readFileSync(new URL("crm.build.outline", RUN), "utf8")).root,
};
// Ids the parser numbers: "@Menu" is the Menu screen, "=Order now" the first thing that says so.
const screenId = (app, name) => APPS[app].children.find((s) => s.text === name).id;
const textId = (app, words) => index(APPS[app]).find((n) => n.text === words).id;

// What Jev is shown: every element once, as the server shows it (server.mjs `nodes({ once })`).
const nodesOf = (root) => {
  const view = sharedView(root);
  return index(root).filter((n) => n.node !== root && !view.hidden.has(n.id)).map((n) => {
    const shape = shapeOf(n.node);
    return { id: n.id, screen: view.screens.get(n.id)?.join(", ") ?? n.screen, line: shape ? `${describe(n.node)} · ${shape}` : describe(n.node) };
  });
};

// [app, sentence, there, ids that are the thing (any one is right), open, page]. `there` null is a
// row where the answer changes nothing: the thing is on another page from the one the sentence
// asks for, so it is added there either way. `open` (names no place on a screen) and `page` (names
// a page) are scored only where the thing may be there, the one case they decide:
//   open, no page         → the one there is pointed out, and another offered
//   a page or a place     → on the page asked for: moved to the place (or pointed out, if open);
//                           not on it: added there as asked
// `held` rows are the apps the wording was not tuned on.
const SET = [
  // there, names nothing
  ["bakery", "add our phone number", true, ["phone", "phonebox"], true, false],
  ["bakery", "add our address", true, ["addr", "addrbox"], true, false],
  ["bakery", "add the opening hours", true, ["hours", "hoursbox"], true, false],
  ["bakery", "add a map", true, ["map"], true, false],
  ["bakery", "add prices to the breads", true, ["pr1", "pr2", "pr3"], null, false],
  ["bakery", "add an order button", true, ["=Order now"], true, false],
  ["bakery", "add a menu page", true, ["@Menu"], true, null],
  // there, a page named: its own, or another
  ["bakery", "add our phone number to the visit us page", true, ["phone", "phonebox"], true, true],
  ["bakery", "add the opening hours to the home page", null, ["hours", "hoursbox"], true, true],
  ["bakery", "add our phone number to the home page", null, ["phone", "phonebox"], true, true],
  // there, a place named on its page, or on another
  ["bakery", "add our phone number under the address", true, ["phone", "phonebox"], false, false],
  ["bakery", "add the hours above the phone number", true, ["hours", "hoursbox"], false, false],
  ["bakery", "add our address at the top of the visit us page", true, ["addr", "addrbox"], false, true],
  ["bakery", "add our phone number under the tagline", null, ["phone", "phonebox"], false, false],
  // not there
  ["bakery", "add a search field at the top", false],
  ["bakery", "add a newsletter signup", false],
  ["bakery", "add customer reviews", false],
  ["bakery", "add our email address", false],
  ["bakery", "add a gluten-free badge to the sourdough card", false],
  ["bakery", "add a contact form", false],
  ["bakery", "add a footer", false],
  // not there: another, a second, only the same kind
  ["bakery", "add another bread card", false],
  ["bakery", "add a second phone number", false],
  ["bakery", "add a button next to the tagline", false],
  ["bakery", "add a new page for catering", false],
  // not there, and the place it names is
  ["bakery", "add an email address under our phone number", false],
  ["bakery", "add a note under the address", false],
  ["bakery", "add a photo next to the map", false],
  // held out
  ["email", "add a search box", true, ["n20"], true, false],
  ["email", "add a compose button", true, ["n21"], true, false],
  ["email", "add a trash folder", true, ["n10"], true, false],
  ["email", "add a CC field", true, ["n114"], true, false],
  ["email", "add a search box next to the compose button", true, ["n20"], false, false],
  ["email", "add a search box to the message page", null, ["n20"], true, true],
  ["email", "add a filter dropdown next to the search box", false],
  ["email", "add a spam folder", false],
  ["email", "add a BCC field under the CC field", false],
  ["email", "add another folder", false],
  ["crm", "add the buyer's phone number", true, ["n76", "n75"], true, false],
  ["crm", "add a new buyer button", true, ["n13"], true, false],
  ["crm", "add the buyer's email under the phone number", true, ["n78", "n77"], false, false],
  ["crm", "add the buyer's phone number to the pipeline page", null, ["n76", "n75"], true, true],
  ["crm", "add a notes field under the activity", false],
  ["crm", "add a search bar above the columns", false],
  ["crm", "add another column for offers", false],
  ["crm", "add a second buyer's phone number", false],
];
const HELD = SET.findIndex((r) => r[0] !== "bakery");
const idsOf = (app, ids) => ids.map((k) => (k.startsWith("@") ? screenId(app, k.slice(1)) : k.startsWith("=") ? textId(app, k.slice(1)) : k));

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
    SET.forEach(([app, said, there, ids = [], open = null, page = null], i) => {
      jobs.push(async () => {
        const root = APPS[app];
        const want = idsOf(app, ids);
        for (const id of want) if (!index(root).some((n) => n.id === id)) throw new Error(`${app} has no ${id}`);
        const r = await already({ utterance: said, nodes: nodesOf(root), apiKey, instructions: TRIED[wording] });
        const maybe = there !== false;
        const rightThere = there == null || (r.there >= 0.5) === there;
        const rightIt = there !== true || want.includes(r.id);
        const rightOpen = !maybe || open == null || (r.open >= 0.5) === open;
        const rightPage = !maybe || page == null || (r.page >= 0.5) === page;
        return {
          wording, run, i, app, said, held: i >= HELD, there, want, open, page,
          p: Number(r.there.toFixed(3)), id: r.id, idConf: Number(r.confidence.toFixed(3)), openP: Number(r.open.toFixed(3)), pageP: Number(r.page.toFixed(3)),
          rightThere, rightIt, rightOpen, rightPage, right: rightThere && rightIt && rightOpen && rightPage, ms: r.ms,
        };
      });
    });
  }
}
const rows = await pool(jobs);

for (const wording of WORDINGS) {
  const mine = rows.filter((r) => r.wording === wording);
  const tally = (rs, k = "right") => `${rs.filter((r) => r[k]).length}/${rs.length}`;
  const yesLo = Math.min(...mine.filter((r) => r.there === true).map((r) => r.p));
  const noHi = Math.max(...mine.filter((r) => r.there === false).map((r) => r.p));
  const maybe = mine.filter((r) => r.there !== false);
  console.log(`\n${wording}: ${tally(mine)} right (tuned ${tally(mine.filter((r) => !r.held))}, held out ${tally(mine.filter((r) => r.held))})`);
  console.log(`  there ${tally(mine.filter((r) => r.there != null), "rightThere")} · "yes" ≥ ${yesLo.toFixed(2)} · "no" ≤ ${noHi.toFixed(2)} · which ${tally(mine.filter((r) => r.there === true), "rightIt")} · open ${tally(maybe.filter((r) => r.open != null), "rightOpen")} · page ${tally(maybe.filter((r) => r.page != null), "rightPage")}`);
  const yn = (v) => (v == null ? "·" : v ? "y" : "n");
  SET.forEach(([app, said, there, , open, page], i) => {
    const rs = mine.filter((r) => r.i === i);
    const mark = rs.every((r) => r.right) ? " " : "✗";
    const cells = rs.map((r) => `${r.p.toFixed(2)}${there !== false ? ` ${r.rightIt ? "" : `→${r.id} `}open ${r.openP.toFixed(2)} page ${r.pageP.toFixed(2)}` : ""}`).join(" | ");
    console.log(`  ${mark} there ${yn(there)} open ${yn(there === false ? null : open)} page ${yn(there === false ? null : page)}  ${cells}  ${app} · ${said}${i === HELD ? "   ← held out from here" : ""}`);
  });
}
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\nlatency: median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms, ${rows.length} calls`);
if (OUT) writeFileSync(resolve(OUT), JSON.stringify({ at: new Date().toISOString(), runs: RUNS, rows }, null, 2));
