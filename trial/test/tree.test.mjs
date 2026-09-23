// tree.test — the outline contract in FORMAT.md, held to by code.
//
//   node --test trial/test/
//
// The FORMAT.md example is copied in verbatim: it is the shape the writer is told to produce,
// so it has to parse with no warnings and with the ids the doc implies. Everything else is here
// because a writer model will eventually produce it: bad indentation, unknown types, unclosed
// quotes, stray fences. None of it may throw, and Stream and parse must agree on all of it.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES, parse, Stream, nextId, serialize, index, find, describe, applyPatch, apply, gaps, screenGaps, placeAt, shapeOf,
} from "../tree.mjs";

// ---- fixtures ----------------------------------------------------------------------------

const RELAY = `app "Relay" web
  screen "Runs"
    row h=fill
      col #nav w=200 fill=light pad=3 gap=2
        text "Relay" size=l bold
        text "Runs" bold
        text "Agents" shade=mid
        text "Settings" shade=mid
      col grow pad=4 gap=3
        row justify=between align=center
          text "Run 1482" size=xl bold
          button "Stop run" primary
        graph dir=right h=260
          node #plan "Planner" sub="done · 12s"
          node #code "Coder" sub="running" bold
          node #test "Tester" sub="waiting" shade=light border=dashed
          edge plan -> code
          edge code -> test "on pass"
        table
          tr "Step | Agent | Tokens | Time"
          tr "Plan tasks | Planner | 1,204 | 12s" data
          tr "Write fix | Coder | 8,730 | 41s" data
`;

// Every primitive, and every way a prop can be written.
const KITCHEN = `app "Kitchen" phone
  // comments and blank lines are ignored

  screen "Home" panel
    col gap=2 pad=4 border divider align=stretch justify=start
      text "Title" size=xxl bold shade=dark
      text "Mono tag" size=xs mono pill under data
      grid cols=3 gap=1
        shape "photo" w=120 h=80
        shape circle w=40 h=40
        shape "chip" pill
      line
      button "Save" primary w=fill
      button "Skip" ghost
      button "Plain"
      input "Name" value="Ada Lovelace"
      input "Notes" area
      input "Remember me" check on
      input "Dark mode" toggle
      input "Country" select value="Norway"
      input "Search" search
      progress "Upload" value=60
      chart "Tokens" line values=3,5,2,8 h=80
      chart bar values="1, 2, 3"
      row w=fill h=48 grow fill=dark
        text "On dark"
      table
        tr "A | B" bold shade=mid
        tr "1 | 2" data
      graph dir=down w=400 h=200
        node #a "Start" sub="first step" circle
        node #b "End" pill border=dashed
        edge a -> b "then" dashed
`;

const CHAT = `app "Threads" web
  screen "Inbox"
    row h=fill
      col #list w=280 border
        text "Inbox" size=l bold
        input "Search" search
        col #threads gap=1
          text "Mara · design review" bold
          text "Jon · invoices" shade=mid
      col #thread grow pad=4 gap=3
        text "Design review" size=l bold
        col gap=2
          text "Can we move the nav left?" pill
          text "Yes, pushing now" pill shade=mid
        row gap=2
          input "Reply" grow
          button "Send" primary
  screen "Settings"
    col pad=4 gap=2
      text "Settings" size=xl bold
      input "Email notifications" toggle on
`;

const snapshot = (x) => structuredClone(x);
const ids = (root) => index(root).map((e) => e.id);
const byId = (root, id) => find(root, id)?.node;
const streamed = (text) => {
  const s = new Stream();
  for (const line of text.split(/\r\n|\r|\n/)) s.push(line);
  return s;
};

// ---- vocabulary --------------------------------------------------------------------------

group("TYPES", () => {
  test("lists every primitive with container and parent rules", () => {
    assert.deepEqual(Object.keys(TYPES).sort(), [
      "app", "button", "chart", "col", "edge", "graph", "grid", "input", "line", "node",
      "progress", "row", "screen", "shape", "table", "text", "tr",
    ]);
    for (const t of ["app", "screen", "row", "col", "grid", "table", "graph"]) assert.equal(TYPES[t].container, true, t);
    for (const t of ["text", "button", "input", "shape", "line", "progress", "chart", "tr", "node", "edge"]) assert.equal(TYPES[t].container, false, t);
    assert.deepEqual(TYPES.app.parents, []);
    assert.deepEqual(TYPES.screen.parents, ["app"]);
    assert.deepEqual(TYPES.tr.parents, ["table"]);
    assert.deepEqual(TYPES.node.parents, ["graph"]);
    assert.deepEqual(TYPES.edge.parents, ["graph"]);
    assert.equal(TYPES.text.parents, undefined);
  });

  test("is frozen", () => {
    assert.ok(Object.isFrozen(TYPES));
    assert.ok(Object.isFrozen(TYPES.text));
  });
});

// ---- parse: the FORMAT.md example ----------------------------------------------------------

group("parse · the FORMAT.md example", () => {
  const { root, warnings } = parse(RELAY);

  test("reads with no warnings", () => {
    assert.deepEqual(warnings, []);
  });

  test("numbers unnamed nodes n1, n2, … in document order; named ones keep their names", () => {
    assert.deepEqual(ids(root), [
      "n1", "n2", "n3", "nav", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11",
      "n12", "plan", "code", "test", "n13", "n14", "n15", "n16", "n17", "n18",
    ]);
    assert.equal(root.next, 19);
    assert.equal(nextId(root), 19);
  });

  test("the root is the app, its children are screens", () => {
    assert.equal(root.type, "app");
    assert.equal(root.text, "Relay");
    assert.deepEqual(root.props, { web: true });
    assert.equal(root.children.length, 1);
    assert.deepEqual({ ...root.children[0], children: [] }, { id: "n2", type: "screen", text: "Runs", props: {}, children: [] });
  });

  test("props: numbers are numbers, flags are true, quoted values keep spaces", () => {
    assert.deepEqual(byId(root, "nav").props, { w: 200, fill: "light", pad: 3, gap: 2 });
    assert.deepEqual(byId(root, "n3").props, { h: "fill" });
    assert.deepEqual(byId(root, "n4"), { id: "n4", type: "text", text: "Relay", props: { size: "l", bold: true }, children: [] });
    assert.deepEqual(byId(root, "n9").props, { justify: "between", align: "center" });
    assert.deepEqual(byId(root, "n11").props, { primary: true });
    assert.deepEqual(byId(root, "n12").props, { dir: "right", h: 260 });
    assert.deepEqual(byId(root, "plan").props, { sub: "done · 12s" });
    assert.deepEqual(byId(root, "code").props, { sub: "running", bold: true });
    assert.deepEqual(byId(root, "test").props, { sub: "waiting", shade: "light", border: "dashed" });
  });

  test("edges carry their ends in props and their label as text", () => {
    assert.deepEqual(byId(root, "n13"), { id: "n13", type: "edge", text: null, props: { from: "plan", to: "code" }, children: [] });
    assert.deepEqual(byId(root, "n14"), { id: "n14", type: "edge", text: "on pass", props: { from: "code", to: "test" }, children: [] });
  });

  test("table rows keep their cells as one text", () => {
    const table = byId(root, "n15");
    assert.deepEqual(table.children.map((r) => [r.type, r.text, r.props]), [
      ["tr", "Step | Agent | Tokens | Time", {}],
      ["tr", "Plan tasks | Planner | 1,204 | 12s", { data: true }],
      ["tr", "Write fix | Coder | 8,730 | 41s", { data: true }],
    ]);
  });

  test("is plain JSON", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(root)), root);
    assert.deepEqual(structuredClone(root), root);
  });
});

// ---- parse: primitives and prop forms ------------------------------------------------------

group("parse · primitives and props", () => {
  const { root, warnings } = parse(KITCHEN);
  const col = root.children[0].children[0];
  const at = (i) => col.children[i];

  test("the kitchen sink reads clean", () => {
    assert.deepEqual(warnings, []);
    assert.deepEqual(root.props, { phone: true });
    assert.deepEqual(root.children[0].props, { panel: true });
  });

  test("layout props on a container", () => {
    assert.deepEqual(col.props, { gap: 2, pad: 4, border: true, divider: true, align: "stretch", justify: "start" });
    assert.deepEqual(at(2).props, { cols: 3, gap: 1 });
    assert.deepEqual(at(16).props, { w: "fill", h: 48, grow: true, fill: "dark" });
  });

  test("text flags", () => {
    assert.deepEqual(at(0).props, { size: "xxl", bold: true, shade: "dark" });
    assert.deepEqual(at(1).props, { size: "xs", mono: true, pill: true, under: true, data: true });
  });

  test("shapes, line, buttons", () => {
    assert.deepEqual(at(2).children.map((s) => [s.text, s.props]), [
      ["photo", { w: 120, h: 80 }],
      [null, { circle: true, w: 40, h: 40 }],
      ["chip", { pill: true }],
    ]);
    assert.equal(at(3).type, "line");
    assert.equal(at(3).text, null);
    assert.deepEqual([at(4).props, at(5).props, at(6).props], [{ primary: true, w: "fill" }, { ghost: true }, {}]);
  });

  test("inputs", () => {
    assert.deepEqual(at(7), { id: at(7).id, type: "input", text: "Name", props: { value: "Ada Lovelace" }, children: [] });
    assert.deepEqual(at(8).props, { area: true });
    assert.deepEqual(at(9).props, { check: true, on: true });
    assert.deepEqual(at(10).props, { toggle: true });
    assert.deepEqual(at(11).props, { select: true, value: "Norway" });
    assert.deepEqual(at(12).props, { search: true });
  });

  test("progress and charts: a bare list stays a string, a quoted one keeps its spaces", () => {
    assert.deepEqual(at(13).props, { value: 60 });
    assert.deepEqual(at(14).props, { line: true, values: "3,5,2,8", h: 80 });
    assert.deepEqual(at(15), { id: at(15).id, type: "chart", text: null, props: { bar: true, values: "1, 2, 3" }, children: [] });
  });

  test("table rows and graph", () => {
    assert.deepEqual(at(17).children.map((r) => r.props), [{ bold: true, shade: "mid" }, { data: true }]);
    const g = at(18);
    assert.deepEqual(g.props, { dir: "down", w: 400, h: 200 });
    assert.deepEqual(g.children.map((c) => [c.id, c.type, c.text, c.props]), [
      ["a", "node", "Start", { sub: "first step", circle: true }],
      ["b", "node", "End", { pill: true, border: "dashed" }],
      [g.children[2].id, "edge", "then", { from: "a", to: "b", dashed: true }],
    ]);
  });

  test("value forms: numbers, decimals, negatives, booleans, quoted numbers, empty", () => {
    const { root: r, warnings: w } = parse('app\n  screen\n    text "x" a=3 b=0.5 c=-2 d=true e=false f="200" g="true" h= i="" j=1e3');
    assert.deepEqual(w, []);
    assert.deepEqual(r.children[0].children[0].props, { a: 3, b: 0.5, c: -2, d: true, e: false, f: "200", g: "true", h: "", i: "", j: 1000 });
  });

  test("types are case-insensitive and flags are lower-cased", () => {
    const { root: r } = parse('APP "A"\n  Screen "S"\n    TEXT "x" Bold SIZE=l');
    const t = r.children[0].children[0];
    assert.equal(t.type, "text");
    assert.deepEqual(t.props, { bold: true, size: "l" });
  });

  test("the id may come anywhere on the line; text= sets the text", () => {
    const { root: r, warnings: w } = parse('app\n  screen\n    text "Hi" bold #greet\n    text size=s text="From a prop"\n    text id=named "x"');
    assert.deepEqual(w, []);
    const [a, b, c] = r.children[0].children;
    assert.deepEqual([a.id, a.text, a.props], ["greet", "Hi", { bold: true }]);
    assert.deepEqual([b.text, b.props], ["From a prop", { size: "s" }]);
    assert.equal(c.id, "named");
  });

  test("quoted text keeps #, =, //, -> and | as words", () => {
    const { root: r, warnings: w } = parse('app\n  screen\n    text "a=b #c // d -> e | f"');
    assert.deepEqual(w, []);
    const t = r.children[0].children[0];
    assert.equal(t.text, "a=b #c // d -> e | f");
    assert.deepEqual(t.props, {});
  });

  test("a line with only a comment, and blank lines, add nothing", () => {
    const { root: r } = parse('app\n\n   \n  // note\n  screen "S"\n    // another\n');
    assert.equal(index(r).length, 2);
  });

  test("a bare empty text is a text, not null", () => {
    const { root: r } = parse('app\n  screen\n    text ""');
    assert.equal(r.children[0].children[0].text, "");
  });
});

// ---- parse: tolerance ----------------------------------------------------------------------

group("parse · tolerance", () => {
  const one = (line, head = 'app "A"\n  screen "S"\n') => {
    const { root, warnings } = parse(head + line);
    return { node: root.children[0].children.at(-1), root, warnings };
  };

  test("an unknown type is a shape labelled with the line; its id and shape props survive", () => {
    const { node, warnings } = one('    avatar #me "Ed" circle w=40 size=l');
    assert.deepEqual(node, { id: "me", type: "shape", text: "avatar Ed size=l", props: { circle: true, w: 40 }, children: [] });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /line 3: unknown type 'avatar'/);
  });

  test("a line of prose is a shape too", () => {
    const { node, warnings } = one("    Here's the outline you asked for:");
    assert.equal(node.type, "shape");
    assert.equal(node.text, "Here's the outline you asked for:");
    assert.equal(warnings.length, 1);
  });

  test("children indented under an unknown type join its container", () => {
    const { root, warnings } = parse('app\n  screen "S"\n    sidebar\n      text "a"\n      text "b"');
    assert.deepEqual(root.children[0].children.map((c) => c.type), ["shape", "text", "text"]);
    assert.equal(warnings.length, 3);
    assert.match(warnings[1], /holds nothing; put in screen "S"/);
  });

  test("an unclosed quote reads to the end of the line", () => {
    const { node, warnings } = one('    text "Hello there size=l');
    assert.equal(node.text, "Hello there size=l");
    assert.deepEqual(node.props, {});
    assert.match(warnings[0], /never closed/);
  });

  test("an unclosed quoted value reads to the end of the line", () => {
    const { node, warnings } = one('    input "Name" value="Ada Love');
    assert.deepEqual(node.props, { value: "Ada Love" });
    assert.match(warnings[0], /value="… is never closed/);
  });

  test("trailing junk and trailing comments are dropped with a warning each", () => {
    const { node, warnings } = one('    text "x" bold ))) , // the title');
    assert.deepEqual(node.props, { bold: true });
    assert.deepEqual(warnings.map((w) => w.replace(/^line \d+: /, "")), ["')))' ignored", "',' ignored", "trailing comment dropped"]);
  });

  test("a second quoted text, a second id and a repeated prop are reported", () => {
    const { node, warnings } = one('    text #a #b "one" "two" size=s size=l');
    assert.deepEqual([node.id, node.text, node.props], ["a", "one", { size: "l" }]);
    assert.equal(warnings.length, 3);
  });

  test("`text:` and `size = l` are read the way they were meant", () => {
    const { node, warnings } = one('    text: "x" size = l');
    assert.equal(node.type, "text");
    assert.deepEqual(node.props, { size: "l" });
    assert.deepEqual(warnings, []);
  });

  test("an arrow on a non-edge line is ignored with a warning", () => {
    const { node, warnings } = one('    text "x" -> y');
    assert.deepEqual(node.props, { y: true });
    assert.match(warnings[0], /only means something on an edge line/);
  });

  test("CRLF, lone CR and LF read the same", () => {
    const lf = parse(RELAY);
    assert.deepEqual(parse(RELAY.replace(/\n/g, "\r\n")), lf);
    assert.deepEqual(parse(RELAY.replace(/\n/g, "\r")), lf);
  });

  test("any consistent indent width is accepted without warnings", () => {
    const four = RELAY.replace(/^( +)/gm, (s) => s + s);
    const { root, warnings } = parse(four);
    assert.deepEqual(warnings, []);
    assert.deepEqual(root, parse(RELAY).root);
  });

  test("tabs are read as two spaces, with one warning", () => {
    const tabbed = RELAY.replace(/^( +)/gm, (s) => "\t".repeat(s.length / 2));
    const { root, warnings } = parse(tabbed);
    assert.deepEqual(root, parse(RELAY).root);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^line 2: tabs in the indentation/);
  });

  test("a dedent that lands between levels attaches to the open level above it", () => {
    const { root, warnings } = parse('app\n  screen "S"\n    col\n      text "a"\n     text "b"');
    const col = root.children[0].children[0];
    assert.deepEqual(col.children.map((c) => c.text), ["a", "b"]);
    assert.deepEqual(warnings, ["line 5: indent 5 lines up with no line above it; read as inside col #n3"]);
  });

  test("a step in that does not match the outline's step still nests, with a warning", () => {
    const { root, warnings } = parse('app\n  screen "S"\n    col\n          text "deep"');
    assert.equal(root.children[0].children[0].children[0].text, "deep");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /indented 6 past its parent where the outline steps by 2/);
  });

  test("a line indented under a leaf joins the leaf's container", () => {
    const { root, warnings } = parse('app\n  screen "S"\n    row\n      text "a"\n        text "b"\n          button "c"');
    const row = root.children[0].children[0];
    assert.deepEqual(row.children.map((c) => c.text), ["a", "b", "c"]);
    assert.equal(warnings.length, 2);
  });

  test("screens at the app's own indent still land in the app", () => {
    const { root, warnings } = parse('app "A"\nscreen "One"\n  text "x"\nscreen "Two"');
    assert.deepEqual(root.children.map((s) => s.text), ["One", "Two"]);
    assert.equal(root.children[0].children[0].text, "x");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /at or left of the app line/);
  });

  test("a screen nested in a container moves up to the app, and its children follow it", () => {
    const { root, warnings } = parse('app\n  screen "A"\n    row\n      screen "B"\n        text "in B"\n      text "back in row"');
    assert.deepEqual(root.children.map((s) => s.text), ["A", "B"]);
    assert.equal(root.children[1].children[0].text, "in B");
    assert.equal(root.children[0].children[0].children[0].text, "back in row");
    assert.equal(warnings.length, 1);
  });

  test("a non-screen straight in the app goes into the last screen", () => {
    const { root, warnings } = parse('app\n  screen "A"\n    text "a"\n  text "stray"');
    assert.deepEqual(root.children[0].children.map((c) => c.text), ["a", "stray"]);
    assert.match(warnings[0], /sits directly in the app; put in screen "A"/);
  });

  test("with no screen yet, a non-screen gets a new screen called Main", () => {
    const { root, warnings } = parse('app "A"\n  text "a"\n  text "b"\n  screen "Later"');
    assert.deepEqual(root.children.map((s) => [s.id, s.text]), [["n2", "Main"], ["n5", "Later"]]);
    assert.deepEqual(root.children[0].children.map((c) => [c.id, c.text]), [["n3", "a"], ["n4", "b"]]);
    assert.equal(warnings.length, 2);
  });

  test("with no app line, an app starts around the first line", () => {
    const { root, warnings } = parse('screen "Runs"\n  text "x"');
    assert.equal(root.type, "app");
    assert.equal(root.text, null);
    assert.equal(root.id, "n1");
    assert.deepEqual([root.children[0].id, root.children[0].text], ["n2", "Runs"]);
    assert.deepEqual(warnings, ["line 1: no app line before this screen; started an app around it"]);
  });

  test("a first line that is not even a screen gets an app and a screen", () => {
    const { root, warnings } = parse('row\n  text "x"');
    assert.deepEqual(index(root).map((e) => [e.id, e.type]), [["n1", "app"], ["n2", "screen"], ["n3", "row"], ["n4", "text"]]);
    assert.equal(warnings.length, 2);
  });

  test("an app line that comes after content names the app", () => {
    const { root, warnings } = parse('```\nscreen "S"\n  text "x"\napp "Late" phone\n  screen "T"');
    assert.equal(root.text, "Late");
    assert.deepEqual(root.props, { phone: true });
    assert.deepEqual(root.children.map((s) => s.text), ["S", "T"]);
    assert.equal(warnings.length, 3);
  });

  test("a second app line only adds its children to the first app", () => {
    const { root, warnings } = parse('app "One"\n  screen "A"\napp "Two" phone\n  screen "B"');
    assert.equal(root.text, "One");
    assert.deepEqual(root.props, {});
    assert.deepEqual(root.children.map((s) => s.text), ["A", "B"]);
    assert.match(warnings[0], /a second app line/);
  });

  test("tr rows written at the table's own indent go into the table", () => {
    const { root, warnings } = parse('app\n  screen\n    table\n    tr "a | b"\n    tr "c | d"');
    const screen = root.children[0];
    assert.equal(screen.children.length, 1);
    assert.deepEqual(screen.children[0].children.map((r) => r.text), ["a | b", "c | d"]);
    assert.equal(warnings.length, 2);
  });

  test("nodes and edges at the graph's own indent go into the graph", () => {
    const { root, warnings } = parse('app\n  screen\n    graph\n    node #a "A"\n    node #b "B"\n    edge a -> b');
    assert.deepEqual(root.children[0].children[0].children.map((c) => c.type), ["node", "node", "edge"]);
    assert.equal(warnings.length, 3);
  });

  test("rows and nodes that fall out to the app still find the table or graph above them", () => {
    // Found by the fuzz test below: the app-level redirect used to skip this rule, so the
    // outline written back out read differently from the one that was parsed.
    const { root, warnings } = parse('graph\nnode #a\ntable\ntr "x"');
    const screen = root.children[0];
    assert.deepEqual(screen.children.map((c) => [c.type, c.children.map((k) => k.type)]), [["graph", ["node"]], ["table", ["tr"]]]);
    assert.deepEqual(parse(serialize(root)).root, root);
    assert.equal(warnings.length, 7);
  });

  test("a node with no graph near it stays where it was written", () => {
    const { root, warnings } = parse('app\n  screen "S"\n    node "stray"');
    assert.equal(root.children[0].children[0].type, "node");
    assert.match(warnings[0], /node belongs in a graph, not screen "S"; kept there/);
  });

  test("a text inside a table or a graph stays there, with a warning", () => {
    const { root, warnings } = parse('app\n  screen\n    table\n      text "x"\n    graph\n      text "y"');
    assert.equal(root.children[0].children[0].children[0].text, "x");
    assert.equal(root.children[0].children[1].children[0].text, "y");
    assert.equal(warnings.length, 2);
  });

  test("a duplicate id is renamed rather than shared", () => {
    const { root, warnings } = parse('app\n  screen\n    text #a "one"\n    text #a "two"');
    assert.deepEqual(root.children[0].children.map((c) => c.id), ["a", "n3"]);
    assert.match(warnings[0], /#a is already taken; this text is #n3/);
  });

  test("code fences are skipped", () => {
    const { root, warnings } = parse("```\n" + RELAY + "```\n");
    assert.deepEqual(root, parse(RELAY).root);
    assert.equal(warnings.length, 2);
  });

  test("an empty outline is an empty app", () => {
    for (const input of ["", "\n\n", undefined, null]) {
      const { root, warnings } = parse(input);
      assert.deepEqual(root, { id: "n1", type: "app", text: null, props: {}, children: [], next: 2 });
      assert.equal(warnings.length, 1);
    }
  });

  test("props named id or text cannot sneak in as flags", () => {
    const { node, warnings } = one('    text "x" id text');
    assert.deepEqual(node.props, {});
    assert.equal(warnings.length, 2);
  });

  test("never throws, and what it builds survives serialize and Stream", () => {
    const pieces = [
      "app", "screen", "row", "col", "grid", "text", "button", "input", "shape", "line", "chart", "table", "tr", "graph",
      "node", "edge", "avatar", "#a", "#b", "#n3", "#", '"hi"', '"a b', '"', "=", "w=10", 'x="y', "k=", "bold", "->", "→",
      "a->b", "//", "```", ")))", "\t", "  ", "    ", "é", "size = l", "text:", "sub=a->b", "c=#fff", "id=q", "1e400",
    ];
    let seed = 7;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let doc = 0; doc < 300; doc++) {
      const lines = [];
      for (let l = 0; l < 1 + rand(14); l++) {
        let line = " ".repeat(rand(4) * 2 + rand(2));
        for (let p = 0; p < 1 + rand(5); p++) line += pieces[rand(pieces.length)] + " ";
        lines.push(line);
      }
      const text = lines.join(rand(2) ? "\n" : "\r\n");
      const { root } = parse(text);
      const again = parse(serialize(root)).root;
      assert.deepEqual(again, root, `round trip failed for:\n${text}`);
      assert.deepEqual(streamed(text).root, root, `stream differs for:\n${text}`);
      assert.doesNotThrow(() => { index(root).forEach((e) => describe(e.node)); });
    }
  });
});

// ---- ids ---------------------------------------------------------------------------------

group("ids", () => {
  test("named nodes do not use up numbers", () => {
    const { root } = parse('app #main\n  screen #home\n    text "a"\n    text #b "b"\n    text "c"');
    assert.deepEqual(ids(root), ["main", "home", "n1", "b", "n2"]);
    assert.equal(nextId(root), 3);
  });

  test("an explicit automatic-looking id moves the counter past it", () => {
    const { root } = parse('app\n  screen\n    text #n40 "a"\n    text "b"');
    assert.deepEqual(ids(root), ["n1", "n2", "n40", "n41"]);
    assert.equal(nextId(root), 42);
  });

  test("startId starts the numbering elsewhere", () => {
    const { root } = parse('app\n  screen\n    text "a"', { startId: 50 });
    assert.deepEqual(ids(root), ["n50", "n51", "n52"]);
    assert.equal(nextId(root), 53);
  });

  test("an app line with its own id gives back the number it was holding", () => {
    const { root } = parse('app #relay "Relay"\n  screen "S"');
    assert.deepEqual(ids(root), ["relay", "n1"]);
  });

  test("nextId never hands out a removed id again", () => {
    const { root } = parse(RELAY);
    const r1 = apply(root, "remove", "n18").root;
    assert.equal(find(r1, "n18"), null);
    assert.equal(nextId(r1), 19);
    const r2 = applyPatch(r1, 'in n15:\n  tr "New | row"').root;
    assert.equal(byId(r2, "n19").text, "New | row");
    assert.equal(find(r2, "n18"), null);
    assert.equal(nextId(r2), 20);
  });

  test("nextId survives clear and structuredClone", () => {
    const { root } = parse(RELAY);
    const cleared = apply(root, "clear").root;
    assert.equal(nextId(cleared), 19);
    assert.equal(nextId(structuredClone(cleared)), 19);
  });

  test("a hand-built tree without `next` counts from its largest id", () => {
    const tree = { id: "n1", type: "app", text: null, props: {}, children: [
      { id: "n7", type: "screen", text: "S", props: {}, children: [{ id: "x", type: "text", text: "a", props: {}, children: [] }] },
    ] };
    assert.equal(nextId(tree), 8);
    assert.equal(nextId(null), 1);
    assert.equal(nextId({ id: "top", type: "app", text: null, props: {}, children: [] }), 1);
  });
});

// ---- edges -------------------------------------------------------------------------------

group("edges", () => {
  const graph = (lines) => {
    const { root, warnings } = parse('app\n  screen\n    graph\n      node #a "A"\n      node #b "B"\n' + lines.map((l) => "      " + l).join("\n"));
    return { edges: root.children[0].children[0].children.filter((c) => c.type === "edge"), warnings };
  };

  test("every way of writing the ends", () => {
    const { edges, warnings } = graph(["edge a -> b", "edge #a -> #b", "edge a->b", "edge a → b", "edge #e1 a -> b", "edge #e2 #a -> #b"]);
    assert.deepEqual(warnings, []);
    for (const e of edges) assert.deepEqual([e.props.from, e.props.to], ["a", "b"]);
    assert.deepEqual(edges.map((e) => e.id), ["n4", "n5", "n6", "n7", "e1", "e2"]);
  });

  test("label and flags", () => {
    const { edges } = graph(['edge a -> b "on pass" dashed weight=2']);
    assert.deepEqual(edges[0], { id: "n4", type: "edge", text: "on pass", props: { from: "a", to: "b", dashed: true, weight: 2 }, children: [] });
  });

  test("ends without an arrow are read with a warning", () => {
    const { edges, warnings } = graph(["edge a b dashed"]);
    assert.deepEqual(edges[0].props, { from: "a", to: "b", dashed: true });
    assert.match(warnings[0], /no '->' between the ends/);
  });

  test("an edge missing an end is skipped, and uses no id", () => {
    const { edges, warnings } = graph(["edge a ->", "edge -> b", "edge", "edge a -> b"]);
    assert.deepEqual(edges.map((e) => e.id), ["n4"]);
    assert.equal(warnings.filter((w) => /needs both ends/.test(w)).length, 3);
  });

  test("from= and to= cannot override the arrow", () => {
    const { edges, warnings } = graph(["edge a -> b to=z"]);
    assert.deepEqual(edges[0].props, { from: "a", to: "b" });
    assert.equal(warnings.length, 1);
  });

  test("parse warns about edges that point at no node in their graph", () => {
    const { warnings } = graph(["edge a -> ghost"]);
    assert.deepEqual(warnings, ["edge a -> ghost: no node #ghost in its graph"]);
  });

  test("an edge written before its nodes is fine", () => {
    const { warnings } = parse('app\n  screen\n    graph\n      edge a -> b\n      node #a\n      node #b');
    assert.deepEqual(warnings, []);
  });
});

// ---- Stream ------------------------------------------------------------------------------

group("Stream", () => {
  for (const [name, text] of Object.entries({ RELAY, KITCHEN, CHAT })) {
    test(`builds exactly what parse builds · ${name}`, () => {
      assert.deepEqual(streamed(text).root, parse(text).root);
    });
  }

  test("builds exactly what parse builds on messy input, with the same line warnings", () => {
    const messy = [
      "```", 'row gap=2', '  text "a"', '    text "under leaf"', '  avatar #me "Ed" circle', '   text "odd"',
      'app "Late" phone', '  screen "Two"', "    table", '    tr "a | b"', "    graph", "      edge x y",
      '      screen "Nested"', '  text "direct"', '\ttext "tab"', 'text "x" )))', '    text #me "dup"', "```",
    ].join("\n");
    const s = streamed(messy);
    const p = parse(messy);
    assert.deepEqual(s.root, p.root);
    assert.deepEqual(p.warnings.slice(0, s.warnings.length), s.warnings);
    assert.ok(s.warnings.length > 10);
  });

  test("root is one object from the constructor on, and is renderable after every push", () => {
    const s = new Stream();
    const root = s.root;
    assert.deepEqual(root, { id: "n1", type: "app", text: null, props: {}, children: [], next: 2 });
    for (const line of RELAY.split("\n")) {
      s.push(line);
      assert.equal(s.root, root);
      assert.doesNotThrow(() => serialize(s.root));
      assert.equal(index(s.root)[0].node, root);
    }
    assert.equal(root.text, "Relay");
    assert.equal(index(root).length, 22);
  });

  test("an implicit app is that same object", () => {
    const s = new Stream();
    const root = s.root;
    const r = s.push('screen "Runs"');
    assert.equal(s.root, root);
    assert.equal(root.children[0], r.node);
    assert.match(r.warning, /started an app around it/);
  });

  test("push reports the node it made, or null for lines that make none", () => {
    const s = new Stream();
    assert.equal(s.push('app "A"').node, s.root);
    assert.equal(s.push('  screen "S"').node.type, "screen");
    const t = s.push('    text "x" bold');
    assert.deepEqual([t.node.type, t.node.text, t.warning], ["text", "x", null]);
    assert.deepEqual(s.push(""), { node: null, warning: null });
    assert.deepEqual(s.push("    // note"), { node: null, warning: null });
    const bad = s.push("    edge a");
    assert.equal(bad.node, null);
    assert.match(bad.warning, /^line 6: /);
  });

  test("a pushed line with CRLF, or several lines at once, reads the same", () => {
    const a = new Stream();
    for (const line of RELAY.split("\n")) a.push(line + "\r");
    assert.deepEqual(a.root, parse(RELAY).root);
    const b = new Stream();
    b.push(RELAY);
    assert.deepEqual(b.root, parse(RELAY).root);
  });

  test("warnings are a copy", () => {
    const s = new Stream();
    s.push("row");
    s.warnings.push("tampered");
    assert.equal(s.warnings.length, 2);
  });

  test("startId", () => {
    const s = new Stream({ startId: 30 });
    s.push("app");
    s.push("  screen");
    assert.deepEqual(ids(s.root), ["n30", "n31"]);
  });
});

// ---- serialize ---------------------------------------------------------------------------

group("serialize", () => {
  test("writes every id by default, two spaces a level, one line each", () => {
    const { root } = parse('app "A" phone\n  screen "S"\n    col #c gap=2\n      text "Hi" size=l bold\n    graph\n      node #a "A"\n      node #b "B"\n      edge a -> b "go" dashed');
    assert.equal(serialize(root), [
      'app #n1 "A" phone',
      '  screen #n2 "S"',
      "    col #c gap=2",
      '      text #n3 "Hi" size=l bold',
      "    graph #n4",
      '      node #a "A"',
      '      node #b "B"',
      '      edge #n5 a -> b "go" dashed',
      "",
    ].join("\n"));
  });

  test("ids: false keeps names and ids edges point at, and drops the rest", () => {
    const tree = parse('app\n  screen\n    graph\n      node "A"\n      node "B"\n      edge n4 -> n5').root;
    assert.equal(serialize(tree, { ids: false }), 'app\n  screen\n    graph\n      node #n4 "A"\n      node #n5 "B"\n      edge n4 -> n5\n');
  });

  for (const [name, text] of Object.entries({ RELAY, KITCHEN, CHAT })) {
    test(`round trip, ids included · ${name}`, () => {
      const { root } = parse(text);
      const again = parse(serialize(root));
      assert.deepEqual(again.root, root);
      assert.deepEqual(again.warnings, []);
    });
    test(`round trip, ids left out · ${name}`, () => {
      const { root } = parse(text);
      assert.deepEqual(parse(serialize(root, { ids: false })).root, root);
    });
  }

  test("round trip of a messy outline, once parsed", () => {
    const { root } = parse('row\n  weird thing "x" w=3\n  text "unterminated\ntable\ntr "a"\napp "Late"\n  screen\n    text "a" val="007" s="two words" n=-0.5');
    assert.deepEqual(parse(serialize(root)).root, root);
  });

  test("strings that would read back as something else are quoted", () => {
    const tree = { id: "n1", type: "app", text: null, props: {}, children: [
      { id: "n2", type: "text", text: "x", props: { a: "200", b: "true", c: "two words", d: "", e: "plain", f: "a->b", g: "#fff" }, children: [] },
    ] };
    assert.match(serialize(tree), /a="200" b="true" c="two words" d="" e=plain f=a->b g=#fff/);
    assert.deepEqual(parse(serialize(tree)).root.children[0].children[0].props, tree.children[0].props);
  });

  test("hand-built text with quotes or newlines cannot break the outline", () => {
    const tree = { id: "n1", type: "app", text: 'say "hi"', props: { note: 'a "b"\nc', list: [1, 2, 3], off: false, gone: null }, children: [] };
    assert.equal(serialize(tree), "app #n1 \"say 'hi'\" note=\"a 'b' c\" list=1,2,3 off=false\n");
  });

  test("null gives an empty string", () => {
    assert.equal(serialize(null), "");
  });
});

// ---- index / find / describe -----------------------------------------------------------------

group("index, find, describe", () => {
  const { root } = parse(RELAY + '  screen "Agents"\n    text "Agent list"\n');

  test("index lists every node in document order with its screen, depth and parent", () => {
    const all = index(root);
    assert.equal(all.length, 24);
    assert.deepEqual(all[0], { id: "n1", type: "app", text: "Relay", screen: null, depth: 0, parentId: null, node: root });
    assert.deepEqual({ ...all[1], node: null }, { id: "n2", type: "screen", text: "Runs", screen: "Runs", depth: 1, parentId: "n1", node: null });
    const nav = all.find((e) => e.id === "nav");
    assert.deepEqual([nav.screen, nav.depth, nav.parentId, nav.text], ["Runs", 3, "n3", null]);
    const last = all.at(-1);
    assert.deepEqual([last.type, last.text, last.screen, last.depth], ["text", "Agent list", "Agents", 2]);
    assert.equal(all.find((e) => e.id === "plan").node, root.children[0].children[0].children[1].children[1].children[0]);
  });

  test("index of nothing is empty", () => {
    assert.deepEqual(index(null), []);
  });

  test("find by id, with or without #, gives parent and position", () => {
    const hit = find(root, "#code");
    assert.equal(hit.node.text, "Coder");
    assert.equal(hit.parent.type, "graph");
    assert.equal(hit.index, 1);
    assert.equal(find(root, "code").node, hit.node);
    assert.deepEqual(find(root, "n1"), { node: root, parent: null, index: -1 });
    assert.equal(find(root, "nope"), null);
    assert.equal(find(root, ""), null);
    assert.equal(find(null, "n1"), null);
  });

  test("find falls back to a match that ignores case", () => {
    assert.equal(find(root, "#Nav").node.id, "nav");
  });

  test("describe gives one short line: type, name, words, the props that matter", () => {
    assert.equal(describe(parse('app\n  screen\n    text "Runs" size=l bold').root.children[0].children[0]), 'text "Runs" · l bold');
    assert.equal(describe(byId(root, "nav")), 'col #nav · w=200 fill=light · "Relay · Runs · Agents"');
    assert.equal(describe(byId(root, "n11")), 'button "Stop run" · primary');
    assert.equal(describe(byId(root, "plan")), 'node #plan "Planner" · sub="done · 12s"');
    assert.equal(describe(byId(root, "n14")), 'edge code -> test "on pass"');
    assert.equal(describe(byId(root, "n12")), 'graph · dir=right h=260 · "Planner · Coder · Tester"');
    assert.equal(describe(byId(root, "n9")), 'row · "Run 1482 · Stop run"');
    assert.equal(describe(root), 'app "Relay" · web · "Runs · Agents"');
    assert.equal(describe(byId(root, "n17")), 'tr "Plan tasks | Planner | 1,204 | 12s" · data');
  });

  test("describe truncates long words and says when a container is empty", () => {
    const long = "word ".repeat(30).trim();
    const { root: r } = parse(`app\n  screen\n    row\n    text "${long}"\n    col\n      text "${long}"`);
    const [row, text, col] = r.children[0].children;
    assert.equal(describe(row), "row · empty");
    assert.ok(describe(text).length < 80);
    assert.match(describe(text), /…"$/);
    assert.match(describe(col), /^col · ".{47}…"$/);
  });

  test("describe of nothing is empty", () => {
    assert.equal(describe(null), "");
  });
});

// ---- applyPatch --------------------------------------------------------------------------

group("applyPatch", () => {
  const base = () => parse(RELAY).root;

  test("in: appends the subtree to the container, with fresh ids", () => {
    const root = base();
    const { root: next, notes, warnings } = applyPatch(root, 'in nav:\n  text "Help" shade=mid\n  col\n    text "Docs"');
    assert.deepEqual(warnings, []);
    const nav = byId(next, "nav");
    assert.deepEqual(nav.children.slice(4).map((c) => [c.id, c.type, c.text]), [["n19", "text", "Help"], ["n20", "col", null]]);
    assert.equal(nav.children[5].children[0].id, "n21");
    assert.deepEqual(notes, ['added text "Help", col #n20 in col #nav']);
    assert.equal(nextId(next), 22);
  });

  test("before and after insert siblings, ids with or without #", () => {
    const { root: next, warnings } = applyPatch(base(), 'before #n5:\n  text "First"\nafter n5\n  text "Second"\n  text "Third"');
    assert.deepEqual(warnings, []);
    assert.deepEqual(byId(next, "nav").children.map((c) => c.text), ["Relay", "First", "Runs", "Second", "Third", "Agents", "Settings"]);
  });

  test("replace swaps a node out; one unnamed node takes over the old id", () => {
    const { root: next, notes, warnings } = applyPatch(base(), 'replace code:\n  node "Coder v2" sub="retrying" bold');
    assert.deepEqual(warnings, []);
    const code = byId(next, "code");
    assert.deepEqual([code.text, code.props], ["Coder v2", { sub: "retrying", bold: true }]);
    assert.equal(byId(next, "n12").children.filter((c) => c.type === "edge").length, 2);
    assert.match(notes[0], /^replaced node #code "Coder" with node #code "Coder v2"/);
  });

  test("replace can bring the old names back; names it drops take their edges with them", () => {
    const kept = applyPatch(base(), 'replace nav:\n  col #nav w=240\n    text "Only"').root;
    assert.deepEqual(byId(kept, "nav").props, { w: 240 });
    const renamed = applyPatch(base(), 'replace code:\n  node #coder "Coder"');
    assert.equal(find(renamed.root, "code"), null);
    assert.equal(byId(renamed.root, "n12").children.filter((c) => c.type === "edge").length, 0);
    assert.match(renamed.notes[0], /2 edges to it removed/);
    const several = applyPatch(base(), 'replace n5:\n  text "a"\n  text "b"').root;
    assert.equal(find(several, "n5"), null);
    assert.deepEqual(byId(several, "nav").children.map((c) => c.text), ["Relay", "a", "b", "Agents", "Settings"]);
  });

  test("remove takes the subtree, and a graph node's edges", () => {
    const { root: next, notes } = applyPatch(base(), "remove code\nremove #n15");
    assert.equal(find(next, "code"), null);
    assert.equal(find(next, "n15"), null);
    assert.equal(find(next, "n16"), null);
    assert.deepEqual(byId(next, "n12").children.map((c) => c.id), ["plan", "test"]);
    assert.deepEqual(notes, ['removed node #code "Coder" and 2 edges', "removed table #n15"]);
  });

  test("set changes props and text; key= with no value deletes", () => {
    const { root: next, notes, warnings } = applyPatch(base(), 'set nav w=240 fill= border\nset n5 text="Run history" size=l\nset plan sub="done · 9s"');
    assert.deepEqual(warnings, []);
    assert.deepEqual(byId(next, "nav").props, { w: 240, pad: 3, gap: 2, border: true });
    assert.deepEqual([byId(next, "n5").text, byId(next, "n5").props], ["Run history", { bold: true, size: "l" }]);
    assert.equal(byId(next, "plan").props.sub, "done · 9s");
    assert.deepEqual(notes, [
      "set col #nav: w=240, fill removed, border",
      'set text "Runs": text "Run history", size=l',
      'set node #plan "Planner": sub="done · 9s"',
    ]);
  });

  test("set: text= removes the text, a bare quote sets it, an edge's ends can move", () => {
    const { root: next, warnings } = applyPatch(base(), 'set n5 text=\nset n4 "Relay HQ"\nset n13 to=test dashed');
    assert.deepEqual(warnings, []);
    assert.equal(byId(next, "n5").text, null);
    assert.equal(byId(next, "n4").text, "Relay HQ");
    assert.deepEqual(byId(next, "n13").props, { from: "plan", to: "test", dashed: true });
  });

  test("set refuses id and type, and says when there was nothing to set", () => {
    const { root: next, notes, warnings } = applyPatch(base(), "set n5 id=runs type=button\nset n6\nset n7 missing=");
    assert.deepEqual(next, base());
    assert.deepEqual(notes, []);
    assert.deepEqual(warnings, [
      "line 1: set n5: id cannot be changed with set; use replace",
      "line 1: set n5: type cannot be changed with set; use replace",
      "line 1: set n5: nothing to set; block skipped",
      "line 2: set n6: nothing to set; block skipped",
      "line 3: set n7: missing was not set",
      "line 3: set n7: nothing to set; block skipped",
    ]);
  });

  test("a block naming a missing id is skipped; the others still apply", () => {
    const root = base();
    const { root: next, notes, warnings } = applyPatch(root, 'in ghost:\n  text "x"\nset nav w=300\nremove nowhere\nreplace zip:\n  text "y"\nafter n4:\n  text "z"');
    assert.equal(byId(next, "nav").props.w, 300);
    assert.equal(byId(next, "nav").children[1].text, "z");
    assert.equal(notes.length, 2);
    assert.deepEqual(warnings, [
      "line 1: in ghost: no node 'ghost'; block skipped",
      "line 4: remove nowhere: no node 'nowhere'; block skipped",
      "line 5: replace zip: no node 'zip'; block skipped",
    ]);
    // the skipped block's lines used no ids
    assert.equal(byId(next, "nav").children[1].id, "n19");
  });

  test("a patch that starts with an app line replaces the whole tree, numbering past the old one", () => {
    const root = base();
    const { root: next, notes, warnings } = applyPatch(root, '// rewrite\napp "Relay 2" phone\n  screen "Home"\n    text "Hi"');
    assert.deepEqual(warnings, []);
    assert.equal(next.text, "Relay 2");
    assert.deepEqual(ids(next), ["n19", "n20", "n21"]);
    assert.equal(nextId(next), 22);
    assert.match(notes[0], /^replaced the whole app: app "Relay 2" · phone · "Home"/);
  });

  test("an app patch on no tree at all makes one; any other patch reports there is none", () => {
    assert.equal(applyPatch(null, 'app "New"\n  screen "S"').root.text, "New");
    const none = applyPatch(null, "set n1 w=2");
    assert.equal(none.root, null);
    assert.equal(none.warnings.length, 1);
  });

  test("header forms: into, inside, delete, no colon, a subtree on the header line", () => {
    const { root: next, warnings } = applyPatch(base(), 'into nav: text "One"\ninside #nav\n  text "Two"\ndelete n6\nIN nav:\n  text "Three"');
    assert.deepEqual(warnings, []);
    assert.deepEqual(byId(next, "nav").children.map((c) => c.text), ["Relay", "Runs", "Settings", "One", "Two", "Three"]);
  });

  test("blocks apply in order, so a later block can use a name an earlier one added", () => {
    const { root: next, warnings } = applyPatch(base(), 'after n11:\n  button #retry "Retry"\nset retry ghost');
    assert.deepEqual(warnings, []);
    assert.deepEqual(byId(next, "retry").props, { ghost: true });
  });

  test("a name already in the tree is renamed, except the ones a replace frees", () => {
    const { root: next, warnings } = applyPatch(base(), 'in nav:\n  text #plan "clash"');
    assert.equal(byId(next, "nav").children.at(-1).id, "n19");
    assert.match(warnings[0], /#plan is already taken; this text is #n19/);
  });

  test("a screen aimed inside a screen goes to the app, after that screen", () => {
    const root = applyPatch(base(), 'after n2:\n  screen "Last"').root;
    const { root: next, warnings } = applyPatch(root, 'in nav:\n  screen "Agents"\n    text "Agent list"');
    assert.deepEqual(next.children.map((s) => s.text), ["Runs", "Agents", "Last"]);
    assert.equal(next.children[1].children[0].text, "Agent list");
    assert.match(warnings[0], /a screen sits only in the app; screen "Agents" put after screen "Runs"/);
  });

  test("anything but a screen aimed at the app goes into a screen", () => {
    const { root: next, warnings } = applyPatch(base(), 'in n1:\n  text "footer"\n  screen "New"\nbefore n2:\n  text "header"');
    assert.deepEqual(next.children.map((s) => s.text), ["Runs", "New"]);
    assert.equal(next.children[0].children.at(-1).text, "footer");
    assert.equal(next.children[0].children[0].text, "header");
    assert.equal(warnings.length, 2);
  });

  test("into an empty app, a non-screen gets a new screen called Main", () => {
    const empty = parse('app "A"').root;
    const { root: next } = applyPatch(empty, 'in n1:\n  text "x"');
    assert.deepEqual(index(next).map((e) => [e.type, e.text]), [["app", "A"], ["screen", "Main"], ["text", "x"]]);
  });

  test("a row aimed at the app lands in a screen and is told it belongs in a table", () => {
    const { root: next, warnings } = applyPatch(base(), 'in n1:\n  tr "loose"');
    assert.equal(next.children[0].children.at(-1).type, "tr");
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /tr belongs in a table, not screen "Runs"; kept there/);
  });

  test("in a leaf means after it", () => {
    const { root: next, warnings } = applyPatch(base(), 'in n4:\n  text "after Relay"');
    assert.equal(byId(next, "nav").children[1].text, "after Relay");
    assert.match(warnings[0], /holds nothing; put after it instead/);
  });

  test("before or after the app means inside it", () => {
    const { root: next, warnings } = applyPatch(base(), 'before n1:\n  screen "Zero"\nafter n1:\n  screen "End"');
    assert.deepEqual(next.children.map((s) => s.text), ["Zero", "Runs", "End"]);
    assert.equal(warnings.length, 2);
  });

  test("replace on the app swaps every screen, and takes an app line's name and frame", () => {
    const { root: next, notes, warnings } = applyPatch(base(), 'replace n1:\n  app "Relay" phone\n  screen "Only"');
    assert.deepEqual(warnings, []);
    assert.deepEqual(next.props, { phone: true });
    assert.deepEqual([next.id, next.children.map((s) => s.text)], ["n1", ["Only"]]);
    assert.match(notes[0], /^replaced everything in app "Relay"/);
  });

  test("an app line inside any other block is ignored with a warning", () => {
    const { root: next, warnings } = applyPatch(base(), 'in nav:\n  app "X"\n  text "kept"');
    assert.equal(next.text, "Relay");
    assert.equal(byId(next, "nav").children.at(-1).text, "kept");
    assert.match(warnings[0], /an app line inside a block is ignored/);
  });

  test("a misplaced child is kept where the patch put it, with a warning", () => {
    const { root: next, warnings } = applyPatch(base(), 'in n15:\n  text "note"\nin nav:\n  node "orphan"');
    assert.equal(byId(next, "n15").children.at(-1).text, "note");
    assert.equal(byId(next, "nav").children.at(-1).type, "node");
    assert.equal(warnings.length, 2);
  });

  test("the subtree is read with the same tolerance as an outline", () => {
    const { root: next, warnings } = applyPatch(base(), 'in nav:\n  avatar "me"\n  text "open\n  ```');
    assert.deepEqual(byId(next, "nav").children.slice(4).map((c) => [c.type, c.text]), [["shape", "avatar me"], ["text", "open"]]);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /^line 2: /);
  });

  test("lines before the first block, empty blocks and blocks with no id are reported", () => {
    const { notes, warnings } = applyPatch(base(), 'text "loose"\nin nav:\nremove\nset\nremove n4\n  text "junk"');
    assert.equal(notes.length, 1);
    assert.deepEqual(warnings, [
      "line 1: not under any block header; ignored",
      "line 2: in nav: nothing under it; block skipped",
      "line 3: remove needs an id; block skipped",
      "line 4: set needs an id; block skipped",
      "line 5: remove n4: anything after a remove is ignored",
    ]);
  });

  test("a patch with nothing in it changes nothing and says so", () => {
    const root = base();
    const { root: next, notes, warnings } = applyPatch(root, "");
    assert.deepEqual(next, root);
    assert.notEqual(next, root);
    assert.deepEqual(notes, []);
    assert.equal(warnings.length, 1);
  });

  test("new edges that point nowhere are reported", () => {
    const { warnings } = applyPatch(base(), "in n12:\n  edge test -> deploy");
    assert.deepEqual(warnings, ["edge test -> deploy: no node #deploy in its graph"]);
  });

  test("never touches the tree it was given", () => {
    const root = base();
    const before = snapshot(root);
    const patches = [
      'in nav:\n  text "x"', "remove code", "set nav w=1 fill=", 'replace n1:\n  screen "S"',
      'app "New"', 'before n2:\n  text "t"', 'replace plan:\n  node "P"',
    ];
    for (const p of patches) {
      const { root: next } = applyPatch(root, p);
      assert.notEqual(next, root);
      assert.deepEqual(root, before, p);
    }
  });
});

// ---- apply -------------------------------------------------------------------------------

group("apply", () => {
  const base = () => parse(RELAY + '  screen "Media"\n    shape "hero"\n    shape circle\n    chart values=1,2\n    input "Search" search\n    line\n    progress value=40\n').root;
  const run = (op, id, arg) => apply(base(), op, id, arg);
  const unchanged = (r, pattern) => {
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.match(r.note, pattern);
  };

  test("bigger and smaller step one size along xs…xxl", () => {
    const r = run("bigger", "n4");
    assert.deepEqual([r.ok, r.changed], [true, true]);
    assert.equal(byId(r.root, "n4").props.size, "xl");
    assert.equal(r.note, 'text "Relay" size l → xl');
    assert.equal(byId(run("smaller", "n5").root, "n5").props.size, "s");
    assert.equal(byId(run("bigger", "n11").root, "n11").props.size, "l");
    assert.equal(byId(run("bigger", "n16").root, "n16").props.size, "l");
    assert.equal(byId(run("smaller", "plan").root, "plan").props.size, "s");
    assert.equal(byId(run("bigger", "n23").root, "n23").props.size, "l");
  });

  test("bigger on a container steps every text inside it", () => {
    const r = run("bigger", "nav");
    assert.deepEqual(byId(r.root, "nav").children.map((c) => c.props.size), ["xl", "l", "l", "l"]);
    assert.equal(r.note, "4 texts in col #nav one size bigger");
    const table = run("smaller", "n15");
    assert.deepEqual(byId(table.root, "n15").children.map((c) => c.props.size), ["s", "s", "s"]);
  });

  test("bigger stops at xxl, smaller at xs", () => {
    let root = base();
    for (let i = 0; i < 4; i++) root = apply(root, "bigger", "n10").root;
    unchanged(apply(root, "bigger", "n10"), /already xxl/);
    const tiny = parse('app\n  screen\n    col\n      text "a" size=xs\n      text "b"').root;
    unchanged(apply(tiny, "smaller", "n4"), /already xs/);
    const partly = apply(tiny, "smaller", "n3");
    assert.equal(partly.note, "1 text in col #n3 one size smaller · 1 already xs");
  });

  test("bigger does not apply to a shape, a line or an empty container", () => {
    unchanged(run("bigger", "n21"), /has none \(try wider or taller\)/);
    unchanged(run("bigger", "n24"), /has none/);
    unchanged(run("bigger", "n25"), /has none/);
    unchanged(apply(parse("app\n  screen\n    row").root, "bigger", "n3"), /no text in it/);
  });

  test("bold and regular set and clear bold", () => {
    const r = run("bold", "n6");
    assert.equal(byId(r.root, "n6").props.bold, true);
    assert.equal(r.note, 'text "Agents" → bold');
    const off = run("regular", "n4");
    assert.deepEqual(byId(off.root, "n4").props, { size: "l" });
    unchanged(run("bold", "n4"), /already bold/);
    unchanged(run("regular", "n6"), /already regular/);
    assert.equal(byId(run("bold", "n16").root, "n16").props.bold, true);
    assert.equal(byId(run("regular", "code").root, "code").props.bold, undefined);
  });

  test("bold on a container reaches every text; on a button it explains", () => {
    const r = run("bold", "nav");
    assert.ok(byId(r.root, "nav").children.every((c) => c.props.bold === true));
    assert.equal(r.note, "2 texts in col #nav → bold");
    unchanged(run("bold", "n11"), /a button's weight comes from primary/);
  });

  test("darker and lighter step shade light ↔ mid ↔ dark", () => {
    assert.equal(byId(run("lighter", "n4").root, "n4").props.shade, "mid");
    assert.equal(byId(run("darker", "n6").root, "n6").props.shade, "dark");
    assert.equal(byId(run("darker", "test").root, "test").props.shade, "mid");
    unchanged(run("darker", "n4"), /already the darkest shade \(dark\)/);
    unchanged(run("lighter", "test"), /already the lightest shade \(light\)/);
    assert.equal(byId(run("lighter", "n16").root, "n16").props.shade, "mid");
  });

  test("a shape's shade starts light", () => {
    const r = run("darker", "n20");
    assert.equal(r.note, 'shape "hero" shade light → mid');
    unchanged(run("lighter", "n20"), /lightest/);
  });

  test("on a container, darker and lighter step the fill; lightening past light removes it", () => {
    assert.equal(byId(run("darker", "nav").root, "nav").props.fill, "mid");
    const cleared = run("lighter", "nav");
    assert.equal(byId(cleared.root, "nav").props.fill, undefined);
    assert.equal(cleared.note, "col #nav fill light → none");
    assert.equal(byId(run("darker", "n8").root, "n8").props.fill, "light");
    unchanged(run("lighter", "n8"), /no fill to lighten/);
    const dark = parse("app\n  screen\n    row fill=dark").root;
    unchanged(apply(dark, "darker", "n3"), /darkest fill/);
    unchanged(run("darker", "n11"), /applies to text, node, tr, shape, or a container's fill/);
  });

  test("wider and narrower scale w by 1.25, rounded", () => {
    const r = run("wider", "nav");
    assert.equal(byId(r.root, "nav").props.w, 250);
    assert.equal(r.note, "col #nav w 200 → 250");
    assert.equal(byId(run("narrower", "nav").root, "nav").props.w, 160);
    const odd = parse("app\n  screen\n    col w=99").root;
    assert.equal(byId(apply(odd, "wider", "n3").root, "n3").props.w, 124);
  });

  test("wider on w=fill or on anything unsized explains and changes nothing — sizes are the writer's", () => {
    unchanged(apply(parse("app\n  screen\n    button w=fill").root, "wider", "n3"), /w=fill; it takes the room/);
    unchanged(run("wider", "n8"), /no set width/);
    // An unsized shape is drawn at whatever size the renderer gives it — across a col, say.
    // Guessing that size here is how "wider" once made a stretched image narrower.
    unchanged(run("wider", "n20"), /no set width/);
    unchanged(run("narrower", "n21"), /no set width/);
  });

  test("a px string counts as a width; tiny sizes stop shrinking", () => {
    const t = parse('app\n  screen\n    col w="120px"\n    col w=9').root;
    assert.equal(byId(apply(t, "wider", "n3").root, "n3").props.w, 150);
    unchanged(apply(t, "narrower", "n4"), /already as small as it goes/);
  });

  test("taller and shorter scale a set h; an unsized chart, shape or graph is left to the writer", () => {
    assert.equal(byId(run("taller", "n12").root, "n12").props.h, 325);
    assert.equal(byId(run("shorter", "n12").root, "n12").props.h, 208);
    unchanged(run("taller", "n22"), /no set height/);
    unchanged(run("taller", "n20"), /no set height/);
    unchanged(run("taller", "n3"), /h=fill/);
    unchanged(run("taller", "n11"), /no set height/);
  });

  test("move_earlier and move_later swap with a neighbour", () => {
    const r = run("move_earlier", "n6");
    assert.deepEqual(byId(r.root, "nav").children.map((c) => c.text), ["Relay", "Agents", "Runs", "Settings"]);
    assert.equal(r.note, 'text "Agents" moved up, past text "Runs"');
    const right = run("move_later", "n10");
    assert.deepEqual(byId(right.root, "n9").children.map((c) => c.id), ["n11", "n10"]);
    assert.match(right.note, /moved right/);
    unchanged(run("move_earlier", "n4"), /already first/);
    unchanged(run("move_later", "n7"), /already last/);
  });

  test("screens move among screens", () => {
    const r = run("move_later", "n2");
    assert.deepEqual(r.root.children.map((s) => s.text), ["Media", "Runs"]);
  });

  test("in a graph, a node swaps with the next node over, not with an edge", () => {
    const r = run("move_later", "test");
    unchanged(r, /already last/);
    const back = run("move_earlier", "test");
    assert.deepEqual(byId(back.root, "n12").children.map((c) => c.id), ["plan", "test", "code", "n13", "n14"]);
    unchanged(run("move_earlier", "n13"), /already first/);
    assert.deepEqual(byId(run("move_later", "n13").root, "n12").children.map((c) => c.id), ["plan", "code", "test", "n14", "n13"]);
  });

  test("the app does not move and is not removed", () => {
    unchanged(run("move_later", "n1"), /nothing to move among/);
    unchanged(run("remove", "n1"), /clear empties it/);
  });

  test("remove deletes the subtree; a graph node takes its edges with it", () => {
    const r = run("remove", "code");
    assert.deepEqual(byId(r.root, "n12").children.map((c) => c.id), ["plan", "test"]);
    assert.equal(r.note, 'removed node #code "Coder" and 2 edges');
    const whole = run("remove", "n8");
    assert.equal(find(whole.root, "plan"), null);
    assert.equal(whole.note, "removed col #n8");
    assert.equal(nextId(whole.root), 26);
  });

  test("rename sets the text of anything with a text slot", () => {
    const r = run("rename", "n11", "Cancel run");
    assert.equal(byId(r.root, "n11").text, "Cancel run");
    assert.equal(r.note, 'button "Stop run" → "Cancel run"');
    assert.equal(byId(run("rename", "n21", "Avatar").root, "n21").text, "Avatar");
    assert.equal(byId(run("rename", "n2", "History").root, "n2").text, "History");
    assert.equal(byId(run("rename", "n1", { text: "Relay Pro" }).root, "n1").text, "Relay Pro");
    assert.equal(byId(run("rename", "n4", 'The "best"\nrelay').root, "n4").text, "The 'best' relay");
  });

  test("rename needs words, and a node with a text slot", () => {
    const empty = run("rename", "n4", "  ");
    assert.deepEqual([empty.ok, empty.changed, empty.note], [false, false, "rename needs the new words"]);
    unchanged(run("rename", "nav", "Nav"), /has no text to rename/);
    unchanged(run("rename", "n4", "Relay"), /already says that/);
  });

  test("clear keeps the app's name and frame and drops every screen", () => {
    const root = base();
    const r = apply(root, "clear");
    assert.deepEqual([r.ok, r.changed], [true, true]);
    assert.deepEqual({ ...r.root }, { id: "n1", type: "app", text: "Relay", props: { web: true }, children: [], next: 26 });
    assert.equal(r.note, 'cleared app "Relay": 2 screens gone');
    unchanged(apply(r.root, "clear"), /already empty/);
  });

  test("an unknown op, a missing target or no tree is not ok", () => {
    const root = base();
    for (const [op, id] of [["explode", "n4"], ["bigger", "ghost"], ["bigger", undefined], ["louder", "nav"]]) {
      const r = apply(root, op, id);
      assert.deepEqual([r.ok, r.changed, r.root], [false, false, root], `${op} ${id}`);
    }
    assert.equal(apply(null, "bigger", "n1").ok, false);
  });

  test("ids work with or without #", () => {
    assert.equal(byId(run("bold", "#n6").root, "n6").props.bold, true);
  });

  test("a change returns a new tree and never touches the one given; no change returns it as is", () => {
    const root = base();
    const before = snapshot(root);
    const calls = [
      ["bigger", "nav"], ["smaller", "n4"], ["bold", "nav"], ["regular", "n4"], ["darker", "nav"], ["lighter", "n4"],
      ["wider", "nav"], ["narrower", "nav"], ["taller", "n12"], ["shorter", "n12"], ["move_earlier", "n6"],
      ["move_later", "n2"], ["remove", "code"], ["rename", "n11", "Go"], ["clear"],
    ];
    for (const [op, id, arg] of calls) {
      const r = apply(root, op, id, arg);
      assert.equal(r.changed, true, op);
      assert.notEqual(r.root, root, op);
      assert.deepEqual(root, before, op);
    }
    const still = apply(root, "move_earlier", "n4");
    assert.equal(still.root, root);
    assert.deepEqual(root, before);
  });

  test("edits keep the outline readable: every result round-trips", () => {
    let root = base();
    for (const [op, id, arg] of [["bigger", "nav"], ["darker", "n20"], ["wider", "n21"], ["rename", "n11", "Go now"], ["remove", "test"]]) {
      root = apply(root, op, id, arg).root;
      const again = parse(serialize(root)).root;
      delete again.next;
      const plain = structuredClone(root);
      delete plain.next;
      assert.deepEqual(again, plain, op);
    }
  });
});

// ---- review findings -----------------------------------------------------------------------
//
// Added by an adversarial review against FORMAT.md. Each test pins one defect in tree.mjs and
// fails until it is fixed; the name says what should hold. Nothing above was changed.

group("review · findings", () => {
  test("darker and lighter on a shape step the fill it was written with (FORMAT.md: a shape's shade is `fill`)", () => {
    // The renderer reads a shape's tone as fill first, then shade. A shape written the way
    // FORMAT.md says (fill=dark) must still be able to get lighter, and darker must show.
    const { root } = parse('app\n  screen\n    shape circle w=8 h=8 fill=dark\n    shape "hero" fill=mid');
    const tone = (n) => n.props.fill ?? n.props.shade ?? "light";
    const lighter = apply(root, "lighter", "n3");
    assert.equal(lighter.changed, true, lighter.note);
    assert.equal(tone(byId(lighter.root, "n3")), "mid");
    const darker = apply(root, "darker", "n4");
    assert.equal(tone(byId(darker.root, "n4")), "dark", darker.note);
  });

  test("wider and taller grow a small px size instead of saying it is as large as it goes", () => {
    // The 8 px floor is for shrinking; a 4 px accent bar or a 5 px dot can still grow.
    const { root } = parse("app\n  screen\n    shape w=4 h=4\n    col w=5");
    const wider = apply(root, "wider", "n3");
    assert.equal(wider.changed, true, wider.note);
    assert.equal(byId(wider.root, "n3").props.w, 5);
    assert.equal(byId(apply(root, "taller", "n3").root, "n3").props.h, 5);
    assert.equal(byId(apply(root, "wider", "n4").root, "n4").props.w, 6);
  });

  test("a Mermaid-style --> arrow joins the two ends it names", () => {
    // Today `plan --> code` becomes an edge from "-" with a stray `plan` flag, and the glued
    // form an edge from "plan-"; both point nowhere and the renderer drops them.
    const { root } = parse('app\n  screen\n    graph\n      node #plan "P"\n      node #code "C"\n      edge plan --> code\n      edge plan-->code');
    const edges = root.children[0].children[0].children.filter((c) => c.type === "edge");
    assert.equal(edges.length, 2);
    for (const e of edges) assert.deepEqual(e.props, { from: "plan", to: "code" });
  });

  test("serialize with ids: false reads back with every edge joining the same nodes, after a move", () => {
    // After move_later the unnamed node B comes first; read back, it takes n4, and the edge
    // that joined A to C now joins B to C.
    const { root } = parse('app\n  screen\n    graph\n      node "A"\n      node "B"\n      node "C"\n      edge n4 -> n6');
    const moved = apply(root, "move_later", "n4").root;
    const back = parse(serialize(moved, { ids: false })).root;
    const g = back.children[0].children[0];
    const label = (id) => g.children.find((c) => c.id === id && c.type === "node")?.text;
    const e = g.children.find((c) => c.type === "edge");
    assert.deepEqual([label(e.props.from), label(e.props.to)], ["A", "C"]);
  });

  test("replace on the app never gives a new node the app's own id", () => {
    // FORMAT.md: two nodes never share an id. The root's id is in the freed set, so a screen
    // written as #n1 claims it while the app keeps it too.
    const { root: next } = applyPatch(parse('app "A"\n  screen "S"').root, 'replace n1:\n  screen #n1 "Only"');
    const all = ids(next);
    assert.equal(new Set(all).size, all.length, `ids: ${all.join(", ")}`);
  });

  test("set cannot strip an edge's end, so the edge survives being written back out", () => {
    // `set <edge> to=` deletes the prop; serialize then writes `edge #n4 a -> ` and parse
    // skips that line, so the edge is gone from every tree built from the outline.
    const { root } = parse("app\n  screen\n    graph\n      node #a\n      node #b\n      edge a -> b");
    const { root: next } = applyPatch(root, "set n4 to=");
    const edge = byId(next, "n4");
    assert.deepEqual([edge.props.from, edge.props.to], ["a", "b"]);
    assert.ok(byId(parse(serialize(next)).root, "n4"), "the edge is lost after serialize → parse");
  });

  test("tr rows and graph nodes written at their container's level in a patch go into it, as parse does", () => {
    // parse() moves a tr written at its table's indent into the table; a patch block with the
    // same lines leaves an empty table and loose rows beside it.
    const { root: next } = applyPatch(parse(RELAY).root, 'in n8:\n  table\n  tr "a | b"\n  tr "1 | 2"');
    const table = byId(next, "n19");
    assert.equal(table.type, "table");
    assert.deepEqual(table.children.map((c) => c.text), ["a | b", "1 | 2"]);
    const { root: g } = applyPatch(parse(RELAY).root, 'after n12:\n  graph\n  node #x "X"\n  node #y "Y"\n  edge x -> y');
    assert.deepEqual(byId(g, "n19").children.map((c) => c.type), ["node", "node", "edge"]);
  });

  test("a body line that starts with a header word is not a header (FORMAT.md: headers sit at indent 0)", () => {
    // `  delete-icon` is read as `delete -icon`, the block is cut there, and text "b" is lost.
    const { root: next } = applyPatch(parse(RELAY).root, 'in nav:\n  text "a"\n  delete-icon\n  text "b"');
    assert.deepEqual(byId(next, "nav").children.slice(4).map((c) => [c.type, c.text]), [["text", "a"], ["shape", "delete-icon"], ["text", "b"]]);
  });

  test("a replaced node's warning names the id it ends up with", () => {
    // `#plan is already taken; this node is #n19`, but the one-for-one takeover then makes it
    // #code, so the writer is told an id that does not exist.
    const { root: next, warnings } = applyPatch(parse(RELAY).root, 'replace code:\n  node #plan "Other"');
    for (const w of warnings) {
      const m = /this node is #(\S+)$/.exec(w);
      if (m) assert.ok(find(next, m[1]), `${w}, but there is no #${m[1]}`);
    }
  });

  test("Stream warnings carry the same line numbers as parse when lines arrive several at a time", () => {
    const s = new Stream();
    s.push('app\n  screen\n');
    s.push('    avatar "x"');
    assert.deepEqual(s.warnings, parse('app\n  screen\n    avatar "x"').warnings);
  });

  test("a circle's missing height is its width, so taller grows it by a quarter", () => {
    // A circle is round, so the one side the writer set stands for both.
    const { root } = parse("app\n  screen\n    shape circle w=40");
    assert.equal(byId(apply(root, "taller", "n3").root, "n3").props.h, 50);
  });

  test("-0 survives serialize → parse", () => {
    const { root } = parse('app\n  screen\n    text "x" k=-0');
    assert.deepEqual(parse(serialize(root)).root, root);
  });

  test("an automatic-looking id too big for a float does not hang the parser", async () => {
    // Past 2^53, counter + 1 === counter, so alloc() spins on the same taken id forever. Run in
    // a child process: a synchronous loop cannot be timed out from inside the test.
    const { spawnSync } = await import("node:child_process");
    const src = `import { parse } from ${JSON.stringify(new URL("../tree.mjs", import.meta.url).href)};\n` +
      `parse('app\\n  screen\\n    text #n9007199254740993 "a"\\n    text "b"\\n    text "c"');\n`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { timeout: 5000 });
    assert.equal(r.signal, null, "parse did not return within 5 s");
    assert.equal(r.status, 0, String(r.stderr));
  });
});

group("gaps, screenGaps and placeAt — where a new piece can go", () => {
  const app = parse(`app "Split" phone
  screen #home "Home"
    col #main gap=2
      row #head
        text "Split" bold
        shape circle w=32 h=32
      col #card border
        text "You owe"
      table #t
        tr "Who | Amount"
        tr "Maya | $85"
      graph #g
        node #a "A"
  screen "Friends"
    col
      text "Maya"`).root;

  test("every gap is named by what is around it, top and bottom for a col, start and end for a row", () => {
    const g = gaps(app, "home");
    assert.equal(g[0].text, "at the top of the Home screen");
    const between = g.find((x) => x.anchor === "head" && x.position === "after");
    assert.match(between.text, /^in col .* below row #head .* above col #card/);
    const rowEnd = g.find((x) => x.anchor === "head" && x.position === "inside_end");
    assert.match(rowEnd.text, /^at the end \(right end\) of row #head/);
    const rowIn = g.find((x) => x.position === "after" && x.text.includes("right of"));
    assert.ok(rowIn, "gaps inside a row read left and right");
  });

  test("a table's rows are gaps but not walked into; a graph has one gap, inside it", () => {
    const g = gaps(app, "home");
    assert.ok(g.some((x) => x.anchor === "t" && x.position === "inside_end"));
    assert.ok(!g.some((x) => x.anchor === "n7"), "a tr is not a container");
    const inGraph = g.filter((x) => x.anchor === "g");
    assert.deepEqual(inGraph.map((x) => x.position), ["inside_end"]);
    assert.ok(!g.some((x) => x.anchor === "a"), "graph children are not gaps");
  });

  test("gaps of a missing screen are empty; screen gaps sit after each screen", () => {
    assert.deepEqual(gaps(app, "nope"), []);
    const s = screenGaps(app);
    assert.deepEqual(s.map((x) => [x.anchor, x.position]), [["home", "after"], [app.children[1].id, "after"]]);
    assert.match(s[1].text, /after the "Friends" screen \(at the end\)/);
    assert.deepEqual(screenGaps(parse('app "x"').root), [{ anchor: "n1", position: "inside_end", text: "the first screen of the app" }]);
  });

  test("placeAt turns a gap into a patch that lands exactly there", () => {
    const top = applyPatch(app, placeAt(app, "main", "inside_start", 'input "Search" search'));
    assert.equal(find(top.root, "main").node.children[0].type, "input");
    const end = applyPatch(app, placeAt(app, "main", "inside_end", 'text "Total"\ntext "$147"'));
    assert.deepEqual(find(end.root, "main").node.children.slice(-2).map((c) => c.text), ["Total", "$147"]);
    const after = applyPatch(app, placeAt(app, "head", "after", 'line'));
    assert.equal(find(after.root, "main").node.children[1].type, "line");
    const screen = applyPatch(app, placeAt(app, "home", "after", 'screen "Settings"\n  text "Currency"'));
    assert.deepEqual(screen.root.children.map((s) => s.text), ["Home", "Settings", "Friends"]);
    const swap = applyPatch(app, placeAt(app, "card", "replace", 'row border\n  text "You owe"\n  text "$127"'));
    assert.equal(find(swap.root, "main").node.children[1].type, "row");
    assert.equal(placeAt(app, "nope", "after", "text"), null);
    assert.equal(placeAt(app, "main", "after", "   \n"), null);
  });
});

group("shapeOf — what a container is made of, for Jev to read", () => {
  test("three or more of one kind is a list; anything else lists what it holds; leaves have none", () => {
    const { root } = parse(`app
  screen "S"
    col #list
      row
        text "a"
      row
        text "b"
      row
        text "c"
    col #mixed
      text "t"
      row
      button "b"
    table #t
      tr "a | b"
      tr "1 | 2"
      tr "3 | 4"
    row #wide
      text "1"
      text "2"
      text "3"
      text "4"
      text "5"
      button "6"`);
    const at = (id) => shapeOf(find(root, id).node);
    assert.equal(at("list"), "a list of 3 rows");
    assert.equal(at("mixed"), "holds text, row, button");
    assert.equal(at("t"), "a list of 3 table rows");
    assert.equal(at("wide"), "a list of 5 texts");
    assert.equal(shapeOf(find(root, "n5").node), "holds text");
    assert.equal(shapeOf({ type: "text", text: "x", props: {}, children: [] }), "");
  });
});
