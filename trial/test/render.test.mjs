// render.test — what the canvas and the writer rely on from trial/render.mjs.
//
//   node --test "trial/test/*.test.mjs"      (Node 22+ reads arguments as globs, not directories;
//   node --test trial/test/render.test.mjs    a bare directory fails to load on Node 25)
//
// Trees are built by hand (fixture-*.mjs): the parser is written alongside the renderer and is not
// imported here. The HTML is read back with a tiny tag reader rather than a DOM library, which is
// enough because the renderer's output is regular — and a test that it is well-formed comes free.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { render, layoutGraph } from "../render.mjs";
import { relay, build } from "./fixture-relay.mjs";
import { phone } from "./fixture-phone.mjs";
import { panel } from "./fixture-panel.mjs";

const FIXTURES = { relay, phone, panel };

// ---- reading the output back -------------------------------------------------------------

const VOID = new Set(["meta", "br", "img", "input", "link", "hr"]);
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Elements as { tag, attrs, children, parent, text }, plus every close tag that did not match.
function dom(html) {
  const src = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<!doctype[^>]*>/i, "");
  const root = { tag: "#root", attrs: {}, children: [], parent: null, text: "" };
  const mismatches = [];
  let cur = root;
  for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) { cur.text += unesc(m[5]); continue; }
    const [, close, tag, raw, self] = m;
    if (close) {
      if (cur.tag !== tag) mismatches.push(`</${tag}> closes <${cur.tag}>`);
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      cur = n?.parent ?? root;
      continue;
    }
    const attrs = {};
    for (const a of raw.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? "" : unesc(a[2]);
    const el = { tag, attrs, children: [], parent: cur, text: "" };
    cur.children.push(el);
    if (!self && !VOID.has(tag)) cur = el;
  }
  if (cur !== root) mismatches.push(`<${cur.tag}> never closed`);
  return { root, mismatches };
}

const all = (el) => [el, ...el.children.flatMap(all)];
const textOf = (el) => el.text + el.children.map(textOf).join("");
const classes = (el) => (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
const styleOf = (el) => Object.fromEntries((el.attrs.style ?? "").split(";").filter(Boolean)
  .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));

function page(tree, opts) {
  const html = render(tree, opts);
  const { root, mismatches } = dom(html);
  const els = all(root);
  const byId = (id) => {
    const found = els.filter((e) => e.attrs["data-id"] === id);
    assert.equal(found.length, 1, `exactly one element for data-id="${id}" (found ${found.length})`);
    return found[0];
  };
  return { html, root, els, byId, mismatches };
}

// Nodes in document order, each with its parent.
function nodes(tree) {
  const out = [];
  const walk = (n, parent) => { out.push({ node: n, parent }); for (const c of n.children ?? []) walk(c, n); };
  walk(tree, null);
  return out;
}

// The first k nodes of a tree in document order — what the canvas holds after k streamed lines.
function prefix(tree, k) {
  let left = k;
  const walk = (n) => {
    if (left <= 0) return null;
    left -= 1;
    const copy = { ...n, props: { ...n.props }, children: [] };
    for (const c of n.children ?? []) { const cc = walk(c); if (!cc) break; copy.children.push(cc); }
    return copy;
  };
  return walk(tree);
}

const num = (v) => parseFloat(v);
const bez = (P, t) => [0, 1].map((k) => (1 - t) ** 3 * P[0][k] + 3 * (1 - t) ** 2 * t * P[1][k] + 3 * (1 - t) * t * t * P[2][k] + t ** 3 * P[3][k]);
const near = (a, b, msg) => assert.ok(Math.abs(a[0] - b[0]) < 0.15 && Math.abs(a[1] - b[1]) < 0.15, `${msg}: ${a} vs ${b}`);
const cssOf = (html) => html.match(/<style>([\s\S]*?)<\/style>/)[1];
const rules = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
const decls = (body) => body.split(";").filter((d) => d.includes(":"))
  .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]);

// ---- the document ------------------------------------------------------------------------

describe("document", () => {
  test("one self-contained html document with a single body the canvas can inject into", () => {
    for (const [name, tree] of Object.entries(FIXTURES)) {
      const { html } = page(tree);
      assert.match(html, /^<!doctype html>/, name);
      assert.equal(html.match(/<body[\s>]/g).length, 1, `${name}: one <body>`);
      assert.equal(html.match(/<\/body>/g).length, 1, `${name}: one </body>`);
      assert.match(html, /<\/main>\s*<\/body><\/html>\s*$/, `${name}: </body> closes the document`);
      assert.doesNotMatch(html, /<script|<link|<img|<iframe|@import|\b(src|href)=/i, `${name}: nothing external`);
      assert.doesNotMatch(html, /url\((?!#)/, `${name}: only in-document url(#…) references`);
    }
  });

  test("the markup is well-formed, so closest() walks the tree that was written", () => {
    for (const [name, tree] of Object.entries(FIXTURES)) assert.deepEqual(page(tree).mismatches, [], name);
  });

  test("title comes from the option, else the app's name", () => {
    assert.match(render(relay), /<title>Relay<\/title>/);
    assert.match(render(relay, { title: "Runs & agents" }), /<title>Runs &amp; agents<\/title>/);
  });

  test("text is escaped, including text that looks like the end of the body", () => {
    const tree = build(["app", "X", {}, [["screen", 'A "quoted" screen', {}, [["text", "<script>alert(1)</script></body>"]]]]]);
    const { html, byId } = page(tree);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(html.match(/<\/body>/g).length, 1);
    assert.equal(textOf(byId("n3")), "<script>alert(1)</script></body>");
    assert.equal(byId("n2").attrs["data-screen"], 'A "quoted" screen');
  });
});

// ---- ids, screens and clicking ----------------------------------------------------------

describe("ids and screens", () => {
  test("every node owns exactly one element carrying its data-id", () => {
    for (const tree of Object.values(FIXTURES)) {
      const { byId } = page(tree);
      for (const { node } of nodes(tree)) byId(node.id);
    }
  });

  test("each screen's element also carries data-screen with the screen's name", () => {
    for (const tree of Object.values(FIXTURES)) {
      const { byId, els } = page(tree);
      const screens = nodes(tree).filter(({ node }) => node.type === "screen");
      for (const { node } of screens) assert.equal(byId(node.id).attrs["data-screen"], node.text);
      assert.equal(els.filter((e) => "data-screen" in e.attrs).length, screens.length);
    }
  });

  test("a node's element sits inside its parent's, so a click lands on the innermost node", () => {
    for (const [name, tree] of Object.entries(FIXTURES)) {
      const { byId } = page(tree);
      for (const { node, parent } of nodes(tree)) {
        if (!parent) continue;
        let up = byId(node.id).parent;
        while (up && !("data-id" in up.attrs)) up = up.parent;
        assert.equal(up?.attrs["data-id"], parent.id, `${name}: ${node.type} ${node.id} inside ${parent.type} ${parent.id}`);
      }
    }
  });

  test("no clickable element opts out of pointer events", () => {
    for (const tree of Object.values(FIXTURES)) {
      const { html } = page(tree);
      assert.doesNotMatch(html, /pointer-events\s*:\s*none/);
    }
  });

  test("an unnamed screen is still addressable, by its id", () => {
    const { byId } = page(build(["app", "X", {}, [["screen"]]]));
    assert.equal(byId("n2").attrs["data-screen"], "n2");
  });
});

// ---- frames ------------------------------------------------------------------------------

describe("frames", () => {
  const boardOf = (el) => el.children.find((c) => classes(c).includes("board"));

  test("web: a 1200 wide artboard, min-height 720, its name faint above it", () => {
    const { byId } = page(relay);
    const s = byId("n2");
    const [name, art] = s.children;
    assert.ok(classes(name).includes("board-name"));
    assert.equal(textOf(name), "Runs");
    assert.equal(name.attrs["data-lint"], "ignore");
    assert.deepEqual(classes(art).slice(0, 2), ["board", "web"]);
    assert.equal(styleOf(art).width, "1200px");
    assert.equal(styleOf(art)["min-height"], "720px");
  });

  test("phone: 375 × min 760 with a status bar, and phone screens side by side in one lane", () => {
    const { root, byId } = page(phone);
    const screens = nodes(phone).filter(({ node }) => node.type === "screen").map(({ node }) => byId(node.id));
    for (const s of screens) {
      const art = boardOf(s);
      assert.ok(classes(art).includes("phone"));
      assert.equal(styleOf(art).width, "375px");
      assert.equal(styleOf(art)["min-height"], "760px");
      const status = art.children[0];
      assert.ok(classes(status).includes("status"));
      assert.equal(status.attrs["data-lint"], "ignore");
    }
    const lanes = all(root).filter((e) => classes(e).includes("lane"));
    assert.equal(lanes.length, 1);
    assert.deepEqual(lanes[0].children, screens);
  });

  test("panel: 360 wide inside a faint host strip", () => {
    const { byId } = page(panel);
    const art = boardOf(byId("n2"));
    assert.ok(classes(art).includes("panel-host"));
    const [host, body] = art.children;
    assert.ok(classes(host).includes("host"));
    assert.equal(host.attrs["data-lint"], "ignore");
    assert.ok(classes(body).includes("panel"));
    assert.equal(styleOf(body).width, "360px");
  });

  test("a screen's frame flag overrides the app's; a web screen between phones breaks the lane", () => {
    const tree = build(["app", "X", { web: true }, [
      ["screen", "A", { phone: true }], ["screen", "B", { phone: true }], ["screen", "C"], ["screen", "D", { phone: true }],
    ]]);
    const { root, byId } = page(tree);
    assert.ok(classes(boardOf(byId("n2"))).includes("phone"));
    assert.ok(classes(boardOf(byId("n4"))).includes("web"));
    const lanes = all(root).filter((e) => classes(e).includes("lane"));
    assert.deepEqual(lanes.map((l) => l.children.length), [2, 1]);
  });

  test("w and h on a screen resize its artboard", () => {
    const { byId } = page(build(["app", "X", {}, [["screen", "Wide", { w: 1440, h: 900 }]]]));
    const art = boardOf(byId("n2"));
    assert.equal(styleOf(art).width, "1440px");
    assert.equal(styleOf(art)["min-height"], "900px");
  });

  test("children attached straight to the app go on one implicit board, not dropped", () => {
    const tree = build(["app", "X", {}, [["text", "stray"], ["button", "also"], ["screen", "Real"]]]);
    const { root, byId } = page(tree);
    const loose = all(root).filter((e) => classes(e).includes("loose"));
    assert.equal(loose.length, 1);
    assert.equal("data-screen" in loose[0].attrs, false);
    assert.ok(all(loose[0]).includes(byId("n2")) && all(loose[0]).includes(byId("n3")));
  });
});

// ---- layout ------------------------------------------------------------------------------

describe("layout", () => {
  const lay = build(["app", "L", {}, [
    ["screen", "S", {}, [
      ["row#row", null, { h: "fill" }, [
        ["col#fixed", null, { w: 200, fill: "light" }],
        ["col#grow", null, { grow: true }, [
          ["button#cb", "B"],
          ["button#cbf", "B", { w: "fill" }],
          ["text#ct", "T"],
          ["text#ctp", "tag", { pill: true }],
          ["graph#cg", null, { h: "fill" }],
          ["shape#cs", "img"],
        ]],
        ["text#rt", "leaf"],
        ["input#ri", "in"],
        ["line#rl"],
        ["col#rc2", null, { grow: 2 }],
      ]],
      ["row#aligned", null, { align: "center", justify: "between", gap: 0, pad: 6 }, [["text#at", "x"], ["button#ab", "y"]]],
      ["col#styled", null, { gap: 9, pad: -1, divider: true, border: true, fill: "dark" }, [["text#dt", "white"]]],
      ["row#rdiv", null, { divider: true, gap: 1 }, [["text#r1", "a"], ["text#r2", "b"]]],
      ["grid#grid", null, { cols: 4, gap: 5 }, [["text#gt", "cell"], ["button#gb", "go"]]],
      ["col#colc", null, { align: "center", justify: "end" }, [["line#cl"]]],
    ]],
  ]]);

  test("the Relay shell: a fixed side nav and a growing main area fill the artboard height", () => {
    const { byId } = page(relay);
    const body = byId("n2").children[1];
    assert.ok(classes(body).includes("body"), "the screen's artboard lays its children out as a column");
    assert.equal(styleOf(body)["min-height"], "720px");
    const row = byId("n3");
    assert.equal(styleOf(row).flex, "1 1 0px", "row h=fill takes the remaining height");
    assert.equal(styleOf(row)["align-items"], undefined, "rows stretch their children by default");
    const nav = byId("nav");
    assert.equal(styleOf(nav).width, "200px");
    assert.equal(styleOf(nav).flex, "none");
    assert.equal(styleOf(nav)["align-self"], undefined, "the nav stretches to the row's height");
    assert.ok(classes(nav).includes("fill-light"));
    assert.equal(styleOf(nav).padding, "12px");
    assert.equal(styleOf(byId("n8")).flex, "1 1 0px", "col grow takes the remaining width");
    assert.equal(styleOf(byId("n9"))["justify-content"], "space-between");
    assert.equal(styleOf(byId("n9"))["align-items"], "center");
  });

  test("the stylesheet gives rows, cols and the artboard real flexbox", () => {
    const css = cssOf(render(relay));
    assert.match(css, /\.row\{display:flex;flex-direction:row\}/);
    assert.match(css, /\.body,\.col,\.nested-screen\{display:flex;flex-direction:column\}/);
    assert.match(css, /\.phone>\.body\{flex:1 1 auto\}/);
  });

  test("in a row, leaves sit at the top while containers and lines stretch", () => {
    const { byId } = page(lay);
    assert.equal(styleOf(byId("rt"))["align-self"], "flex-start");
    assert.equal(styleOf(byId("ri"))["align-self"], "flex-start");
    assert.equal(styleOf(byId("ri")).flex, "0 1 240px", "an input has a natural width in a row");
    assert.equal(styleOf(byId("rl"))["align-self"], undefined);
    assert.ok(classes(byId("rl")).includes("v"), "a line in a row is vertical");
    assert.equal(styleOf(byId("grow"))["align-self"], undefined);
    assert.equal(styleOf(byId("rc2")).flex, "2 1 0px", "grow=2 takes twice the share");
  });

  test("explicit align on the parent wins over a leaf's default", () => {
    const { byId } = page(lay);
    assert.equal(styleOf(byId("at"))["align-self"], undefined);
    assert.equal(styleOf(byId("ab"))["align-self"], undefined);
    assert.equal(styleOf(byId("aligned"))["align-items"], "center");
    assert.equal(styleOf(byId("colc"))["justify-content"], "flex-end");
  });

  test("in a col, text and blocks stretch across, buttons and tags keep their own width", () => {
    const { byId } = page(lay);
    assert.equal(styleOf(byId("ct"))["align-self"], undefined);
    assert.equal(styleOf(byId("cs"))["align-self"], undefined);
    assert.equal(styleOf(byId("cs")).height, "120px", "an unsized image block still has a height");
    assert.equal(styleOf(byId("cb"))["align-self"], "flex-start");
    assert.equal(styleOf(byId("ctp"))["align-self"], "flex-start");
    assert.equal(styleOf(byId("cbf"))["align-self"], "stretch", "button w=fill stretches");
    assert.equal(styleOf(byId("cg")).flex, "1 1 0px", "h=fill takes the remaining height");
    assert.ok(classes(byId("cl")).includes("h"), "a line in a col is horizontal");
  });

  test("gap and pad follow the 0 4 8 12 16 24 32 scale and clamp outside it", () => {
    const expect = [0, 4, 8, 12, 16, 24, 32];
    for (let g = 0; g <= 6; g += 1) {
      const { byId } = page(build(["app", "X", {}, [["screen", "S", {}, [["col", null, { gap: g, pad: g }]]]]]));
      assert.equal(styleOf(byId("n3")).gap, `${expect[g]}px`);
      if (g) assert.equal(styleOf(byId("n3")).padding, `${expect[g]}px`);
    }
    const { byId } = page(lay);
    assert.equal(styleOf(byId("styled")).gap, "32px", "gap=9 clamps to 6");
    assert.equal(styleOf(byId("styled")).padding, undefined, "pad=-1 clamps to 0");
    assert.equal(styleOf(byId("aligned")).gap, "0px");
    assert.equal(styleOf(byId("aligned")).padding, "32px");
  });

  test("defaults: rows and cols get an 8px gap, a screen none", () => {
    const { byId } = page(lay);
    assert.equal(styleOf(byId("row")).gap, "8px");
    assert.equal(styleOf(byId("n2").children[1]).gap, "0px");
  });

  test("divider, border and fill become classes the stylesheet draws", () => {
    const { byId, html } = page(lay);
    const styled = byId("styled");
    assert.ok(classes(styled).includes("dv-col"));
    assert.equal(styleOf(styled)["--g"], "32px");
    assert.ok(classes(styled).includes("bordered"));
    assert.ok(classes(styled).includes("fill-dark"));
    assert.ok(classes(byId("rdiv")).includes("dv-row"));
    const css = cssOf(html);
    assert.match(css, /\.dv-col>\*\+\*\{border-top:1px solid var\(--line\);padding-top:var\(--g\)\}/);
    assert.match(css, /\.bordered\{border:1px solid var\(--line\)/);
  });

  test("text on a dark fill turns white", () => {
    const css = cssOf(render(lay));
    const dark = rules(css).find((r) => r.selector === ".fill-dark");
    assert.match(dark.body, /background:#222/);
    assert.match(dark.body, /--ink:#fff/);
    assert.ok(rules(css).some((r) => r.selector === ".t" && /color:var\(--ink\)/.test(r.body)));
  });

  test("grid: cols=N equal columns; a button in a cell keeps its width", () => {
    const { byId } = page(lay);
    assert.equal(styleOf(byId("grid"))["grid-template-columns"], "repeat(4,minmax(0,1fr))");
    assert.equal(styleOf(byId("grid")).gap, "24px");
    assert.equal(styleOf(byId("gb"))["justify-self"], "start");
    assert.equal(styleOf(byId("gt"))["justify-self"], undefined);
  });

  test("w and h in px size leaves; w=fill in a row grows", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["row", null, {}, [
      ["text", "a", { w: 120, h: 40 }], ["input", "b", { w: "fill" }], ["shape", "c", { circle: true, w: 48 }],
    ]]]]]]);
    const { byId } = page(tree);
    assert.equal(styleOf(byId("n4")).width, "120px");
    assert.equal(styleOf(byId("n4")).height, "40px");
    assert.equal(styleOf(byId("n5")).flex, "1 1 0px");
    assert.equal(styleOf(byId("n6")).width, "48px");
    assert.equal(styleOf(byId("n6")).height, "48px", "a circle is as tall as it is wide");
  });
});

// ---- primitives --------------------------------------------------------------------------

describe("primitives", () => {
  const sink = build(["app", "Sink", {}, [
    ["screen", "All", { pad: 4, gap: 3 }, [
      ["text#t-plain", "Plain"],
      ["text#t-rich", "Rich", { size: "xl", bold: true, shade: "mid", mono: true }],
      ["text#t-light", "Faint", { shade: "light", size: "xs" }],
      ["text#t-pill", "running", { pill: true }],
      ["text#t-under", "Active", { under: true }],
      ["text#t-data", "1,204", { data: true }],
      ["button#b-default", "Default"],
      ["button#b-primary", "Go", { primary: true }],
      ["button#b-ghost", "Skip", { ghost: true }],
      ["input#i-plain", "Email"],
      ["input#i-value", "Name", { value: "Ana Lima" }],
      ["input#i-area", "Notes", { area: true }],
      ["input#i-check", "Remember me", { check: true, on: true }],
      ["input#i-uncheck", "Newsletter", { check: true }],
      ["input#i-toggle", "Dark mode", { toggle: true, on: true }],
      ["input#i-toggle-off", "Sounds", { toggle: true }],
      ["input#i-select", "Country", { select: true, value: "Portugal" }],
      ["input#i-search", "Search", { search: true }],
      ["shape#s-rect", "Map"],
      ["shape#s-circle", "Avatar", { circle: true }],
      ["shape#s-pill", "Badge", { pill: true }],
      ["shape#s-dot", null, { circle: true, w: 8, fill: "dark" }],
      ["shape#s-mid", "Video", { fill: "mid", w: 320, h: 180 }],
      ["line#l-h"],
      ["progress#p", "Upload", { value: 62 }],
      ["progress#p-over", null, { value: 140 }],
      ["progress#p-none"],
      ["chart#c-bar", "Weekly", { values: "3,5,2,8" }],
      ["chart#c-line", null, { line: true, values: [1, 4, 2], h: 90 }],
      ["chart#c-one", null, { values: 7 }],
      ["chart#c-none"],
      ["table#tb", null, {}, [
        ["tr#tr-h", "A | B | C"],
        ["tr#tr-d", "1 | 2", { data: true }],
        ["tr#tr-p", "x | y | z", { bold: true, shade: "mid" }],
        ["text#tb-x", "note"],
      ]],
    ]],
  ]]);
  const P = page(sink);
  const find = (el, cls) => all(el).find((e) => classes(e).includes(cls));

  test("text: size, bold, shade, mono, pill and under are classes; default is m, dark, regular", () => {
    assert.deepEqual(classes(P.byId("t-plain")), ["t", "sz-m"]);
    assert.deepEqual(classes(P.byId("t-rich")), ["t", "sz-xl", "b", "sh-mid", "mono"]);
    assert.deepEqual(classes(P.byId("t-light")), ["t", "sz-xs", "sh-light"]);
    assert.ok(classes(P.byId("t-pill")).includes("pill"));
    assert.ok(classes(P.byId("t-under")).includes("under"));
    const css = cssOf(P.html);
    for (const [cls, px] of [["xs", 11], ["s", 12], ["m", 14], ["l", 18], ["xl", 24], ["xxl", 34]]) {
      assert.match(css, new RegExp(`\\.sz-${cls}\\{font-size:${px}px`));
    }
    assert.match(css, /\.t\.pill\{border:1px solid currentColor;border-radius:999px/);
    assert.match(css, /\.t\.under\{border-bottom:2px solid currentColor/);
  });

  test("button: primary is filled, ghost is text only, default is outlined", () => {
    assert.deepEqual(classes(P.byId("b-default")).slice(0, 2), ["btn", "sz-m"]);
    assert.ok(classes(P.byId("b-primary")).includes("primary"));
    assert.ok(classes(P.byId("b-ghost")).includes("ghost"));
    assert.equal(textOf(P.byId("b-primary")), "Go");
    const css = cssOf(P.html);
    assert.match(css, /\.btn\.primary\{background:var\(--solid\)/);
    assert.match(css, /\.btn\.ghost\{background:none;border-color:transparent\}/);
    assert.match(css, /\.btn\{[^}]*border:1px solid var\(--edge\)/);
  });

  test("input: plain shows a placeholder; a value moves the words above the box", () => {
    const plain = P.byId("i-plain");
    assert.equal(textOf(find(plain, "ph")), "Email");
    assert.equal(find(plain, "inp-label"), undefined);
    const valued = P.byId("i-value");
    assert.equal(textOf(find(valued, "inp-label")), "Name");
    assert.equal(textOf(find(valued, "v")), "Ana Lima");
  });

  test("input variants: area, check, toggle, select, search", () => {
    assert.ok(classes(P.byId("i-area")).includes("area"));
    assert.match(cssOf(P.html), /\.inp\.area \.inp-box\{[^}]*min-height:6\.4em/);
    assert.ok(classes(find(P.byId("i-check"), "cb")).includes("on"));
    assert.ok(all(P.byId("i-check")).some((e) => e.tag === "svg"), "a ticked box shows its tick");
    assert.equal(classes(find(P.byId("i-uncheck"), "cb")).includes("on"), false);
    assert.ok(classes(find(P.byId("i-toggle"), "tg-pill")).includes("on"));
    assert.equal(classes(find(P.byId("i-toggle-off"), "tg-pill")).includes("on"), false);
    assert.equal(textOf(P.byId("i-toggle")), "Dark mode");
    const select = find(P.byId("i-select"), "inp-box");
    assert.equal(select.children.at(-1).tag, "svg", "a select ends in a chevron");
    assert.equal(textOf(select), "Portugal");
    const search = find(P.byId("i-search"), "inp-box");
    assert.equal(search.children[0].tag, "svg", "a search box starts with a magnifier");
  });

  test("shape: rect, circle and pill with a centred faint label; a tiny circle is a bare dot", () => {
    assert.deepEqual(classes(P.byId("s-rect")), ["shp", "rect", "f-light"]);
    assert.equal(textOf(P.byId("s-rect")), "Map");
    assert.deepEqual(classes(P.byId("s-circle")).slice(0, 2), ["shp", "circle"]);
    assert.equal(styleOf(P.byId("s-circle")).width, "40px");
    assert.equal(styleOf(P.byId("s-circle")).height, "40px");
    assert.deepEqual([styleOf(P.byId("s-pill")).width, styleOf(P.byId("s-pill")).height], ["96px", "32px"]);
    assert.ok(classes(P.byId("s-dot")).includes("f-dark"));
    assert.equal(textOf(P.byId("s-dot")), "");
    assert.ok(classes(P.byId("s-mid")).includes("f-mid"));
    assert.deepEqual([styleOf(P.byId("s-mid")).width, styleOf(P.byId("s-mid")).height], ["320px", "180px"]);
    assert.match(cssOf(P.html), /\.shp\{display:flex;align-items:center;justify-content:center/);
  });

  test("an unknown type is drawn as a shape labelled with its type", () => {
    const { byId } = page(build(["app", "X", {}, [["screen", "S", {}, [["carousel"]]]]]));
    assert.ok(classes(byId("n3")).includes("shp"));
    assert.equal(textOf(byId("n3")), "carousel");
  });

  test("line: horizontal in a col, vertical in a row, always across the parent", () => {
    assert.deepEqual(classes(P.byId("l-h")), ["ln", "h"]);
    assert.match(cssOf(P.html), /\.ln\.h\{height:1px;align-self:stretch\}\.ln\.v\{width:1px;align-self:stretch\}/);
  });

  test("progress: the bar's width is the value, clamped to 0..100", () => {
    const bar = (id) => styleOf(find(P.byId(id), "prog-bar")).width;
    assert.equal(bar("p"), "62%");
    assert.equal(bar("p-over"), "100%");
    assert.equal(bar("p-none"), "0%");
    assert.equal(textOf(find(P.byId("p"), "prog-label")), "Upload");
  });

  test("chart: one bar per value, a line through every value, no axis text", () => {
    const svg = (id) => all(P.byId(id)).find((e) => e.tag === "svg");
    assert.equal(all(svg("c-bar")).filter((e) => classes(e).includes("ch-bar")).length, 4);
    assert.equal(textOf(find(P.byId("c-bar"), "ch-cap")), "Weekly");
    const line = all(svg("c-line")).find((e) => classes(e).includes("ch-line"));
    assert.equal(line.attrs.d.split("L").length, 3);
    assert.equal(svg("c-line").attrs.height, "90");
    assert.equal(all(svg("c-one")).filter((e) => classes(e).includes("ch-bar")).length, 1);
    assert.ok(all(svg("c-none")).filter((e) => classes(e).includes("ch-bar")).length > 0, "no values still draws a chart");
    for (const id of ["c-bar", "c-line", "c-one", "c-none"]) {
      assert.equal(all(svg(id)).some((e) => e.tag === "text"), false, `${id}: no text in the plot`);
    }
  });

  test("chart bars are proportional and grow from zero", () => {
    const bars = all(P.byId("c-bar")).filter((e) => classes(e).includes("ch-bar")).map((e) => Number(e.attrs.height));
    const [a, b, , d] = bars;
    assert.ok(Math.abs(b / a - 5 / 3) < 0.02 && Math.abs(d / a - 8 / 3) < 0.02, bars.join(","));
  });

  test("table: the first tr is the header, rows are padded to the widest, other children span", () => {
    const tb = P.byId("tb");
    const head = P.byId("tr-h");
    assert.equal(head.parent.tag, "thead");
    assert.deepEqual(head.children.map((c) => [c.tag, textOf(c)]), [["th", "A"], ["th", "B"], ["th", "C"]]);
    const data = P.byId("tr-d");
    assert.deepEqual(data.children.map((c) => [c.tag, textOf(c)]), [["td", "1"], ["td", "2"], ["td", ""]]);
    assert.deepEqual(classes(P.byId("tr-p")), ["b", "sh-mid"]);
    const other = P.byId("tb-x").parent;
    assert.equal(other.tag, "td");
    assert.equal(other.attrs.colspan, "3");
    assert.ok(all(tb).includes(other));
  });

  test("a tr outside a table and a node outside a graph still draw", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["tr", "a | b"], ["node", "Lone", { sub: "x", pill: true }], ["edge", null, { from: "a", to: "b" }]]]]]);
    const { byId, els } = page(tree);
    assert.equal(byId("n3").children.length, 2);
    assert.ok(classes(byId("n4")).includes("nd") && classes(byId("n4")).includes("pill"));
    assert.equal(els.some((e) => e.attrs["data-id"] === "n5"), false, "an edge outside a graph is skipped");
  });

  test("a misplaced child under a leaf is drawn right after it, not lost", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["button", "Go", {}, [["text", "inside"]]]]]]]);
    const { byId } = page(tree);
    assert.equal(textOf(byId("n4")), "inside");
    assert.equal(byId("n4").parent, byId("n3").parent);
  });
});

// ---- graph -------------------------------------------------------------------------------

describe("graph layout", () => {
  const g = (dir, nodeIds, edges, extra = {}) => build(["graph", null, { dir, ...extra }, [
    ...nodeIds.map((id) => [`node#${id}`, id.toUpperCase()]),
    ...edges.map(([from, to, label]) => ["edge", label ?? null, { from, to }]),
  ]]);
  const at = (L) => Object.fromEntries(L.nodes.map((it) => [it.id, it]));
  const layers = (L) => Object.fromEntries(L.nodes.map((it) => [it.id, it.layer]));

  test("Relay: sources first, one layer per step, left to right on one line", () => {
    const graphNode = relay.children[0].children[0].children[1].children[1];
    assert.equal(graphNode.type, "graph");
    const L = layoutGraph(graphNode);
    assert.deepEqual(layers(L), { plan: 0, code: 1, test: 2 });
    const { plan, code, test: t } = at(L);
    assert.ok(plan.x + plan.w < code.x && code.x + code.w < t.x);
    assert.equal(plan.y + plan.h / 2, code.y + code.h / 2);
    assert.deepEqual(L.edges.map((e) => e.kind), ["forward", "forward"]);
  });

  test("layer is the longest path from a source, not the shortest", () => {
    assert.deepEqual(layers(layoutGraph(g("right", ["a", "b", "c"], [["a", "c"], ["a", "b"], ["b", "c"]]))), { a: 0, b: 1, c: 2 });
  });

  test("nodes in a layer keep document order: above-below for right, left-right for down", () => {
    const diamond = [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]];
    const R = at(layoutGraph(g("right", ["a", "c", "b", "d"], diamond)));
    assert.deepEqual([R.a.layer, R.b.layer, R.c.layer, R.d.layer], [0, 1, 1, 2]);
    assert.ok(R.c.y < R.b.y, "c was written first, so it is above b");
    assert.equal(R.b.x, R.c.x);
    const D = at(layoutGraph(g("down", ["a", "c", "b", "d"], diamond)));
    assert.ok(D.c.x < D.b.x, "c was written first, so it is left of b");
    assert.equal(D.b.y, D.c.y);
    assert.ok(D.a.y < D.b.y && D.b.y < D.d.y, "dir=down stacks layers vertically");
  });

  test("cycles are broken in document order: the edge that closes a loop turns back", () => {
    const L = layoutGraph(g("right", ["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a", "retry"]]));
    assert.deepEqual(layers(L), { a: 0, b: 1, c: 2 });
    assert.deepEqual(L.edges.map((e) => e.kind), ["forward", "forward", "back"]);
    const M = layoutGraph(g("right", ["a", "b", "c"], [["c", "a"], ["a", "b"], ["b", "c"]]));
    assert.deepEqual(layers(M), { c: 0, a: 1, b: 2 });
    assert.deepEqual(M.edges.map((e) => e.kind), ["forward", "forward", "back"]);
  });

  test("a back edge loops outside the flow: below for right, to the right for down", () => {
    const R = layoutGraph(g("right", ["a", "b"], [["a", "b"], ["b", "a"]]));
    const back = R.edges[1];
    const bottom = Math.max(...R.nodes.map((it) => it.y + it.h));
    assert.ok(back.mid[1] > bottom);
    const D = layoutGraph(g("down", ["a", "b"], [["a", "b"], ["b", "a"]]));
    const right = Math.max(...D.nodes.map((it) => it.x + it.w));
    assert.ok(D.edges[1].mid[0] > right);
  });

  test("disconnected nodes all sit in the first layer, in document order", () => {
    const L = at(layoutGraph(g("right", ["a", "b", "c"], [])));
    assert.deepEqual([L.a.layer, L.b.layer, L.c.layer], [0, 0, 0]);
    assert.ok(L.a.y < L.b.y && L.b.y < L.c.y);
  });

  test("edges to missing nodes are skipped; a self loop is kept and stays in view", () => {
    const L = layoutGraph(g("right", ["a"], [["a", "ghost"], ["nobody", "a"], ["a", "a", "again"]]));
    assert.equal(L.edges.length, 1);
    assert.equal(L.edges[0].kind, "self");
    assert.equal(L.skipped.length, 2);
    for (let t = 0; t <= 1; t += 0.05) {
      const [x, y] = bez(L.edges[0].points, t);
      assert.ok(x >= 0 && y >= 0 && x <= L.width && y <= L.height, `(${x}, ${y}) outside ${L.width}×${L.height}`);
    }
  });

  test("an edge written with #ids still finds its nodes", () => {
    const L = layoutGraph(g("right", ["a", "b"], [["#a", "#b"]]));
    assert.equal(L.edges.length, 1);
  });

  test("boxes are sized from their words, within bounds; overlong words are cut", () => {
    const L = at(layoutGraph(build(["graph", null, {}, [
      ["node#s", "Go"], ["node#m", "Summarize the page"], ["node#sub", "X", { sub: "a much longer second line" }],
      ["node#huge", "An extremely long label that no box should ever be asked to hold on one line at all"],
    ]])));
    assert.ok(L.s.w < L.m.w);
    assert.ok(L.sub.w > L.s.w, "the second line counts toward the width");
    assert.ok(L.sub.h > L.s.h, "a second line makes the box taller");
    assert.equal(L.s.w, 72, "short labels get the minimum width");
    assert.ok(L.huge.w <= 280);
    assert.ok(L.huge.label.endsWith("…"));
  });

  test("an edge label sits at the curve's midpoint", () => {
    const L = layoutGraph(g("right", ["a", "b"], [["a", "b", "go"]]));
    near(bez(L.edges[0].points, 0.5), L.edges[0].mid, "label at t=0.5");
    const a = at(L).a, b = at(L).b;
    assert.ok(L.edges[0].mid[0] > a.x + a.w && L.edges[0].mid[0] < b.x);
  });

  test("forward edges run from the facing sides of their boxes", () => {
    const R = layoutGraph(g("right", ["a", "b"], [["a", "b"]]));
    const { a, b } = at(R);
    near(R.edges[0].points[0], [a.x + a.w, a.y + a.h / 2], "leaves a's right side");
    near(R.edges[0].points[3], [b.x, b.y + b.h / 2], "enters b's left side");
    const D = layoutGraph(g("down", ["a", "b"], [["a", "b"]]));
    const d = at(D);
    near(D.edges[0].points[0], [d.a.x + d.a.w / 2, d.a.y + d.a.h], "leaves a's bottom");
    near(D.edges[0].points[3], [d.b.x + d.b.w / 2, d.b.y], "enters b's top");
  });

  test("no two boxes overlap and everything sits inside the drawing", () => {
    for (const tree of [g("right", ["a", "b", "c", "d", "e"], [["a", "b"], ["a", "c"], ["a", "d"], ["b", "e"], ["e", "a", "loop"]]),
      g("down", ["a", "b", "c", "d", "e"], [["a", "b"], ["a", "c"], ["a", "d"], ["c", "e", "long label here"], ["e", "c"]])]) {
      const L = layoutGraph(tree);
      for (const p of L.nodes) {
        assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= L.width && p.y + p.h <= L.height);
        for (const q of L.nodes) {
          if (p === q) continue;
          const apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y;
          assert.ok(apart, `${p.id} and ${q.id} overlap`);
        }
      }
      for (const e of L.edges) {
        for (let t = 0; t <= 1; t += 0.05) {
          const [x, y] = bez(e.points, t);
          assert.ok(x >= 0 && y >= 0 && x <= L.width && y <= L.height, `${e.kind} edge leaves the drawing`);
        }
      }
    }
  });

  test("an empty graph, and a graph holding a misplaced text, do not throw", () => {
    assert.deepEqual(layoutGraph(build(["graph"])).nodes, []);
    const L = layoutGraph(build(["graph", null, {}, [["text", "stray"], ["node#a", "A"]]]));
    assert.deepEqual(L.nodes.map((it) => it.label), ["stray", "A"]);
  });
});

describe("graph rendering", () => {
  test("nodes and edges are clickable svg groups; edges end in an arrowhead", () => {
    const { byId, html } = page(relay);
    const graph = byId("n12");
    assert.ok(classes(graph).includes("graph"));
    const svg = all(graph).find((e) => e.tag === "svg");
    const marker = all(svg).find((e) => e.tag === "marker");
    assert.ok(marker, "an arrowhead marker is defined");
    const edge = byId("n14");
    assert.equal(edge.tag, "g");
    const line = edge.children.find((c) => classes(c).includes("g-line"));
    assert.equal(line.attrs["marker-end"], `url(#${marker.attrs.id})`);
    assert.match(line.attrs.d, /^M[\d. ]+C[\d. ]+$/, "a cubic curve");
    // The label is drawn after every edge line, so no later line can cross it, and it carries its
    // edge's id so clicking it marks the edge.
    const label = all(svg).find((e) => classes(e).includes("g-elabel"));
    assert.equal(textOf(label), "on pass");
    assert.equal(label.attrs["data-for"], "n14");
    const order = all(svg).filter((e) => classes(e).includes("g-line") || classes(e).includes("g-elabel"));
    assert.ok(order.findIndex((e) => classes(e).includes("g-elabel")) > order.findLastIndex((e) => classes(e).includes("g-line")), "labels come after every line");
    assert.equal(byId("code").tag, "g");
    assert.deepEqual(classes(byId("test")), ["g-node", "rect", "sh-light", "dashed"]);
    assert.ok(classes(byId("code")).includes("bold"));
    assert.match(cssOf(html), /\.g-hit\{[^}]*stroke-width:12\}/, "a wide invisible stroke makes a thin edge easy to click");
  });

  test("the graph's h sizes its box; without h the box is the drawing's height", () => {
    const { byId } = page(relay);
    assert.equal(styleOf(byId("n12")).height, "260px");
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["graph", null, {}, [["node#a", "A"], ["node#b", "B"], ["edge", null, { from: "a", to: "b" }]]]]]]]);
    const L = layoutGraph(tree.children[0].children[0]);
    assert.equal(styleOf(page(tree).byId("n3")).height, `${L.height}px`);
  });

  test("a drawing bigger than its box is scaled down to fit, never up", () => {
    const { byId } = page(panel);
    const svg = all(byId("flow")).find((e) => e.tag === "svg");
    const [, , w, h] = svg.attrs.viewBox.split(" ").map(Number);
    assert.equal(svg.attrs.preserveAspectRatio, "xMidYMid meet");
    assert.equal(styleOf(svg)["max-width"], `${w}px`);
    assert.equal(styleOf(svg)["max-height"], `${h}px`);
    assert.ok(h > 360, "the panel's pipeline is taller than its 360px box, so it is shrunk");
  });

  test("marker ids are unique across graphs on one page", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [
      ["graph", null, {}, [["node#a", "A"], ["node#b", "B"], ["edge", null, { from: "a", to: "b" }]]],
      ["graph", null, {}, [["node#c", "C"], ["node#d", "D"], ["edge", null, { from: "c", to: "d" }]]],
    ]]]]);
    const ids = page(tree).els.filter((e) => e.tag === "marker").map((e) => e.attrs.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });

  test("pill and circle nodes draw as pill and circle", () => {
    const { byId } = page(panel);
    const box = (id) => byId(id).children[0];
    assert.equal(box("done").tag, "circle");
    assert.ok(classes(box("check")).includes("pill"));
    assert.equal(Number(box("check").attrs.rx), Number(box("check").attrs.height) / 2);
  });
});

// ---- partial trees -----------------------------------------------------------------------

describe("partial trees", () => {
  test("every prefix of every fixture renders, and every node written so far is on the page", () => {
    for (const [name, tree] of Object.entries(FIXTURES)) {
      const total = nodes(tree).length;
      for (let k = 1; k <= total; k += 1) {
        const part = prefix(tree, k);
        let html;
        assert.doesNotThrow(() => { html = render(part); }, `${name}: first ${k} of ${total}`);
        const ids = new Set(nodes(part).map(({ node }) => node.id));
        for (const { node } of nodes(part)) {
          if (node.type === "edge" && !(ids.has(node.props.from) && ids.has(node.props.to))) continue;
          assert.ok(html.includes(`data-id="${node.id}"`), `${name}: first ${k}: ${node.type} ${node.id} missing`);
        }
        assert.deepEqual(dom(html).mismatches, [], `${name}: first ${k} is well-formed`);
      }
    }
  });

  test("an edge written before its nodes, or to a node that never comes, is skipped", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["graph", null, {}, [
      ["edge", "early", { from: "a", to: "b" }], ["node#a", "A"], ["node#b", "B"], ["edge", null, { from: "a", to: "ghost" }],
    ]]]]]]);
    const { html, byId } = page(tree);
    assert.equal(byId("n4").tag, "g", "an edge written before its nodes is drawn once both exist");
    assert.equal(html.includes('data-id="n5"'), false, "an edge to a node that never comes is not");
  });

  test("empty containers render as empty space", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["row"], ["col"], ["grid"], ["table"], ["graph"]]]]]);
    const { byId } = page(tree);
    for (const id of ["n3", "n4", "n5", "n6", "n7"]) byId(id);
    assert.equal(textOf(byId("n6")).trim(), "");
  });

  test("nothing a half-written or hand-built tree can hold makes it throw", () => {
    const odd = [
      null, undefined, {}, { type: "app" }, { type: "APP", text: "Caps", props: null, children: null },
      { type: "screen", text: "Just a screen", children: [{ type: "text", text: "hi", id: "t" }] },
      build(["app", "X", {}, [["screen", "S", {}, [
        ["col", null, { w: "abc", h: -4, gap: 99, pad: "x", grow: "yes", align: "diagonal", justify: 3, fill: "neon" }],
        ["text", null, { size: "huge", shade: "purple" }],
        ["chart", null, { values: "x,y,z" }], ["chart", null, { values: [null, "2", -3] }],
        ["progress", null, { value: "lots" }], ["input", null, { value: true }],
        ["graph", null, { dir: "sideways", w: "fill", h: "fill" }, [["node"], ["edge"], ["edge", null, { from: null, to: undefined }]]],
        ["table", null, {}, [["tr"], ["tr", "||"]]],
        ["grid", null, { cols: 0 }], ["grid", null, { cols: 999 }],
      ]]]]),
      { type: "app", children: [{ type: "screen", children: [{ type: "row", children: [null, 3, "text"] }] }] },
    ];
    for (const tree of odd) {
      let html;
      assert.doesNotThrow(() => { html = render(tree); }, JSON.stringify(tree)?.slice(0, 80));
      assert.match(html, /^<!doctype html>[\s\S]*<\/body><\/html>\s*$/);
      assert.deepEqual(dom(html).mismatches, []);
    }
  });

  test("a root that is not an app is drawn inside one", () => {
    const { byId } = page({ id: "s1", type: "screen", text: "Alone", props: { phone: true }, children: [] });
    assert.equal(byId("s1").attrs["data-screen"], "Alone");
  });
});

// ---- greyscale ---------------------------------------------------------------------------

describe("greyscale", () => {
  const trees = { ...FIXTURES, sink: build(["app", "S", {}, [["screen", "S", { fill: "dark" }, [
    ["col", null, { fill: "mid", border: true, divider: true }, [["text", "a", { pill: true }], ["input", "b", { toggle: true, on: true }]]],
    ["graph", null, { fill: "dark" }, [["node#a", "A", { bold: true }], ["node#b", "B", { pill: true }], ["edge", "x", { from: "a", to: "b", dashed: true }]]],
    ["shape", null, { fill: "dark" }], ["chart", null, { line: true }], ["progress", null, { value: 5 }],
  ]]]]) };

  // Everything that is not text content: the stylesheet and every tag with its attributes.
  const code = (html) => cssOf(html) + (html.replace(/<style>[\s\S]*?<\/style>/, "").match(/<[^>]+>/g) ?? []).join("\n");

  test("every hex and rgb colour is a grey", () => {
    for (const [name, tree] of Object.entries(trees)) {
      const src = code(render(tree));
      for (const hex of src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
        const h = hex.slice(1).toLowerCase();
        const [r, g, b] = h.length <= 4 ? [h[0], h[1], h[2]] : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
        assert.ok(r === g && g === b, `${name}: ${hex} is not grey`);
      }
      for (const m of src.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) assert.ok(m[1] === m[2] && m[2] === m[3], `${name}: ${m[0]}`);
      assert.doesNotMatch(src, /hsla?\(|hwb\(|lab\(|lch\(|oklch\(|color\(/, name);
    }
  });

  test("colour properties only ever name greys, variables or neutral keywords", () => {
    const ok = /^(#[0-9a-f]{3,8}|var|--[\w-]+|none|transparent|currentColor|inherit|white|black|solid|dashed|\d*\.?\d+(px|em|%)?|)$/i;
    const colourish = /^(color|background|background-color|fill|stroke|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|--[\w-]+)$/;
    for (const tree of Object.values(trees)) {
      const html = render(tree);
      const inline = [...html.matchAll(/style="([^"]*)"/g)].map((m) => m[1]).join(";");
      for (const [prop, value] of decls(rules(cssOf(html)).map((r) => r.body).join(";") + ";" + inline)) {
        if (!colourish.test(prop) || prop === "--g") continue;
        for (const tok of value.split(/[\s,()]+/)) assert.match(tok, ok, `${prop}: ${value}`);
      }
      assert.doesNotMatch(html, /\s(fill|stroke|color|bgcolor)="(?!none")/, "no colour attributes outside the stylesheet");
    }
  });

  test("no shadows, no gradients, no filters", () => {
    for (const tree of Object.values(trees)) assert.doesNotMatch(render(tree), /shadow|gradient|filter\s*:|opacity\s*:\s*0?\.\d/);
  });

  test("radius is at most 4px except on pills and circles", () => {
    for (const tree of Object.values(trees)) {
      const html = render(tree);
      for (const { selector, body } of rules(cssOf(html))) {
        for (const [prop, value] of decls(body)) {
          if (prop !== "border-radius") continue;
          const px = num(value);
          if (value.endsWith("%") || px > 4) assert.match(selector, /pill|circle/, `${selector}{border-radius:${value}}`);
        }
      }
      assert.doesNotMatch(html.replace(/<style>[\s\S]*?<\/style>/, ""), /border-radius/, "no radius in inline styles");
      for (const m of html.matchAll(/<rect ([^>]*)>/g)) {
        const rx = Number(/rx="([^"]*)"/.exec(m[1])?.[1] ?? 0);
        if (rx > 4) assert.match(m[1], /class="[^"]*pill/, m[0]);
      }
    }
  });

  test("one sans font stack (and mono only where asked for)", () => {
    const css = cssOf(render(relay));
    const families = [...css.matchAll(/font-family:([^;}]+)/g)].map((m) => m[1]);
    assert.deepEqual(families, ["ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"]);
    const shorthand = [...css.matchAll(/(?<![-\w])font:([^;}]+)/g)].map((m) => m[1]);
    assert.equal(shorthand.length, 1);
    assert.match(shorthand[0], /sans-serif$/);
  });
});

// ---- lint marks --------------------------------------------------------------------------

describe("lint marks", () => {
  test("data: flagged text, tr data cells, graph node labels, chart and progress", () => {
    const { byId, els } = page(relay);
    const lint = (el) => el.attrs["data-lint"];
    for (const id of ["n17", "n18"]) {
      for (const td of byId(id).children) assert.equal(lint(td), "data");
    }
    for (const th of byId("n16").children) assert.equal(lint(th), undefined, "the header is judged");
    for (const id of ["plan", "code", "test"]) {
      const texts = byId(id).children.filter((c) => c.tag === "text");
      assert.equal(texts.length, 2);
      for (const t of texts) assert.equal(lint(t), "data");
    }
    assert.equal(lint(byId("n4")), undefined, "a nav label is judged");
    assert.equal(els.find((e) => classes(e).includes("g-elabel")).attrs["data-lint"], undefined, "an edge label is judged");

    const P = page(phone);
    assert.equal(P.byId("n6").attrs["data-lint"], "data", "text with the data flag");
    const chart = P.els.find((e) => classes(e).includes("chart"));
    const prog = P.els.find((e) => classes(e).includes("prog"));
    assert.equal(chart.attrs["data-lint"], "data");
    assert.equal(prog.attrs["data-lint"], "data");
  });

  test("ignore: artboard chrome — names, the status bar, the host strip", () => {
    for (const tree of Object.values(FIXTURES)) {
      const { els } = page(tree);
      for (const e of els.filter((x) => ["board-name", "status", "host"].some((c) => classes(x).includes(c)))) {
        assert.equal(e.attrs["data-lint"], "ignore", classes(e).join(" "));
      }
    }
    const { els } = page(phone);
    assert.equal(els.filter((e) => classes(e).includes("status")).length, 3);
  });
});

// ---- review: cases the suite above did not reach -----------------------------------------
// Added by an adversarial review of render.mjs against FORMAT.md. Each test pins one defect found
// in the rendered output (checked in a browser where the claim is about layout), so it fails until
// that defect is fixed. They use only this file's helpers, plus the two below.

// A small cascade, enough to answer "what colour is this text, on what background": compound
// class selectors only (".a.b"), ordered by class count then source order, inline style last.
// Custom properties and `color` inherit; `background` does not, so a backdrop is the nearest
// element that paints one.
function cascade(html) {
  const sheet = rules(cssOf(html)).flatMap(({ selector, body }, order) => selector.split(",").map((s) => s.trim())
    .filter((s) => /^(\.[\w-]+)+$/.test(s)).map((s) => ({ cls: s.slice(1).split("."), order, body })));
  const own = (el, prop) => {
    if (styleOf(el)[prop] !== undefined) return styleOf(el)[prop];
    let best = null;
    for (const r of sheet) {
      if (!r.cls.every((c) => classes(el).includes(c))) continue;
      for (const [k, v] of decls(r.body)) {
        if (k === prop && (!best || r.cls.length > best.spec || (r.cls.length === best.spec && r.order >= best.order))) best = { spec: r.cls.length, order: r.order, v };
      }
    }
    return best?.v ?? null;
  };
  const value = (el, prop) => {
    const inherits = prop === "color" || prop.startsWith("--");
    for (let e = el; e && e.tag !== "#root"; e = inherits ? e.parent : null) {
      const v = own(e, prop);
      if (v !== null) return v.replace(/var\((--[\w-]+)\)/g, (_, name) => value(e, name) ?? "");
    }
    return null;
  };
  const backdrop = (el) => {
    for (let e = el; e && e.tag !== "#root"; e = e.parent) {
      const v = value(e, "background");
      if (v && v !== "none" && v !== "transparent") return v;
    }
    return "#fff";
  };
  return { value, backdrop };
}

const hex = (c) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(c ?? "").trim());
  if (!m) return String(c);
  const h = m[1].toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((x) => x + x).join("") : h);
};

// Where an edge's curve enters a box that is not one of its own two ends. Nodes are drawn over
// edges, so such a stretch of edge (and a label sitting on it) is hidden behind the other node.
const inside = ([x, y], it, m = 1) => x > it.x + m && x < it.x + it.w - m && y > it.y + m && y < it.y + it.h - m;
function through(L) {
  const out = [];
  for (const e of L.edges) {
    for (const it of L.nodes) {
      if (it === e.a || it === e.b) continue;
      for (let t = 0; t <= 1; t += 0.02) {
        if (inside(bez(e.points, t), it)) { out.push(`${e.a.id} -> ${e.b.id} (${e.kind}) runs through ${it.id}`); break; }
      }
    }
  }
  return out;
}

describe("review: colour", () => {
  // FORMAT.md lets `fill` sit on any container, the app included. The app's fill class goes on
  // <main>, and its dark palette (--ink:#fff, --solid:#fff, --card:#222…) is inherited by every
  // artboard, while .board keeps a hard white background: the words go white on white, a primary
  // button turns into a white block, inputs into black ones. Seen in a browser: "Now playing"
  // computed rgb(255,255,255) on rgb(255,255,255).
  test("a fill on the app stays behind the artboards: text on a white board is not white", () => {
    const tree = build(["app", "Night", { phone: true, fill: "dark" }, [
      ["screen", "Player", {}, [["text#np", "Now playing", { size: "l", bold: true }], ["button#play", "Play", { primary: true }]]],
      ["screen", "Web", { web: true }, [["text#w", "hello"]]],
    ]]);
    const { html, byId } = page(tree);
    const C = cascade(html);
    for (const id of ["np", "w"]) {
      assert.notEqual(hex(C.value(byId(id), "color")), hex(C.backdrop(byId(id))), `${id}: text is the colour of its board`);
    }
    assert.notEqual(hex(C.value(byId("play"), "background")), hex(C.backdrop(byId("play").parent)),
      "a primary button is drawn in its board's own colour");
  });

  // The fill class goes on the phone's body, under the status bar, so a dark phone screen keeps a
  // white strip across its top.
  test("a phone screen's fill reaches its status bar", () => {
    const { html, byId } = page(build(["app", "X", { phone: true }, [["screen", "S", { fill: "dark" }, [["text", "hi"]]]]]));
    const art = byId("n2").children.find((c) => classes(c).includes("board"));
    const [status, body] = art.children;
    const C = cascade(html);
    assert.equal(hex(C.backdrop(status)), hex(C.backdrop(body)), "status bar and screen differ");
  });

  // FORMAT.md names the palette: text #111/#666/#aaa, fills #f4f4f4/#e6e6e6/#222, borders #ddd,
  // and white for text on dark. The stylesheet adds #bbb, #888, #fafafa, #eee, #d4d4d4, #ccc,
  // #333, #444 and #777.
  test("the stylesheet's greys are the ones FORMAT.md names", () => {
    const allowed = new Set(["#111", "#666", "#aaa", "#f4f4f4", "#e6e6e6", "#222", "#ddd", "#fff", "#ccc", "#999"].map(hex));
    const used = new Set((cssOf(render(relay)).match(/#[0-9a-f]{3,6}\b/gi) ?? []).map(hex));
    assert.deepEqual([...used].filter((c) => !allowed.has(c)).sort(), []);
  });
});

describe("review: graph routing", () => {
  // A skip connection (plan -> test next to plan -> code -> test) is drawn as a straight curve
  // through Coder, which is painted over it: the edge vanishes, and so does its label, which sits
  // at the curve's midpoint, the middle of Coder. In a browser, elementFromPoint at the "skip"
  // label's centre returned Coder's text.
  test("an edge that skips a layer is not drawn through the node in between", () => {
    for (const dir of ["right", "down"]) {
      const L = layoutGraph(build(["graph", null, { dir }, [
        ["node#plan", "Planner"], ["node#code", "Coder"], ["node#test", "Tester"],
        ["edge", null, { from: "plan", to: "code" }], ["edge", null, { from: "code", to: "test" }],
        ["edge", "skip", { from: "plan", to: "test" }],
      ]]));
      assert.deepEqual(through(L), [], dir);
      const code = L.nodes.find((it) => it.id === "code");
      assert.ok(!inside(L.edges.find((e) => e.label === "skip").mid, code), `${dir}: the label is under Coder`);
    }
  });

  // A back edge's loop depth comes from its two ends only, so it cuts through whatever hangs
  // lower (dir=right) or further right (dir=down): a sibling stacked under one of its ends — the
  // everyday retry loop, test -> code, with docs beside code — or a taller layer in between.
  test("a back edge loops clear of every node, not just its own two", () => {
    const retry = (dir) => build(["graph", null, { dir }, [
      ["node#plan", "Plan"], ["node#code", "Code"], ["node#docs", "Docs"], ["node#test", "Test"],
      ["edge", null, { from: "plan", to: "code" }], ["edge", null, { from: "plan", to: "docs" }],
      ["edge", null, { from: "code", to: "test" }], ["edge", "fail", { from: "test", to: "code" }],
    ]]);
    const tall = (dir) => build(["graph", null, { dir }, [
      ...["a", "b", "c", "d", "f", "e"].map((id) => [`node#${id}`, id.toUpperCase()]),
      ...[["a", "b"], ["a", "c"], ["a", "d"], ["a", "f"], ["b", "e"], ["e", "a"]].map(([from, to]) => ["edge", null, { from, to }]),
    ]]);
    const problems = [];
    for (const dir of ["right", "down"]) {
      for (const [name, g] of [["retry", retry], ["tall middle", tall]]) problems.push(...through(layoutGraph(g(dir))).map((p) => `${dir}, ${name}: ${p}`));
    }
    assert.deepEqual(problems, []);
  });
});

describe("review: layout", () => {
  // The parser keeps a misplaced child where it was written ("kept there but may not draw").
  // layoutGraph draws a container in a graph as one box labelled with its type and never renders
  // what is inside it, so those nodes have no element at all — FORMAT.md: every node's element
  // carries data-id.
  test("a container misplaced in a graph keeps its own children on the page", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["graph", null, {}, [
      ["node#a", "A"], ["col#box", null, {}, [["text#inner", "legend"], ["button#go", "Go"]]],
    ]]]]]]);
    const { byId } = page(tree);
    for (const id of ["a", "box", "inner", "go"]) byId(id);
  });

  // dim() says "50%" is ignored rather than guessed at, but num() is parseFloat, so w=30% is a
  // 30px column (measured in a browser: the nav was 30px wide). Writers do reach for % and rem.
  test("a w or h with a unit other than px is ignored, not read as pixels", () => {
    const tree = build(["app", "X", {}, [["screen", "S", {}, [["row", null, { h: "fill" }, [
      ["col#nav", null, { w: "30%", fill: "light" }], ["col#main", null, { grow: true }],
      ["shape#s", "img", { w: "20rem", h: "50vh" }],
    ]]]]]]);
    const { byId } = page(tree);
    assert.notEqual(styleOf(byId("nav")).width, "30px", "w=30% became a 30px column");
    assert.notEqual(styleOf(byId("s")).width, "20px", "w=20rem became 20px");
    assert.notEqual(styleOf(byId("s")).height, "50px", "h=50vh became 50px");
  });

  // The chart's box takes the remaining height but its plot stays pinned at 160px, so a chart
  // told to fill is a 160px chart over empty space (browser: box 718px, plot 160px).
  test("chart h=fill: the plot fills the height the chart takes", () => {
    const { byId } = page(build(["app", "X", {}, [["screen", "S", {}, [["chart#c", "Load", { h: "fill" }]]]]]));
    assert.equal(styleOf(byId("c")).flex, "1 1 0px");
    const svg = all(byId("c")).find((e) => e.tag === "svg");
    assert.doesNotMatch(svg.attrs.style ?? "", /(^|;)height:\d+px/, "the plot keeps a fixed height while its box grows");
  });

  // grow / h=fill drop a shape's default height, and .shp's overflow:hidden takes its automatic
  // minimum height to 0, so in a card that is only as tall as its content the picture vanishes
  // (browser: 274 x 2 px). A graph in the same spot gets min-height:120; a shape gets nothing.
  test("a shape with grow or h=fill keeps a visible height in a col with no height to spare", () => {
    const { byId } = page(build(["app", "X", {}, [["screen", "S", {}, [["row", null, {}, [
      ["col", null, { w: 300, border: true }, [["shape#p", "Photo", { grow: true }], ["text", "Caption"]]],
      ["col", null, { w: 300, border: true }, [["shape#q", "Photo", { h: "fill" }], ["text", "Caption"]]],
    ]]]]]]));
    for (const id of ["p", "q"]) {
      const s = styleOf(byId(id));
      assert.ok(s.height || s["min-height"], `${id}: ${byId(id).attrs.style}`);
    }
  });

  // With every value 0, hi = lo = 0 and y(0) lands on the top padding, so the bars are 1px lines
  // across the top of the plot instead of sitting on its floor.
  test("a chart of all zeros draws its bars at the bottom, not the top", () => {
    const { byId } = page(build(["app", "X", {}, [["screen", "S", {}, [["chart#z", null, { values: "0,0,0", h: 100 }]]]]]));
    for (const bar of all(byId("z")).filter((e) => classes(e).includes("ch-bar"))) {
      assert.ok(Number(bar.attrs.y) + Number(bar.attrs.height) > 90, `bar at y=${bar.attrs.y}`);
    }
  });
});

describe("review: with trial/tree.mjs's edits", () => {
  // Imported lazily: tree.mjs is being written alongside, and if it fails to load it should fail
  // these tests, not the whole file. These pin what a person sees after one of Jev's ops, so
  // either module can make them pass.
  const tree = () => import("../tree.mjs");
  const tone = (t, id) => classes(page(t).byId(id)).find((c) => c.startsWith("f-"));

  // FORMAT.md gives a shape its tone as `fill`, and its ops table steps `shade` on a shape.
  // render reads fill first, so darker / lighter on a shape that has a fill report a change and
  // draw exactly what was there.
  test("darker and lighter on a shape with a fill change what is drawn", async () => {
    const { apply } = await tree();
    const t = build(["app", "X", {}, [["screen", "S", {}, [
      ["shape#img", "Photo", { fill: "mid" }], ["shape#dot", null, { circle: true, w: 8, fill: "dark" }],
    ]]]]);
    for (const [op, id] of [["darker", "img"], ["lighter", "img"], ["lighter", "dot"]]) {
      const r = apply(t, op, id);
      assert.ok(r.changed, `${op} ${id}: ${r.note}`);
      assert.notEqual(tone(r.root, id), tone(t, id), `${op} ${id} said "${r.note}" and draws the same`);
    }
  });

  // tree.mjs once scaled an unsized thing from its own copy of this file's default sizes; they
  // drifted, and "wider" pinned a stretched image narrower than it was drawn. Now a size edit on
  // anything unsized changes nothing (the canvas hands it to the writer), so the drawing can
  // never move the wrong way. This checks that end to end: the render is byte-identical.
  test("a size edit on an unsized chart, graph or shape leaves the drawing exactly as it was", async () => {
    const { apply } = await tree();
    const t = build(["app", "X", {}, [["screen", "S", {}, [
      ["chart#ch", "Weekly"],
      ["graph#g", null, { dir: "down" }, [
        ...["a", "b", "c", "d", "e"].map((id) => [`node#${id}`, id.toUpperCase()]),
        ...[["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]].map(([from, to]) => ["edge", null, { from, to }]),
      ]],
      ["col", null, { w: 600 }, [["shape#hero", "Hero"]]],
    ]]]]);
    const before = render(t);
    for (const [op, id] of [["taller", "ch"], ["taller", "g"], ["wider", "hero"], ["shorter", "g"], ["narrower", "hero"]]) {
      const r = apply(t, op, id);
      assert.equal(r.changed, false, `${op} ${id}: ${r.note}`);
      assert.equal(render(r.root), before, `${op} ${id} changed the drawing`);
    }
  });
});
