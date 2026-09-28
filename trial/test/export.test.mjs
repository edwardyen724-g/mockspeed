// export.test — what a person takes away (trial/export.mjs).
//
//   node --test "trial/test/*.test.mjs"
//
// The prompt for an AI site builder is built by code from the outline, so it can promise what a
// model could not: every word and number on the mock is in it, quoted exactly as written, and it
// reads in plain words — the same check words.test.mjs holds the page to. Checked on the bakery,
// the three hand-built fixtures and the twenty outlines of the last ten-app run (as built, and
// after twelve follow-ups each). The HTML export is the mock with its pages anchored and no script.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, index } from "../tree.mjs";
import { render } from "../render.mjs";
import * as W from "../words.mjs";
import { builderPrompt, exportHtml, fileName } from "../export.mjs";
import { bakery } from "./fixture-bakery.mjs";
import { relay } from "./fixture-relay.mjs";
import { phone } from "./fixture-phone.mjs";
import { panel } from "./fixture-panel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = join(HERE, "../eval/runs/2026-09-26-plain-words");
const APPS = [
  { file: "bakery", root: bakery }, { file: "relay", root: relay }, { file: "phone", root: phone }, { file: "panel", root: panel },
  ...readdirSync(RUN).filter((f) => f.endsWith(".outline")).sort().map((f) => ({ file: f, root: parse(readFileSync(join(RUN, f), "utf8")).root })),
];

// Every word on the mock, as the prompt must quote it.
function wordsOn(root) {
  const out = [];
  const has = (s) => s != null && s !== true && s !== false && String(s).trim() !== "";
  for (const { node: n } of index(root)) {
    if (n === root) { if (has(n.text)) out.push(String(n.text).trim()); continue; }
    if (n.type === "tr") { for (const c of String(n.text ?? "").split("|").map((x) => x.trim()).filter(Boolean)) out.push(`“${c}”`); continue; }
    if (has(n.text)) out.push(`“${String(n.text).trim()}”`);
    if (has(n.props?.value)) out.push(n.type === "input" ? `“${String(n.props.value).trim()}”` : String(n.props.value));
    if (has(n.props?.sub)) out.push(`“${String(n.props.sub).trim()}”`);
    if (n.type === "chart" && has(n.props?.values)) for (const v of String(n.props.values).split(",").map((x) => x.trim()).filter(Boolean)) out.push(v);
  }
  return out;
}

// words.test.mjs's check: no engine word outside a “quoted” span, no ids, props, arrows or size codes.
function offences(text, web) {
  const bare = String(text).replace(/“[^”]*”/g, "“”");
  const bad = new Set([...W.BANNED, ...(web ? W.BANNED_WEB : [])]);
  const out = [...new Set((bare.match(/[A-Za-z_]+/g) ?? []).map((w) => w.toLowerCase()).filter((w) => bad.has(w)))];
  if (/#\w/.test(bare)) out.push("#id");
  if (/\w=/.test(bare)) out.push("key=value");
  if (/->/.test(bare)) out.push("->");
  if (/(^|[^A-Za-z'’])([lm]|xs|xl|xxl)(?=[^A-Za-z'’]|$)/i.test(bare)) out.push("size code");
  if (/\b(undefined|null|NaN)\b|\[object/.test(bare)) out.push("a missing value");
  return out;
}

group("the prompt for an AI site builder", () => {
  test("covers the bakery, the fixtures and the twenty outlines of the last run", () => {
    assert.equal(APPS.length, 24, APPS.map((a) => a.file).join(", "));
  });

  for (const { file, root } of APPS) {
    test(`${file}: every word and number on the mock is in it, as written`, () => {
      const p = builderPrompt(root);
      const missing = wordsOn(root).filter((w) => !p.includes(w));
      assert.deepEqual(missing, []);
    });
    test(`${file}: in plain words`, () => {
      const p = builderPrompt(root);
      const bad = p.split("\n").map((l) => ({ l, o: offences(l, W.frameOf(root) === "web") })).filter((x) => x.o.length);
      assert.deepEqual(bad, []);
    });
  }

  test("is the same every time, and leaves the mock as it was", () => {
    for (const { root } of APPS) {
      const before = JSON.stringify(root);
      assert.equal(builderPrompt(root), builderPrompt(structuredClone(root)));
      assert.equal(JSON.stringify(root), before);
    }
  });

  test("the bakery: the header, the top bar once, and each page in order", () => {
    const p = builderPrompt(bakery);
    assert.match(p, /^# Crumb Bakery\n/);
    assert.match(p, /This is a greyscale wireframe of a website with 3 pages: “Home”, “Menu”, “Visit us”\. Build it for real:/);
    for (const rule of ["Semantic HTML: header, nav, main, section, footer; one h1 per page", "Keep every word and number as written.", "Do not copy the wireframe's HTML or styles."]) assert.ok(p.includes(rule), rule);
    // The shared top bar is written out once, its links without a current one, and pointed back at
    // from each page with the page's own link current.
    assert.equal(p.match(/Links: “Home”, “Menu”, “Visit us”/g)?.length, 1);
    assert.equal(p.match(/Button “Order now” \(primary\)/g)?.length, 1);
    for (const page of ["Home", "Menu", "Visit us"]) assert.ok(p.includes(`- The top bar (as above), with “${page}” current`), page);
    // Pages in order, each with its h1.
    const at = (s) => p.indexOf(s);
    assert.ok(at("## Page 1 of 3: Home") < at("## Page 2 of 3: Menu") && at("## Page 2 of 3: Menu") < at("## Page 3 of 3: Visit us"));
    assert.ok(p.includes("The h1: “Bread baked every morning at 5”"));
    assert.ok(p.includes("The h1: “Today's bread”"));
    // Emphasis in words, a grid of cards on one line each, the table cell by cell.
    assert.ok(p.includes("- “Bread baked every morning at 5” (huge, bold)"));
    assert.ok(p.includes("- 3 cards, 3 across:\n  - Card: Picture · “Sourdough” (large, bold) · “$6.00” · Button “Add”"));
    assert.ok(p.includes("- Columns: “Day” | “Open”"));
    assert.ok(p.includes("- “Mon – Fri” | “7am – 3pm”"));
    assert.ok(p.includes("Picture of “Fresh loaves on the counter” (tall)"));
  });

  test("a phone app has screens, and a tab bar at the bottom", () => {
    const rent = APPS.find((a) => a.file === "rent.final.outline").root;
    const p = builderPrompt(rent);
    assert.ok(p.includes("a phone app with 3 screens"));
    assert.ok(p.includes("## The tab bar, on every screen"));
    assert.ok(p.includes("## Screen 2 of 3: Add expense"));
  });

  test("a label over its value, or a stat card, is not a row of links", () => {
    const rent = APPS.find((a) => a.file === "rent.final.outline").root;
    const p = builderPrompt(rent);
    assert.ok(p.includes("Card: “You are owed” (small, grey) · “$247.50” (extra large, bold) · “From 3 people” (tiny, grey)"));
    assert.ok(!/Links: “You are owed”/.test(p));
  });

  test("an address in bold over its grey lines is not a row of links, away from the navigation", () => {
    const p = builderPrompt(parse(`app "Rosie's Bakery" web
  screen "Location"
    col pad=4 gap=3
      text "Location" size=xl bold
      col border pad=3 gap=1
        text "427 Maple Street" bold
        text "Portland, OR 97214" shade=mid
        text "503-555-0142" shade=mid
        text "hello@rosiesbakery.com" shade=mid`).root);
    assert.ok(p.includes("- Card: “427 Maple Street” (bold) · “Portland, OR 97214” (grey) · “503-555-0142” (grey) · “hello@rosiesbakery.com” (grey)"), p);
    assert.ok(!p.includes("Links:"));
  });

  test("links on a page that is not shared still read as links when they name the pages", () => {
    const p = builderPrompt(parse(`app "Two" web
  screen "Home"
    row gap=4
      text "Home" bold
      text "About" shade=mid
      text "Contact" shade=mid
  screen "About"
    text "About us" size=xl bold`).root);
    assert.ok(p.includes("- Links: “Home” (current), “About”, “Contact”"), p);
  });

  test("share= on the side nav and again on the row around the whole page: the side nav is what repeats", () => {
    // As the writer built "Flour & Rise" through the app on 2026-09-27.
    const nav = (on) => `    row share=nav h=fill
      col share=nav w=200 fill=light pad=3 gap=2
        text "Flour & Rise" bold size=l
        text "Menu"${on === "Menu" ? " bold" : " shade=mid"}
        text "Visit"${on === "Visit" ? " bold" : " shade=mid"}
        text "Hours" shade=mid`;
    const root = parse(`app "Flour & Rise" web
  screen "Menu"
${nav("Menu")}
      col grow pad=6 gap=4
        text "Menu" size=xl bold
        text "Sourdough Loaf" bold
  screen "Visit"
${nav("Visit")}
      col grow pad=6 gap=4
        text "Visit Us" size=l bold
        text "427 Main Street" bold
        text "Portland, Oregon 97214" shade=mid
        text "503.555.0142" shade=mid`).root;
    const p = builderPrompt(root);
    assert.ok(p.includes("## The side navigation, on every page\n\nOn each page, the link to that page is shown as the current one.\n\n- Panel:\n  - “Flour & Rise” (large, bold)\n  - Links: “Menu”, “Visit”, “Hours”\n"), p);
    assert.ok(p.includes("  - The side navigation (as above), with “Visit” current\n  - Column:\n    - “Visit Us” (large, bold)\n    - “427 Main Street” (bold)"), p);
    assert.ok(!p.includes("“Sourdough Loaf” (bold)\n") || p.indexOf("“Sourdough Loaf”") > p.indexOf("## Page 1"));
    // The HTML links the navigation's page names, and not the page's own heading.
    const h = exportHtml(root);
    assert.equal(h.match(/href="#visit"/g).length, 1 + 2);
    assert.ok(/<div class="t[^"]*"[^>]*>Menu<\/div>/.test(h));
  });

  test("a side nav's bold group heading is not its current link", () => {
    const crm = APPS.find((a) => a.file === "crm.final.outline").root;
    const p = builderPrompt(crm);
    assert.ok(p.includes("  - “Pipeline” (bold)\n  - Links: “Leads”, “Active”, “Closed”, “Lost”"));
    assert.ok(!p.includes("with “Pipeline” current"));
  });

  test("an empty canvas still says what it is", () => {
    const p = builderPrompt(parse(`app "Nothing yet" web`).root);
    assert.match(p, /a website with 0 pages\. Build it for real:/);
  });
});

group("the HTML export", () => {
  const html = exportHtml(bakery);
  test("opens on its own: no script, nothing loaded from anywhere", () => {
    assert.ok(!/<script/i.test(html));
    assert.ok(!/\b(src|href)="(https?:)?\/\//i.test(html));
    assert.ok(!/<link\b/i.test(html));
  });
  test("every page is anchored, and listed at the top", () => {
    for (const [name, id] of [["Home", "home"], ["Menu", "menu"], ["Visit us", "visit-us"]]) {
      assert.ok(html.includes(`id="${id}"`), id);
      assert.ok(html.includes(`<a href="#${id}">${name}</a>`), name);
    }
    assert.ok(html.indexOf('class="pages"') < html.indexOf('data-screen="Home"'));
  });
  test("a page's name in the shared top bar goes to that page; the same words elsewhere do not", () => {
    assert.match(html, /<a class="t[^"]*"[^>]*href="#menu">Menu<\/a>/);
    assert.equal(html.match(/href="#visit-us"/g).length, 1 + 3);   // the list at the top, and the bar on each page
    assert.ok(/<div class="t[^"]*"[^>]*>Visit us<\/div>/.test(html));   // the page's own heading
  });
  test("the mock in the editor is drawn as before", () => {
    const plain = render(bakery);
    assert.ok(!plain.includes('class="pages"'));
    assert.ok(!plain.includes("href="));
    assert.ok(!/<section[^>]* id=/.test(plain));
  });
  test("two pages with the same name get different anchors", () => {
    const h = exportHtml(parse(`app "Twice" web\n  screen "Home"\n    text "a"\n  screen "Home"\n    text "b"`).root);
    assert.ok(h.includes('id="home"') && h.includes('id="home-2"'));
  });
  test("file names come from the app's name", () => {
    assert.equal(fileName(bakery, "html"), "crumb-bakery.html");
    assert.equal(fileName(parse(`app "Café Olé!" web`).root, "md"), "cafe-ole.md");
    assert.equal(fileName(parse(`app "Rosie's Bakery" web`).root, "html"), "rosies-bakery.html");
    assert.equal(fileName(parse(`app web`).root, "md"), "mock.md");
  });
});
