// words.test — what a person reads is in their words, never the engine's (docs/plan-web-2026-09-26.md
// §2, phase 1a).
//
//   node --test "trial/test/*.test.mjs"
//
// Every question, choice, reply and page string trial/words.mjs can make is rendered against the
// ten apps of the last eval run (as built, and after twelve follow-ups each), and none may carry a
// word from BANNED outside a “quoted” span — the quotes hold the mock's own words, which may say
// anything. It checks our output only: nothing here reads what a person typed, which stays Jev's.
// A second pair of checks holds the server and the page to the rule that nothing else writes to
// the person.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, index, find, partsOf, spotsIn, edgesOf, gaps, screenGaps, neighboursIn, sectionsOf, padded } from "../tree.mjs";
import * as W from "../words.mjs";
import { KINDS } from "../jev.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "../eval/runs/2026-09-23-jev-fixes");
const APPS = readdirSync(RUN).filter((f) => f.endsWith(".outline")).sort()
  .map((f) => ({ file: f, root: parse(readFileSync(join(RUN, f), "utf8")).root }));

// ---- the check ----------------------------------------------------------------------------------

const WORD = /[A-Za-z_]+/g;
function offences(text, web) {
  const bare = String(text).replace(/“[^”]*”/g, "“”");
  const bad = new Set([...W.BANNED, ...(web ? W.BANNED_WEB : [])]);
  const out = [...new Set((bare.match(WORD) ?? []).map((w) => w.toLowerCase()).filter((w) => bad.has(w)))];
  // Ids, props, arrows, scores and timings are engine marks whatever the words around them.
  if (/#\w/.test(bare)) out.push("#id");
  if (/\w=/.test(bare)) out.push("key=value");
  if (/->/.test(bare)) out.push("->");
  // Size codes: "bold l", "xl". A lone l or m is never a word (it's, I'm keep their apostrophe).
  if (/(^|[^A-Za-z'’])([lm]|xs|xl|xxl)(?=[^A-Za-z'’]|$)/i.test(bare)) out.push("size code");
  if (/\b0\.\d\d\b|\d+ ?ms\b/.test(bare)) out.push("score or timing");
  if (/\b(undefined|null|NaN)\b|\[object/.test(bare)) out.push("a missing value");
  if (!String(text).trim()) out.push("empty");
  return out;
}

// Every string words.mjs can make for one app.
function strings(root) {
  const out = [];
  const say = (where, s) => out.push({ where, s });
  const all = index(root).filter((n) => n.node !== root);
  const screens = (root.children ?? []).filter((c) => c.type === "screen");
  const ids = all.map((n) => n.id);
  const title = root.text ?? "";

  // Names, as the page shows a selection, and every question and reply that names one thing.
  for (const id of ids) {
    const nm = W.name(root, id);
    say(`name ${id}`, nm);
    say(`selected ${id}`, W.selected(root, id));
    say(`remove ${id}`, W.ask.remove(root, id));
    say(`jobChange ${id}`, W.ask.jobChange(root, id));
    say(`pointed ${id}`, W.ask.pointedChoice(root, id));
    say(`named ${id}`, W.ask.namedChoice(root, id));
    say(`which ${id}`, W.ask.whichChoice(root, id, 0, [all.find((n) => n.id === id).screen].filter(Boolean)));
    say(`which shared ${id}`, W.ask.whichChoice(root, id, 2, screens.map((s) => s.text)));
    for (const op of W.OPS) {
      for (const copies of [0, 2]) say(`edited ${op} ${id}`, W.reply.edited(root, op, nm, { copies, across: copies > 0, to: "New words" }));
      say(`limit ${op} ${id}`, W.reply.limit(op, nm));
    }
    say(`changed ${id}`, W.reply.changed(root, nm, 1));
    say(`already ${id}`, W.reply.alreadyThere(nm));
  }
  // Several offered at once, twins told apart: every page's things together.
  for (const s of screens) W.distinct(root, all.filter((n) => n.screen === s.text).map((n) => n.id)).forEach((nm, i) => say(`distinct ${s.text} ${i}`, nm));

  // Places: every part of every page, every spot in it all the way down, the edges between parts,
  // the flat gaps a page with no padded part offers, the open-sentence spots, and new pages.
  const places = [];
  for (const s of screens) {
    const down = (opts, skip) => {
      for (const o of opts) {
        places.push({ g: o, skip });
        if (o.into != null && places.length < 4000) down(spotsIn(root, o.into, skip), skip);
      }
    };
    down(partsOf(root, s.id), new Set());
    for (const sec of sectionsOf(root, s.id)) for (const e of edgesOf(root, s.id, sec.id)) places.push({ g: e, skip: new Set() });
    for (const g of gaps(root, s.id)) places.push({ g, skip: new Set() });
    for (const n of neighboursIn(root, s.id)) places.push({ g: { anchor: n.id, position: "after" }, skip: new Set() });
  }
  for (const g of screenGaps(root)) places.push({ g, skip: new Set() });
  // A move: the places offered with the moved thing left out, where it is now among them.
  for (const n of all.filter((x) => x.parentId && padded(root, x.parentId)).slice(0, 60)) {
    const skip = new Set([n.id]);
    for (const g of spotsIn(root, n.parentId, skip)) places.push({ g, skip });
  }
  places.forEach(({ g, skip }, i) => {
    const p = W.place(root, g, skip);
    say(`place ${g.into ?? `${g.anchor} ${g.position}`}`, p);
    say(`whereChoice ${i}`, W.ask.whereChoice(root, g, i % 3, skip));
    say(`added ${i}`, W.reply.added(root, "a “Call us” button", p, i % 2));
    say(`moved ${i}`, W.reply.moved("the “Order now” button", p));
  });

  // The pieces a writer returns, named before they land.
  for (const piece of ['button "Call us" primary', 'row gap=2\n  text "Phone"\n  text "555-0101"', 'screen "Settings"\n  text "Settings" size=xl',
    "col border pad=3\n  text \"Split evenly\"", "shape circle w=12", "line", "input search", "table\n  tr \"Name | Date\"", "graph\n  node #a \"Plan\"\n  node #b \"Build\"\n  edge a -> b"]) {
    say(`piece ${piece.split("\n")[0]}`, W.pieceName(root, piece));
  }

  // Everything else: the questions and replies that name no one thing, and the page's own words.
  for (const op of W.OPS) {
    say(`which ${op}`, W.ask.which(op));
    say(`which unseen ${op}`, W.ask.which(op, { seen: false }));
    say(`pointedOrNamed ${op}`, W.ask.pointedOrNamed(op));
  }
  for (const s of screens) {
    say(`wholeOn ${s.text}`, W.ask.wholeOn(root, s.text));
    say(`pageChoice ${s.text}`, W.ask.pageChoice(root, s.text, screens[0].text));
    say(`noPlace ${s.text}`, W.reply.noPlace(root, s.text));
    say(`working ${s.text}`, W.working(root, "a bakery website", s.text));
  }
  for (const k of Object.keys(KINDS)) say(`noSuch ${k}`, W.reply.noSuch(k));
  for (const n of [1, 3]) { say(`built ${n}`, W.reply.built(root, n)); say(`more ${n}`, W.reply.more(n)); }
  const fixed = {
    whole: W.ask.whole(root), wholeNew: W.ask.wholeNew(root), wholeOnNone: W.ask.wholeOn(root, null), page: W.ask.page(root),
    jobChangeNone: W.ask.jobChange(root, null), replaced: W.reply.replaced(title), bringBack: W.reply.bringBack(title),
    started: W.reply.started(title), startedEmpty: W.reply.started(null), busy: W.reply.busy("make the title bigger"),
    busyAnswer: W.reply.busyAnswer("make the title bigger"), working: W.working(root, "make the title bigger"),
    status: W.status(root), saved: W.reply.saved("trial.outline"), selectedNone: W.selected(root, "nope"),
    edited: W.reply.edited(root, "clear"), clearLimit: W.reply.limit("clear", W.name(root, root.id)),
  };
  for (const [k, v] of Object.entries(fixed)) say(k, v);
  for (const [k, v] of Object.entries(W.ask)) if (typeof v === "string") say(`ask.${k}`, v);
  for (const [k, v] of Object.entries(W.reply)) if (typeof v === "string") say(`reply.${k}`, v);
  for (const [k, v] of Object.entries(W.ui)) say(`ui.${k}`, v);
  say("LEAVE", W.LEAVE);
  return out;
}

group("banned terms — every template against the ten eval apps", () => {
  test("the eval apps are all there, as built and as finished", () => {
    assert.equal(APPS.length, 20, APPS.map((a) => a.file).join(", "));
  });
  for (const { file, root } of APPS) {
    test(file, () => {
      const web = W.frameOf(root) === "web";
      const said = strings(root);
      assert.ok(said.length > 200, `only ${said.length} strings`);
      const bad = said.map((x) => ({ ...x, bad: offences(x.s, web) })).filter((x) => x.bad.length);
      assert.deepEqual(bad.slice(0, 8).map((x) => `${x.where}: ${x.s}  ← ${x.bad.join(", ")}`), []);
    });
  }
  test("the check itself catches the old words", () => {
    for (const old of [
      "in col · border · “Address · 427 Maple Street” · holds text, text, text", "text '$28.50' · bold l · Menu",
      "74 elements · haiku-4-5 → jev on", "which screen?", "save spec", "jev · element 0.82 of 5 · 214 ms",
      "remove button #n12?", "a row of 3",
    ]) assert.notDeepEqual(offences(old, true), [], old);
    assert.deepEqual(offences("Remove the “Border color” field?", true), []);
    assert.deepEqual(offences("Which screen?", false), [], "a phone app has screens");
  });
});

// ---- the names and places themselves -------------------------------------------------------------

const BAKERY = parse(`app "Crumb" web
  screen "Home"
    row #bar h=64 pad=3 fill=light justify=between
      text "Crumb" size=l bold
      button #order "Order now" primary
    col #main grow pad=4 gap=3
      text #hero "Fresh bread daily" size=xl bold
      grid #menu cols=3 gap=3
        col #sour border pad=3
          text "Sourdough"
          text #price "$6.50"
        col border pad=3
          text "Rye"
          text "$5.00"
        col border pad=3
          text "Baguette"
          text "$3.25"
      shape #photo w=400 h=200 "Shop photo"
      line #rule
      input #email "Email"
      input #find search
  screen "Visit us"
    col #visit pad=4 gap=2
      text #addr "Address"
      text #street "427 Maple Street"
      shape #dot circle w=10`).root;

group("names — by what is on them", () => {
  const cases = {
    order: "the “Order now” button", bar: "the “Crumb · Order now” bar", menu: "the cards “Sourdough · Rye · Baguette”",
    sour: "the “Sourdough” card", price: "“$6.50”", photo: "the “Shop photo” picture", rule: "the divider under “Shop photo”",
    email: "the “Email” field", find: "a search box under “Email”", dot: "a dot under “427 Maple Street”",
    main: "the part with “Fresh bread daily · Sourdough · Rye”",
  };
  for (const [id, want] of Object.entries(cases)) test(id, () => assert.equal(W.name(BAKERY, id), want));
  test("a card that holds groups is named by what they start with", () => {
    const visit = parse(`app "Crumb" web
  screen "Visit us"
    col #main grow pad=6 gap=6
      text "Visit us" size=l bold
      col #card pad=4 fill=light border
        col gap=2
          text "Hours" bold
          text "Mon – Fri: 7 AM – 7 PM"
        line
        col gap=2
          text "Location" bold
          text "247 Maple Street"`).root;
    assert.equal(W.name(visit, "card"), "the “Hours · Location” card");
    assert.equal(W.name(visit, "main"), "the part with “Visit us · Hours · Location”");
  });
  test("a website has pages; a phone app has screens", () => {
    assert.equal(W.name(BAKERY, BAKERY.children[1].id), "the “Visit us” page");
    const phone = parse('app "Split" phone\n  screen "Home"\n    text "Hi"').root;
    assert.equal(W.name(phone, phone.children[0].id), "the “Home” screen");
  });
  test("a selection says which page when there are several", () => {
    assert.equal(W.selected(BAKERY, "street"), "Selected: “427 Maple Street” on the “Visit us” page");
  });
  test("a written piece, before it is on the mock", () => {
    assert.equal(W.pieceName(BAKERY, 'button "Call us" primary'), "a “Call us” button");
    assert.equal(W.pieceName(BAKERY, 'screen "Menu"\n  text "Menu"'), "the “Menu” page");
  });
});

group("places — by what is around them", () => {
  test("between two things, at the ends of a group, somewhere in one", () => {
    assert.equal(W.place(BAKERY, { anchor: "addr", position: "after" }), "between “Address” and “427 Maple Street”");
    assert.equal(W.place(BAKERY, { anchor: "visit", position: "inside_start" }), "at the top of the part with “Address · 427 Maple Street”");
    assert.equal(W.place(BAKERY, { anchor: "bar", position: "inside_end" }), "at the right end of the “Crumb · Order now” bar");
    assert.equal(W.place(BAKERY, { into: "menu" }), "somewhere in the cards “Sourdough · Rye · Baguette”");
  });
  test("a new page", () => {
    const [first, last] = screenGaps(BAKERY);
    assert.equal(W.place(BAKERY, first), "after the “Home” page");
    assert.equal(W.place(BAKERY, last), "after the “Visit us” page, at the end");
  });
  test("a thing being moved is not its own neighbour, and where it is now says so", () => {
    assert.equal(W.place(BAKERY, { anchor: "addr", position: "after" }, new Set(["street"])), "between “Address” and a dot (where it is now)");
    assert.equal(W.place(BAKERY, { anchor: "addr", position: "after" }, new Set(["dot"])), "between “Address” and “427 Maple Street”");
    assert.equal(W.place(BAKERY, { anchor: "visit", position: "inside_end" }, new Set(["dot"])), "at the bottom of the part with “Address · 427 Maple Street” (where it is now)");
  });
});

group("replies", () => {
  test("an edit says what it did to what", () => {
    assert.equal(W.reply.edited(BAKERY, "bigger", W.name(BAKERY, "price")), "Made “$6.50” bigger.");
    assert.equal(W.reply.edited(BAKERY, "move_earlier", W.name(BAKERY, "order"), { across: true }), "Moved the “Order now” button left.");
    assert.equal(W.reply.edited(BAKERY, "darker", W.name(BAKERY, "bar"), { copies: 2 }), "Made the “Crumb · Order now” bar darker, on all 3 pages it's on.");
    assert.equal(W.reply.limit("bigger", W.name(BAKERY, "hero")), "“Fresh bread daily” is already as big as it goes.");
  });
  test("a move says where to", () => {
    assert.equal(W.reply.moved("the “Order now” button", W.place(BAKERY, { anchor: "main", position: "inside_start" })), "Moved the “Order now” button to the top of the part with “Fresh bread daily · Sourdough · Rye”.");
    assert.equal(W.reply.moved("“Rye”", W.place(BAKERY, { into: "menu" })), "Moved “Rye” into the cards “Sourdough · Rye · Baguette”.");
  });
  test("two things that read the same are told apart", () => {
    const twins = parse('app "R" web\n  screen "Runs"\n    col pad=3\n      row #a\n        text "Parser"\n        button #e1 "Edit"\n      row #b\n        text "Validator"\n        button #e2 "Edit"').root;
    assert.deepEqual(W.distinct(twins, ["e1", "e2", "a"]), ["the “Edit” button right of “Parser”", "the “Edit” button right of “Validator”", "the part with “Parser · Edit”"]);
  });
  test("questions", () => {
    assert.equal(W.ask.which("bigger"), "Which one should I make bigger?");
    assert.equal(W.ask.which("remove", { seen: false }), "I don't see that here. Remove one of these?");
    assert.equal(W.ask.whichChoice(BAKERY, "price", 0, ["Home"]), "1 · “$6.50” · on the “Home” page");
  });
});

// ---- nothing else writes to the person -------------------------------------------------------------

group("one module owns the words", () => {
  const server = readFileSync(join(HERE, "../server.mjs"), "utf8");
  test("every question, choice and reply in server.mjs comes from words.mjs", () => {
    const loose = [];
    // asking(<question>, …) and answer(<label>, …): the first argument is words.mjs's.
    for (const m of server.matchAll(/\b(asking|answer)\(([^,)]+)/g)) {
      if (/^(text|label)$/.test(m[2].trim()) || m[2].trim().startsWith("W.")) continue;
      loose.push(m[0]);
    }
    // A reply's `note` is words.mjs's too, or passed along from one that was.
    for (const m of server.matchAll(/return \{[^{}]*?\bnote: ([^,}]+)/g)) {
      const v = m[1].trim();
      if (/^(W\.|say\b|text\b|said \|\||replies\.join|w\.asked\.r\.note|r\.note|done\.map\(\(r\) => r\.note\)|r\.changed \? W\.)/.test(v)) continue;
      loose.push(m[0]);
    }
    assert.deepEqual(loose, []);
  });
  test("the page's own text is words.mjs's", () => {
    const shell = readFileSync(join(HERE, "../shell.html"), "utf8")
      .replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<details[^>]*class="dbg"[\s\S]*?<\/details>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const text = shell.replace(/<[^>]+>/g, " ").replace(/\{\{\w+\}\}/g, " ").replace(/[●…\s]+/g, " ").trim();
    assert.equal(text, "");
    const attrs = [...shell.matchAll(/\b(placeholder|title)="([^"]*)"/g)].map((m) => m[2]).filter((v) => !/^\{\{\w+\}\}$/.test(v));
    assert.deepEqual(attrs, []);
    for (const k of shell.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(Object.hasOwn(W.ui, k[1]), `{{${k[1]}}} is not in words.mjs ui`);
  });
});
