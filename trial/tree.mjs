// tree — a mock as a tree of a few nestable primitives: read it, write it, point at it, edit it.
//
//   import { TYPES, parse, Stream, nextId, serialize, index, find, describe, applyPatch, apply } from "./tree.mjs"
//
// FORMAT.md is the contract. The writer model answers in an outline (one node per line,
// indentation is nesting) and code reads that outline exactly, so Jev is never asked to re-read
// what a model wrote. Jev only chooses among apply()'s ops, and each op is one property change
// a person can see.
//
// Three commitments shape this file:
//   - Writer output never throws. A line that misses the grammar still lands somewhere sensible
//     and leaves a warning. A canvas that stops drawing mid-stream is worse than one that draws
//     a shape labelled with the bad line.
//   - Streaming and batch are one code path. parse() is a Stream fed every line, so the tree
//     that gets kept is exactly the one the person watched being built.
//   - Edits never mutate. apply() and applyPatch() hand back a new tree, so every tree the
//     canvas has shown can stay in the undo history untouched.
//
// Ids: `#name` when the writer names a node, otherwise `n1`, `n2`, … in document order. The root
// also carries `next`, the next automatic number. Because of it, an id freed by a removal is
// never handed out again: a stale reference in Jev's state or in the undo history can go
// missing, but it can never point at the wrong node.

// ---- vocabulary --------------------------------------------------------------------------

// `parents` lists where a type may sit; a type without it sits in any container. app's list is
// empty because it is only ever the root.
export const TYPES = Object.freeze({
  app:      Object.freeze({ container: true, parents: Object.freeze([]) }),
  screen:   Object.freeze({ container: true, parents: Object.freeze(["app"]) }),
  row:      Object.freeze({ container: true }),
  col:      Object.freeze({ container: true }),
  grid:     Object.freeze({ container: true }),
  table:    Object.freeze({ container: true }),
  graph:    Object.freeze({ container: true }),
  text:     Object.freeze({ container: false }),
  button:   Object.freeze({ container: false }),
  input:    Object.freeze({ container: false }),
  shape:    Object.freeze({ container: false }),
  line:     Object.freeze({ container: false }),
  progress: Object.freeze({ container: false }),
  chart:    Object.freeze({ container: false }),
  tr:       Object.freeze({ container: false, parents: Object.freeze(["table"]) }),
  node:     Object.freeze({ container: false, parents: Object.freeze(["graph"]) }),
  edge:     Object.freeze({ container: false, parents: Object.freeze(["graph"]) }),
});

// The other side of `parents`: containers that only hold certain children.
const CHILDREN = new Map([["app", ["screen"]], ["table", ["tr"]], ["graph", ["node", "edge"]]]);

// Types with a text slot (rename works on these even while the slot is empty).
const TEXTED = new Set(["app", "screen", "text", "button", "input", "shape", "progress", "chart", "tr", "node", "edge"]);
// What each apply op reaches, straight on or through a container.
const SIZED = new Set(["text", "button", "node", "tr", "input"]);
const WEIGHTED = new Set(["text", "node", "tr"]);
const SHADED = new Set(["text", "node", "tr", "shape"]);

const SIZES = ["xs", "s", "m", "l", "xl", "xxl"];
const SHADES = ["light", "mid", "dark"];
const FILLS = ["none", "light", "mid", "dark"];

// What survives from an unknown-type line besides its label: the props that change how a
// stand-in shape is drawn. Everything else stays in the label, where a person can read it.
const SHAPE_FLAGS = new Set(["circle", "pill", "grow"]);

const FRAGMENT = "#fragment";
const AUTO = /^n(\d+)$/;
const NUM = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const WORD = /^[A-Za-z_][\w-]*$/;
const KV = /^([A-Za-z_][\w-]*)=(.*)$/;
const ARROW = /(-+>|→)/;
const LINES = /\r\n|\r|\n/;

// Automatic numbers stay far inside a float's exact integers. An id like #n9007199254740993 is
// still kept as a name, but counting on from it would reach the point where n + 1 === n, and
// alloc() would spin on one taken id forever.
const MAX_AUTO = 2 ** 52;
function autoNumber(id) {
  const m = AUTO.exec(String(id ?? ""));
  if (!m) return null;
  const k = Number(m[1]);
  return k < MAX_AUTO ? k : null;
}

const isType = (t) => typeof t === "string" && Object.hasOwn(TYPES, t);
const isContainer = (n) => !!n && (n.type === FRAGMENT || (isType(n.type) && TYPES[n.type].container));
const cleanId = (s) => String(s ?? "").replace(/^#+/, "").replace(/[^\w-]/g, "");
// Text never holds a double quote (the grammar has no escape), so one arriving by rename or
// set becomes a single quote instead of breaking the outline it is written back into.
const clean = (s) => String(s).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function scalar(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (NUM.test(v)) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

// ---- walking -----------------------------------------------------------------------------

function walk(n, fn, parent = null, depth = 0) {
  fn(n, parent, depth);
  for (const c of n.children ?? []) walk(c, fn, n, depth + 1);
}

function idsIn(n) {
  const ids = new Set();
  walk(n, (x) => { if (x.id != null) ids.add(x.id); });
  return ids;
}

function descendants(n) {
  const out = [];
  walk(n, (x) => { if (x !== n) out.push(x); });
  return out;
}

function contains(a, b) {
  let hit = false;
  walk(a, (x) => { if (x === b) hit = true; });
  return hit;
}

// A short name for a node in notes and warnings: its explicit id when it has one, its words when
// it has them, and its automatic id only when there is nothing else to tell it apart by.
function who(n) {
  if (!n) return "nothing";
  if (n.type === FRAGMENT) return "the top of the block";
  const p = n.props ?? {};
  if (n.type === "edge") return `edge ${p.from ?? "?"} -> ${p.to ?? "?"}`;
  const named = n.id != null && !AUTO.test(n.id);
  const words = n.text != null && n.text !== "";
  let s = n.type;
  if (named || (!words && n.id != null)) s += ` #${n.id}`;
  if (words) s += ` "${clip(String(n.text), 32)}"`;
  return s;
}

const list = (nodes) =>
  nodes.slice(0, 3).map(who).join(", ") + (nodes.length > 3 ? ` +${nodes.length - 3} more` : "");

// Edges are graph children that point at node ids. When those ids go, the edges go with them,
// both for remove and for a replace that does not bring the id back.
function dropEdges(root, ids) {
  if (!ids.size) return 0;
  let dropped = 0;
  walk(root, (n) => {
    if (!Array.isArray(n.children)) return;
    const kept = n.children.filter((c) => !(c.type === "edge" && (ids.has(c.props?.from) || ids.has(c.props?.to))));
    dropped += n.children.length - kept.length;
    n.children = kept;
  });
  return dropped;
}

// Edges whose ends are not nodes in their own graph. The renderer skips them; these warnings are
// how the writer finds out.
function dangling(root) {
  const out = [];
  walk(root, (g) => {
    if (g.type !== "graph") return;
    const nodes = new Set(g.children.filter((c) => c.type === "node").map((c) => c.id));
    for (const e of g.children) {
      if (e.type !== "edge") continue;
      for (const end of [e.props.from, e.props.to]) {
        if (!nodes.has(end)) out.push(`edge ${e.props.from} -> ${e.props.to}: no node #${end} in its graph`);
      }
    }
  });
  return out;
}

// ---- one line ----------------------------------------------------------------------------

// Tokens: quoted text, key=value (bare or quoted), #id, the edge arrow, bare words (flags), and
// junk, which is anything else. Junk is reported rather than guessed at.
function tokenize(s) {
  const toks = [];
  const warns = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) {
        warns.push("a quote is never closed; read to the end of the line");
        toks.push({ kind: "quoted", value: s.slice(i + 1), raw: s.slice(i) });
        break;
      }
      toks.push({ kind: "quoted", value: s.slice(i + 1, j), raw: s.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '"') j++;
    const raw = s.slice(i, j);
    if (raw.startsWith("//")) { toks.push({ kind: "comment", raw: s.slice(i) }); break; }
    const kv = KV.exec(raw);
    if (kv && kv[2] === "" && s[j] === '"') {
      const k = s.indexOf('"', j + 1);
      if (k < 0) warns.push(`${kv[1]}="… is never closed; read to the end of the line`);
      toks.push({
        kind: "kv", key: kv[1].toLowerCase(), value: k < 0 ? s.slice(j + 1) : s.slice(j + 1, k),
        empty: false, raw: k < 0 ? s.slice(i) : s.slice(i, k + 1),
      });
      i = k < 0 ? s.length : k + 1;
      continue;
    }
    i = j;
    if (kv) {
      toks.push({ kind: "kv", key: kv[1].toLowerCase(), value: scalar(kv[2]), empty: kv[2] === "", raw });
      continue;
    }
    // Arrows arrive glued to their ends as often as not: plan->code. Writers raised on Mermaid
    // write plan --> code, so any run of dashes before the '>' is one arrow; split any shorter,
    // the spare dashes would become an end named "-" or "plan-" that points nowhere.
    for (const part of raw.split(ARROW).filter(Boolean)) toks.push(classify(part));
  }
  // `size = l`: a lone "=" between a word and a value is one key=value.
  for (let k = 2; k < toks.length - 1; k++) {
    if (toks[k].raw !== "=" || toks[k - 1].kind !== "word") continue;
    const v = toks[k + 1];
    if (v.kind === "comment" || v.kind === "arrow") continue;
    const key = toks[k - 1].value.toLowerCase();
    const value = v.kind === "quoted" ? v.value : scalar(v.raw);
    toks.splice(k - 1, 3, { kind: "kv", key, value, empty: false, raw: `${toks[k - 1].raw}=${v.raw}` });
  }
  return { toks, warns };
}

function classify(raw) {
  if (/^(-+>|→)$/.test(raw)) return { kind: "arrow", raw };
  if (raw.startsWith("#")) return { kind: "id", value: cleanId(raw), raw };
  if (WORD.test(raw)) return { kind: "word", value: raw, raw };
  return { kind: "junk", raw };
}

function ignored(t) {
  if (t.kind === "comment") return "trailing comment dropped";
  if (t.kind === "arrow") return `'${t.raw}' only means something on an edge line; ignored`;
  return `'${t.raw}' ignored`;
}

// A line's content (indentation already measured) → { node, explicit id } or null when the line
// cannot become a node at all. Only an edge missing an end gets that far.
function build(content, w) {
  const { toks, warns } = tokenize(content);
  w.push(...warns);
  const head = toks[0];
  let type = null;
  if (head?.kind === "word") type = head.value.toLowerCase();
  else if (head?.kind === "junk" && /^[A-Za-z_][\w-]*:$/.test(head.raw)) type = head.raw.slice(0, -1).toLowerCase();
  if (type === "edge") return buildEdge(toks.slice(1), w);
  if (!isType(type)) return buildUnknown(toks, w);

  const node = { id: null, type, text: null, props: {}, children: [] };
  let explicit = null;
  for (const t of toks.slice(1)) {
    if (t.kind === "id") {
      if (!t.value) w.push(ignored(t));
      else if (explicit) w.push(`extra id '${t.raw}' ignored`);
      else explicit = t.value;
    } else if (t.kind === "quoted") {
      if (node.text === null) node.text = t.value;
      else w.push(`second quoted text "${t.value}" ignored`);
    } else if (t.kind === "kv") {
      if (t.key === "text") {
        if (node.text === null) node.text = String(t.value);
        else w.push("text= ignored; the line already has its text");
      } else if (t.key === "id") {
        const id = cleanId(t.value);
        if (id && !explicit) explicit = id;
        else w.push(`extra id '${t.raw}' ignored`);
      } else {
        if (Object.hasOwn(node.props, t.key)) w.push(`${t.key} is set twice; the last one wins`);
        node.props[t.key] = t.value;
      }
    } else if (t.kind === "word") {
      const flag = t.value.toLowerCase();
      // `id` and `text` are not props (serialize could not write them back), so as flags they mean nothing.
      if (flag === "id" || flag === "text") w.push(ignored(t));
      else node.props[flag] = true;
    } else {
      w.push(ignored(t));
    }
  }
  return { node, explicit };
}

// FORMAT.md: an unknown type becomes a shape whose label is the line. The label keeps the words
// and the stand-in's own props move onto the shape. An avatar the vocabulary never listed still
// shows up where it was meant to be, saying what it was meant to be.
function buildUnknown(toks, w) {
  const node = { id: null, type: "shape", text: null, props: {}, children: [] };
  let explicit = null;
  const label = [];
  toks.forEach((t, i) => {
    if (i > 0 && t.kind === "id" && t.value && !explicit) explicit = t.value;
    else if (i > 0 && t.kind === "word" && SHAPE_FLAGS.has(t.value.toLowerCase())) node.props[t.value.toLowerCase()] = true;
    else if (i > 0 && t.kind === "kv" && (t.key === "w" || t.key === "h") && !t.empty) node.props[t.key] = t.value;
    else label.push(t.kind === "quoted" ? t.value : t.raw);
  });
  node.text = label.join(" ").replace(/"/g, "").replace(/\s+/g, " ").trim() || null;
  w.push(`unknown type '${toks[0]?.raw ?? ""}'; drawn as a shape labelled with the line`);
  return { node, explicit };
}

// edge [#id] <from> -> <to> ["label"] [flag]…. The ends are node ids, written with or without
// '#'. When a '#' token and a bare one both come before the arrow, the first is the edge's own
// id, which is how serialize writes an edge back out.
function buildEdge(toks, w) {
  const node = { id: null, type: "edge", text: null, props: {}, children: [] };
  const isEnd = (t) => !!t && (t.kind === "id" || t.kind === "word" || t.kind === "junk") && cleanId(t.raw) !== "";
  let explicit = null, from = null, to = null;
  let rest = [];
  const a = toks.findIndex((t) => t.kind === "arrow");
  if (a >= 0) {
    const before = toks.slice(0, a);
    const ends = before.filter(isEnd);
    if (ends.length) from = cleanId(ends[ends.length - 1].raw);
    if (ends.length >= 2 && ends[0].kind === "id") explicit = cleanId(ends[0].raw);
    rest = before.filter((t) => !isEnd(t) || (t !== ends[ends.length - 1] && !(explicit && t === ends[0])));
    const after = toks.slice(a + 1);
    if (isEnd(after[0])) { to = cleanId(after[0].raw); rest = rest.concat(after.slice(1)); }
    else rest = rest.concat(after);
  } else {
    let k = 0;
    if (toks[0]?.kind === "id" && isEnd(toks[1]) && isEnd(toks[2])) { explicit = cleanId(toks[0].raw); k = 1; }
    if (isEnd(toks[k]) && isEnd(toks[k + 1])) {
      from = cleanId(toks[k].raw);
      to = cleanId(toks[k + 1].raw);
      w.push(`no '->' between the ends; read as ${from} -> ${to}`);
      rest = toks.slice(k + 2);
    }
  }
  if (!from || !to) {
    w.push("an edge needs both ends, as in 'edge a -> b'; line skipped");
    return null;
  }
  node.props.from = from;
  node.props.to = to;
  for (const t of rest) {
    if (t.kind === "quoted") {
      if (node.text === null) node.text = t.value;
      else w.push(`second quoted text "${t.value}" ignored`);
    } else if (t.kind === "kv") {
      if (t.key === "from" || t.key === "to" || t.key === "id") w.push(`${t.key}= ignored; an edge's ends come from 'a -> b'`);
      else if (t.key === "text") {
        if (node.text === null) node.text = String(t.value);
        else w.push("text= ignored; the line already has its label");
      } else {
        if (Object.hasOwn(node.props, t.key)) w.push(`${t.key} is set twice; the last one wins`);
        node.props[t.key] = t.value;
      }
    } else if (t.kind === "word" && !["from", "to", "id", "text"].includes(t.value.toLowerCase())) {
      node.props[t.value.toLowerCase()] = true;
    } else if (t.kind === "id" && t.value && !explicit) {
      explicit = t.value;
    } else {
      w.push(ignored(t));
    }
  }
  return { node, explicit };
}

// ---- building a tree a line at a time ------------------------------------------------------

// The one builder behind parse(), Stream and patch blocks. A stack of open lines is kept by
// indentation, as in any outline reader; everything else here is about where a line goes when
// the writer got the structure slightly wrong.
//
// In fragment mode (patch blocks) the root is a placeholder that holds anything: whether a
// subtree fits is decided when it is inserted, because only then is its real parent known.
class Builder {
  constructor({ startId = 1, fragment = false, taken = [] } = {}) {
    this.counter = Number.isInteger(startId) && startId > 0 && startId < MAX_AUTO ? startId : 1;
    this.taken = new Set(taken);
    this.auto = new Set();
    this.warnings = [];
    this.lineNo = 0;
    this.unit = 0;
    this.tabbed = false;
    this.fragment = fragment;
    this.appLine = null;
    this.implicit = false;
    this.adopted = false;
    if (fragment) {
      this.root = { id: null, type: FRAGMENT, text: null, props: {}, children: [] };
      this.started = true;
    } else {
      // The root exists before the first line so that it is one object for the whole stream.
      // Its id is taken now and given back if the first line names the app itself.
      const id = this.alloc();
      this.root = { id, type: "app", text: null, props: {}, children: [], next: this.counter };
      this.started = false;
    }
    this.stack = [{ indent: -1, node: this.root, virtual: true }];
  }

  sync() { if (!this.fragment && this.root) this.root.next = this.counter; }

  alloc() {
    let id;
    do id = `n${this.counter++}`; while (this.taken.has(id));
    this.taken.add(id);
    this.auto.add(id);
    this.sync();
    return id;
  }

  // An explicit id that looks automatic (`#n40`, which is how serialize shows ids to the writer)
  // moves the counter past it, so the next automatic id cannot collide with it.
  claim(explicit, what, w) {
    if (explicit && !this.taken.has(explicit)) {
      this.taken.add(explicit);
      const k = autoNumber(explicit);
      if (k !== null) { this.counter = Math.max(this.counter, k + 1); this.sync(); }
      return explicit;
    }
    const id = this.alloc();
    if (explicit) {
      // The writer did name this node, just with a name already in use. It is not an unnamed
      // node, so a replace does not hand it the replaced node's id: the warning names the id
      // it really ends up with.
      this.auto.delete(id);
      w.push(`#${explicit} is already taken; this ${what} is #${id}`);
    }
    return id;
  }

  push(line, no) {
    const parts = (line == null ? "" : String(line)).split(LINES);
    // A line pushed with its newline is one line: the empty string after the last newline is not
    // a line of its own, and counting it would put every later warning one line off.
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    if (parts.length === 1) return this.one(parts[0], no);
    let node = null;
    const ws = [];
    for (const p of parts) {
      const r = this.one(p);
      if (r.node) node = r.node;
      if (r.warning) ws.push(r.warning);
    }
    return { node, warning: ws.length ? ws.join("; ") : null };
  }

  one(raw, no) {
    this.lineNo = no ?? this.lineNo + 1;
    const w = [];
    const done = (node) => {
      const ws = w.map((x) => `line ${this.lineNo}: ${x}`);
      this.warnings.push(...ws);
      return { node, warning: ws.length ? ws.join("; ") : null };
    };
    const line = raw.replace(/\s+$/, "");
    if (!line) return done(null);
    let indent = 0, k = 0, tab = false;
    for (; k < line.length && /\s/.test(line[k]); k++) {
      if (line[k] === "\t") { indent += 2; tab = true; } else indent += 1;
    }
    const content = line.slice(k);
    if (content.startsWith("//")) return done(null);
    if (content.startsWith("```")) { w.push("code fence ignored"); return done(null); }
    // A tab is one level at the documented width. Said once: a tab-indented outline is
    // consistent with itself, and a warning on every line would bury the ones that matter.
    if (tab && !this.tabbed) { this.tabbed = true; w.push("tabs in the indentation are read as 2 spaces each"); }

    const made = build(content, w);
    if (!made) return done(null);
    const { node, explicit } = made;
    if (node.type === "app") return done(this.app(node, explicit, indent, w));
    if (!this.started) {
      this.started = true;
      this.implicit = true;
      w.push(`no app line before this ${node.type}; started an app around it`);
    }
    const parent = this.parentFor(indent, node, w);
    node.id = this.claim(explicit, node.type, w);
    parent.children.push(node);
    this.stack.push({ indent, node });
    return done(node);
  }

  app(node, explicit, indent, w) {
    const root = this.root;
    if (this.fragment) {
      // Only a replace of the root has a use for it; applyPatch reports it everywhere else.
      this.appLine ??= { text: node.text, props: node.props };
      this.popTo(indent);
      this.stack.push({ indent, node: root });
      return null;
    }
    if (!this.started) {
      this.started = true;
      root.text = node.text;
      root.props = node.props;
      if (explicit) {
        // Give back the id the constructor took; nothing else has been numbered yet.
        this.taken.delete(root.id);
        this.auto.delete(root.id);
        this.counter -= 1;
        this.sync();
        root.id = this.claim(explicit, "app", w);
      }
      this.stack = [{ indent, node: root }];
      return root;
    }
    // A writer that opens with a stray line and then the real app line gets that app's name
    // and frame; any later app line only joins its children to the one app.
    if (this.implicit && root.text == null && !this.adopted) {
      this.adopted = true;
      root.text = node.text;
      Object.assign(root.props, node.props);
      w.push("the app line comes after content; its name and frame now head the app");
    } else {
      w.push("a second app line; what follows joins the first app");
    }
    this.popTo(indent);
    this.stack.push({ indent, node: root });
    return root;
  }

  popTo(indent) {
    while (this.stack.length > 1 && this.stack[this.stack.length - 1].indent >= indent) this.stack.pop();
  }

  parentFor(indent, node, w) {
    const st = this.stack;
    const popped = [];
    while (st.length > 1 && st[st.length - 1].indent >= indent) popped.push(st.pop());
    const top = st[st.length - 1];
    // Indentation is judged against the outline's own step, whatever width the writer chose:
    // a dedent must land on a level that is open, and a step in must match the first one seen.
    if (top.indent >= indent) {
      w.push(`${node.type} sits at or left of the app line; read as inside the app`);
    } else if (popped.length) {
      if (!popped.some((e) => e.indent === indent)) {
        w.push(`indent ${indent} lines up with no line above it; read as inside ${who(top.node)}`);
      }
    } else if (!top.virtual) {
      const step = indent - top.indent;
      if (!this.unit) this.unit = step;
      else if (step !== this.unit) {
        w.push(`indented ${step} past its parent where the outline steps by ${this.unit}; read as inside ${who(top.node)}`);
      }
    }
    // Indented under a leaf: the leaf holds nothing, so the line joins the leaf's container.
    let k = st.length - 1;
    while (k > 0 && !isContainer(st[k].node)) k--;
    const p = st[k].node;
    if (k < st.length - 1) w.push(`${node.type} is indented under ${who(top.node)}, which holds nothing; put in ${who(p)}`);
    return this.fit(p, node, w);
  }

  // Where a node goes, given the container its indentation points at. Two structural rules move
  // it, because the renderer draws screens and nothing else at the top: a screen goes to the
  // app, and anything else placed straight in the app goes into a screen. A tr, node or edge
  // just below its table or graph goes into it, which is the usual way a writer drops a level.
  // Every other misplacement stays where it was written, with a warning, as FORMAT.md says.
  fit(p, node, w) {
    const t = node.type;
    if (p.type === FRAGMENT) {
      // The top of a patch block holds anything, since its real parent is only known when it is
      // inserted. The dropped-level rule still applies here: it depends only on the line above,
      // and the same lines must build the same subtree as an outline or as a patch.
      const need = TYPES[t]?.parents;
      const last = p.children[p.children.length - 1];
      if (need && last && need.includes(last.type)) {
        w.push(`${t} is outside its ${last.type}; put in ${who(last)} just above it`);
        return last;
      }
      return p;
    }
    if (t === "screen" && p.type !== "app") {
      w.push(`a screen inside ${who(p)}; moved up to ${this.fragment ? "the top of the block" : "the app"}`);
      return this.root;
    }
    if (p.type === "app") {
      if (t === "screen") return p;
      let s = p.children[p.children.length - 1];
      if (s?.type === "screen") {
        w.push(`${t} sits directly in the app; put in ${who(s)}`);
      } else {
        s = { id: this.alloc(), type: "screen", text: "Main", props: {}, children: [] };
        p.children.push(s);
        w.push(`${t} sits directly in the app; put in a new screen "Main"`);
      }
      // The screen gets the same checks as any other parent. A tr that lands here must still
      // find the table just above it, or the outline written back out would read differently.
      p = s;
    }
    const need = TYPES[t]?.parents;
    if (need && !need.includes(p.type)) {
      const last = p.children[p.children.length - 1];
      if (last && need.includes(last.type)) {
        w.push(`${t} is outside its ${last.type}; put in ${who(last)} just above it`);
        return last;
      }
      w.push(`${t} belongs in a ${need.join(" or ")}, not ${who(p)}; kept there`);
      return p;
    }
    const allow = CHILDREN.get(p.type);
    if (allow && !allow.includes(t)) w.push(`${who(p)} holds ${allow.join(" and ")}; this ${t} is kept there but may not draw`);
    return p;
  }
}

// ---- reading -----------------------------------------------------------------------------

export function parse(text, { startId = 1 } = {}) {
  const b = new Builder({ startId });
  for (const line of String(text ?? "").split(LINES)) b.push(line);
  const warnings = b.warnings.slice();
  if (!b.started) warnings.push("the outline is empty; an app with no screens");
  // Only a whole document can say an edge points nowhere: while streaming, the node may
  // simply not have arrived yet. This is the one way parse() says more than a Stream.
  warnings.push(...dangling(b.root));
  return { root: b.root, warnings };
}

// The writer streams; the canvas redraws after every line. `root` is the same object from the
// constructor on, and push() only ever adds to it, so a render between pushes is always of a
// whole, if partial, tree.
export class Stream {
  #b;
  constructor({ startId = 1 } = {}) { this.#b = new Builder({ startId }); }
  push(line) { return this.#b.push(line); }
  get root() { return this.#b.root; }
  get warnings() { return this.#b.warnings.slice(); }
}

export function nextId(root) {
  let max = 0;
  if (root) {
    walk(root, (n) => {
      const k = autoNumber(n.id);
      if (k !== null) max = Math.max(max, k);
    });
  }
  const kept = Number.isInteger(root?.next) && root.next < MAX_AUTO ? root.next : 0;
  return Math.max(max + 1, kept);
}

// ---- writing -----------------------------------------------------------------------------

// ids: true writes every id, and it is what the writer is shown before a patch. ids: false is
// the clean outline for people: it drops automatic ids but keeps the ones a line needs, meaning
// the writer's own names and any automatic id an edge points at.
export function serialize(root, { ids = true } = {}) {
  if (!root) return "";
  const shown = ids ? null : needed(root);
  const out = [];
  walk(root, (n, _p, depth) => {
    const showId = n.id != null && (ids || shown.has(n));
    out.push("  ".repeat(depth) + outlineLine(n, showId));
  });
  return out.join("\n") + "\n";
}

// The nodes whose ids an outline without ids still has to write. Read back, an unnamed node is
// numbered afresh in document order, and after a move or a patch that fresh number can be one a
// later line names: B moved above A takes A's n4, A is renamed, and the edge from n4 now leaves
// B. So the reading is played through here first, and an unnamed node that would take a number
// some line needs keeps its own id instead, until no line loses its id. Each pass keeps at least
// one more id, so it ends; at worst every id is written, as with ids: true.
function needed(root) {
  const refs = new Set();
  walk(root, (n) => { if (n.type === "edge") { refs.add(n.props?.from); refs.add(n.props?.to); } });
  const shown = new Set();
  walk(root, (n) => { if (n.id != null && (!AUTO.test(n.id) || refs.has(n.id))) shown.add(n); });
  for (;;) {
    const taken = new Map();
    const late = new Set();
    let counter = 1;
    walk(root, (n) => {
      // parse() skips an edge missing an end without numbering it.
      if (n.type === "edge" && !(cleanId(n.props?.from) && cleanId(n.props?.to))) return;
      if (!shown.has(n)) {
        let id;
        do id = `n${counter++}`; while (taken.has(id));
        taken.set(id, n);
        return;
      }
      const had = taken.get(n.id);
      if (!had) {
        taken.set(n.id, n);
        const k = autoNumber(n.id);
        if (k !== null) counter = Math.max(counter, k + 1);
      } else if (!shown.has(had) && had.id != null) {
        late.add(had);
      }
    });
    if (!late.size) return shown;
    for (const n of late) shown.add(n);
  }
}

function outlineLine(n, showId) {
  const p = n.props ?? {};
  const parts = [n.type];
  if (showId) parts.push(`#${n.id}`);
  if (n.type === "edge") parts.push(`${p.from ?? ""} -> ${p.to ?? ""}`);
  if (n.text != null) parts.push(`"${clean(n.text)}"`);
  for (const [k, v] of Object.entries(p)) {
    if (n.type === "edge" && (k === "from" || k === "to")) continue;
    if (k === "id" || k === "text" || !WORD.test(k)) continue;
    const s = propText(k, v);
    if (s) parts.push(s);
  }
  return parts.join(" ");
}

// A string is written bare only when reading it back gives the same string: no spaces, no
// quotes, and nothing that would come back as a number or a boolean.
function propText(k, v) {
  if (v === true) return k;
  if (v === false) return `${k}=false`;
  // String(-0) is "0"; written that way, parse would hand back a different number.
  if (typeof v === "number") return Number.isFinite(v) ? `${k}=${Object.is(v, -0) ? "-0" : v}` : null;
  if (Array.isArray(v)) v = v.join(",");
  if (typeof v !== "string") return null;
  const bare = /^[^\s"]+$/.test(v) && !NUM.test(v) && v !== "true" && v !== "false";
  return bare ? `${k}=${v}` : `${k}="${clean(v)}"`;
}

// ---- pointing ----------------------------------------------------------------------------

export function index(root) {
  const out = [];
  if (!root) return out;
  const visit = (n, parent, depth, screen) => {
    const here = n.type === "screen" ? n.text ?? null : screen;
    out.push({ id: n.id, type: n.type, text: n.text ?? null, screen: parent ? here : null, depth, parentId: parent?.id ?? null, node: n });
    for (const c of n.children ?? []) visit(c, n, depth + 1, here);
  };
  visit(root, null, 0, null);
  return out;
}

// By id, with or without '#'. An exact match wins; failing that, a match that ignores case,
// because a writer that says `#Nav` for `#nav` has told us which node it means.
export function find(root, id) {
  if (!root || id == null) return null;
  const want = cleanId(id);
  if (!want) return null;
  const low = want.toLowerCase();
  let hit = null, loose = null;
  const visit = (n, parent, i) => {
    if (hit) return;
    if (n.id === want) { hit = { node: n, parent, index: i }; return; }
    if (!loose && typeof n.id === "string" && n.id.toLowerCase() === low) loose = { node: n, parent, index: i };
    (n.children ?? []).forEach((c, j) => visit(c, n, j));
  };
  visit(root, null, -1);
  return hit ?? loose;
}

// Spacing and alignment are left out: they are real, but they are not what a person names a
// node by, and the line is for naming.
const QUIET = new Set(["pad", "gap", "align", "justify"]);

export function describe(node) {
  if (!node || typeof node !== "object") return "";
  const p = node.props ?? {};
  let head = String(node.type);
  if (node.id != null && !AUTO.test(node.id)) head += ` #${node.id}`;
  if (node.type === "edge") head += ` ${p.from ?? "?"} -> ${p.to ?? "?"}`;
  if (node.text != null && node.text !== "") head += ` "${clip(String(node.text), 60)}"`;
  const parts = [head];
  const shown = [];
  for (const [k, v] of Object.entries(p)) {
    if (QUIET.has(k) || v == null || v === false) continue;
    if (node.type === "edge" && (k === "from" || k === "to")) continue;
    if (v === true) shown.push(k);
    else if (k === "size") shown.push(String(v));
    else {
      const s = clip(String(v), 24);
      shown.push(/\s/.test(s) ? `${k}="${s}"` : `${k}=${s}`);
    }
  }
  if (shown.length) parts.push(shown.join(" "));
  if (isContainer(node)) {
    const kids = node.children ?? [];
    if (!kids.length) parts.push("empty");
    else {
      // An app is summed up by its screens; anything else by the words inside it.
      const texts = node.type === "app"
        ? kids.filter((c) => c.type === "screen").map((c) => c.text)
        : descendants(node).filter((d) => d.type !== "edge").map((d) => d.text);
      const words = texts.filter((t) => t != null && t !== "").slice(0, 3).map(String);
      if (words.length) parts.push(`"${clip(words.join(" · "), 48)}"`);
    }
  }
  return parts.join(" · ");
}

// What a container is made of, in shape words: "a list of 5 rows", "holds text, row". This is a
// count, not a judgement — Jev reads it beside describe() when it decides what "the list" or "the
// cards" means. Measured 2026-09-23: "turn the main list into a table" across ten apps, Jev's
// confident picks went from 0/10 to 5/10 with it, and the picks became the containers of rows.
const SHAPED = new Set(["screen", "row", "col", "grid", "table", "graph"]);
export function shapeOf(node) {
  if (!node || !SHAPED.has(node.type) || !node.children?.length) return "";
  const kids = node.children;
  const counts = {};
  for (const k of kids) counts[k.type] = (counts[k.type] ?? 0) + 1;
  const [top, c] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (c >= 3 && c >= kids.length - 1) return `a list of ${c} ${top === "tr" ? "table rows" : top + "s"}`;
  const types = kids.slice(0, 5).map((k) => k.type).join(", ");
  return `holds ${types}${kids.length > 5 ? ", …" : ""}`;
}

// Where a node sits among its siblings, in words for what a person sees: "item 2 of a list of 4
// texts", "at the left, narrow", "at the top of the screen". Structure only, like shapeOf — which
// of these is "the navigation" or "the title" is Jev's to say. It is what told a side nav's items
// from a heading, and the nav from "the main list", when Jev chose among them (jev.mjs `which`).
export function positionOf(root, id) {
  const h = find(root, id);
  if (!h?.parent) return "";
  const kids = h.parent.children;
  const ps = shapeOf(h.parent);
  if (/^a list of/.test(ps)) return `item ${h.index + 1} of ${ps}`;
  if (kids.length < 2) return "";
  const end = h.index === 0 ? 0 : h.index === kids.length - 1 ? 2 : 1;
  if (h.parent.type === "row") {
    const p = h.node.props ?? {};
    const fills = (q) => q?.grow || q?.w === "fill";
    const size = fills(p) ? ", wide" : px(p.w) && kids.some((c) => fills(c.props)) ? ", narrow" : "";
    return ["at the left", "in the middle", "at the right"][end] + size;
  }
  if (h.parent.type === "screen") return ["at the top of the screen", "", "at the bottom of the screen"][end];
  return "";
}

// ---- gaps --------------------------------------------------------------------------------

// Where a new piece can go on one screen, as places a person would name them: the top of a
// column, the end of a row, between two things. Jev chooses among these. Measured 2026-09-23 on a
// two-screen phone app: a flat choice over its 88 elements plus a position placed 2-3 of 6 pieces
// where they belong; a choice over the gaps on the screen the sentence names placed 6-7 of 7, and
// the doubtful ones came back with low confidence.
const GAP_CONTAINERS = new Set(["screen", "row", "col", "grid", "table"]);

export function gaps(root, screenId) {
  const screen = find(root, screenId)?.node;
  if (!screen) return [];
  const out = [];
  const walk = (c) => {
    // A graph's children are laid out by the renderer, not by order, so it has one gap: in it.
    if (c.type === "graph") {
      out.push({ anchor: c.id, position: "inside_end", text: `inside ${describe(c)}, as a new node or edge` });
      return;
    }
    if (!GAP_CONTAINERS.has(c.type)) return;
    const across = c.type === "row";
    const kids = c.children ?? [];
    const where = c.type === "screen" ? `the ${c.text ?? ""} screen` : describe(c);
    out.push({ anchor: c.id, position: "inside_start", text: `at the ${across ? "start (left end)" : "top"} of ${where}` });
    for (let i = 0; i < kids.length - 1; i++) {
      out.push({ anchor: kids[i].id, position: "after",
        text: `in ${where}, ${across ? "right of" : "below"} ${describe(kids[i])}, ${across ? "left of" : "above"} ${describe(kids[i + 1])}` });
    }
    if (kids.length) out.push({ anchor: c.id, position: "inside_end", text: `at the ${across ? "end (right end)" : "bottom"} of ${where}` });
    if (c.type !== "table") kids.forEach(walk);
  };
  walk(screen);
  return out;
}

// ---- shared elements ---------------------------------------------------------------------
// What a person sees on every screen — the side nav, a top bar, a tab bar — is one element drawn
// on each. Each copy carries the same `share=<name>`, and an edit to a copy, or to anything in
// one, is made to every copy: a node's copies are the nodes at the same place inside the other
// copies, where they are of the same type (the copies may differ in which item is current, or one
// may have an item more). Before this, each screen had its own nav, "make the navigation darker"
// darkened one of three, and "the title" was one of several identical texts to choose between.

const shareOf = (n) => (n?.props?.share != null && n.type !== "app" && n.type !== "screen" ? String(n.props.share) : null);

// The copies of every shared element, in document order: Map name → [copy roots].
export function shares(root) {
  const out = new Map();
  for (const { node } of index(root)) {
    const k = shareOf(node);
    if (k != null) out.set(k, [...(out.get(k) ?? []), node]);
  }
  return out;
}

// The nodes that are `id` on the other screens: [{ id, copy }] with `copy` the id of the copy root
// each is in. Empty for a node in no shared element.
export function copiesOf(root, id) {
  let h = find(root, id);
  if (!h) return [];
  const path = [];
  while (shareOf(h.node) == null) {
    if (!h.parent) return [];
    path.unshift(h.index);
    h = find(root, h.parent.id);
  }
  const type = find(root, id).node.type;
  const out = [];
  for (const other of shares(root).get(shareOf(h.node)) ?? []) {
    if (other === h.node) continue;
    let t = other;
    for (const i of path) { t = t?.children?.[i]; if (!t) break; }
    if (t && t.type === type) out.push({ id: t.id, copy: other.id });
  }
  return out;
}

// The copy of `id` that stands for all of them — the one in the first copy — so that each shared
// element is offered once. Itself when it is in no shared element, or is in the first copy.
export function firstCopy(root, id) {
  const order = index(root).map((n) => n.id);
  return [id, ...copiesOf(root, id).map((c) => c.id)].sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
}

// How the tree is shown to Jev: each shared element once. `hidden` holds every node inside a copy
// after the first; `screens` gives each node in a first copy the screens all its copies are on.
export function sharedView(root) {
  const hidden = new Set(), screens = new Map();
  const at = new Map(index(root).map((n) => [n.id, n.screen]));
  for (const copies of shares(root).values()) {
    if (copies.length < 2) continue;
    const on = [...new Set(copies.map((c) => at.get(c.id)).filter(Boolean))];
    for (const n of index(copies[0])) screens.set(n.id, on);
    for (const c of copies.slice(1)) for (const n of index(c)) hidden.add(n.id);
  }
  return { hidden, screens };
}

// Where else a change at a place must be made: the same place in every other copy, when the place
// is inside a shared element — in it, in something in it, or the element itself replaced — and
// not merely next to one.
export function mirrorsOf(root, anchor, position) {
  const h = find(root, anchor);
  if (!h) return [];
  if (shareOf(h.node) != null && !["inside_start", "inside_end", "replace"].includes(position)) return [];
  return copiesOf(root, anchor).map((c) => c.id);
}

// ---- where a new piece goes, top down ------------------------------------------------------
// One choice over every gap on a screen spread Jev's answer over 40-70 gaps, and its favourite,
// "at the top of the screen", put pieces above the header, against the artboard's edge: a screen
// draws no padding of its own; its parts (bars, columns, the main area) carry it. So a piece is
// placed top down, as a person would say it: which part of the screen, then where in it — each a
// choice among a few options — and only ever inside a padded container. Measured 2026-09-23 on
// the ten baseline apps (a search field at the top, a note on a named screen, a button moved to
// the top): the flat choice answered "at the top of the <X> screen" 25/26 times. Top down, with a
// filter added after the search as well, 26/33 landed inside the padding (three filters at the
// end of the main area rather than beside the search) and 7 asked.

const LAYOUT = new Set(["row", "col", "grid", "table"]);
// A container with nothing of its own to see or keep apart — no fill, border or padding.
const plain = (n) => LAYOUT.has(n.type) && n.props?.fill == null && !n.props?.border && !(Number(n.props?.pad) > 0);
const labelOf = (n) => { const s = shapeOf(n); return s ? `${describe(n)} · ${s}` : describe(n); };

// Whether something put into this container sits inside a screen's padding: it, or a container
// around it below the screen, has pad set.
export function padded(root, id) {
  for (let h = find(root, id); h && h.node.type !== "screen" && h.node.type !== "app"; h = h.parent ? find(root, h.parent.id) : null) {
    if (Number(h.node.props?.pad) > 0) return true;
  }
  return false;
}

// Whether a padded gap can be reached inside n (a graph takes new nodes wherever it is).
function reachable(root, n, skip) {
  if (skip.has(n.id)) return false;
  if (n.type === "graph") return true;
  if (!LAYOUT.has(n.type)) return false;
  return padded(root, n.id) || (n.children ?? []).some((k) => reachable(root, k, skip));
}

// The parts of a screen a person names first — its bars, columns and main area: the screen's
// children, looking through a wrapper that is the only thing on it (the row that holds a side nav
// and the content beside it — padded or not: its own gaps would make a new column, and "a search
// field at the top" went there on two apps), and splitting the row that fills the rest of the
// screen with columns (a side nav beside the content, under a top bar) into its columns. A tab bar
// is a row of columns too, but a strip of set height, and stays one part.
const bordered = (n) => n.props?.fill != null || !!n.props?.border;
const holdsOnlyContainers = (n) => LAYOUT.has(n.type) && n.children?.length > 0 && n.children.every((k) => LAYOUT.has(k.type));
const splitsScreen = (n) => n.type === "row" && n.children?.length >= 2 && holdsOnlyContainers(n) && !bordered(n) && (n.props?.h === "fill" || !!n.props?.grow);
export function sectionsOf(root, screenId) {
  const s = find(root, screenId)?.node;
  if (!s || s.type !== "screen") return [];
  let kids = s.children ?? [];
  while (kids.length === 1 && kids[0].children?.length && (plain(kids[0]) || (holdsOnlyContainers(kids[0]) && !bordered(kids[0])))) kids = kids[0].children;
  return kids.flatMap((k) => (splitsScreen(k) ? k.children : [k]));
}

// Where a part is and how big, in words: "the top part of the screen, a strip 80 px tall", "the
// right side of the screen, the widest part, filling the rest of the width". Measured 2026-09-23:
// with these words "add a note to the <X> screen" chose the screen's main area on 10/10 apps
// (0.56-1.00); with the container's description alone, 7/10, and a side nav or top bar the rest.
function partWhere(n, across, i, count) {
  const p = n.props ?? {};
  const bits = [];
  const end = i === 0 ? 0 : i === count - 1 ? 2 : 1;
  if (count > 1) bits.push(across ? ["the left side", "the middle", "the right side"][end] + " of the screen" : ["the top part", "the middle", "the bottom part"][end] + " of the screen");
  const main = across ? p.w : p.h;
  if (p.grow || main === "fill") bits.push(across ? "the widest part, filling the rest of the width" : "the largest part, filling the rest of the height");
  else if (px(main)) bits.push(across ? `a narrow column ${px(main)} px wide` : `a strip ${px(main)} px tall`);
  return bits.join(", ");
}

// The first choice: which part of the screen. Each option is { into: id, text }. `skip` holds an
// element being moved, which is not a place to move it to.
export function partsOf(root, screenId, skip = new Set()) {
  return sectionsOf(root, screenId).filter((n) => reachable(root, n, skip)).map((n) => {
    const h = find(root, n.id);
    return { into: n.id, text: `${labelOf(n)} — ${partWhere(n, h.parent.type === "row", h.index, h.parent.children.length)}` };
  });
}

// The gaps of one container, each named by what is on either side. The gap an element being moved
// (in `skip`) sits in now says so, so that "move it to the top" of what is already first can be
// answered "already there" (the server sees the tree unchanged and says so).
function ownGaps(c, skip) {
  if (c.type === "graph") return [{ anchor: c.id, position: "inside_end", text: `inside ${labelOf(c)}, as a new node or edge` }];
  const all = c.children ?? [];
  const kids = all.filter((k) => !skip.has(k.id));
  const at = all.findIndex((k) => skip.has(k.id));
  const now = at < 0 ? null : at === 0 ? "start" : at === all.length - 1 ? "end" : all[at - 1].id;
  const here = (key) => (now === key ? ", where it is now" : "");
  const across = c.type === "row";
  const w = labelOf(c);
  const out = [{ anchor: c.id, position: "inside_start", text: `at the ${across ? "start (left end)" : "top"} of ${w}${kids.length ? `, ${across ? "left of" : "above"} ${describe(kids[0])}` : ""}${here("start")}` }];
  for (let i = 0; i < kids.length - 1; i++) {
    out.push({ anchor: kids[i].id, position: "after", text: `in ${w}, ${across ? "right of" : "below"} ${describe(kids[i])}, ${across ? "left of" : "above"} ${describe(kids[i + 1])}${here(kids[i].id)}` });
  }
  if (kids.length) out.push({ anchor: c.id, position: "inside_end", text: `at the ${across ? "end (right end)" : "bottom"} of ${w}, ${across ? "right of" : "below"} ${describe(kids[kids.length - 1])}${here("end")}` });
  return out;
}

// The next choice, inside a container already chosen: its own gaps (when they are inside the
// padding) and "somewhere inside" each container in it that has a padded gap. A gap is
// { anchor, position, text }; a way down is { into, text }.
export function spotsIn(root, id, skip = new Set()) {
  const c = find(root, id)?.node;
  if (!c || skip.has(c.id)) return [];
  if (c.type === "graph") return ownGaps(c, skip);
  const out = padded(root, c.id) ? ownGaps(c, skip) : [];
  for (const k of c.children ?? []) {
    if (skip.has(k.id) || !reachable(root, k, skip)) continue;
    if (k.type === "graph") { out.push(...ownGaps(k, skip)); continue; }
    const pos = positionOf(root, k.id);
    out.push({ into: k.id, text: `somewhere inside ${labelOf(k)}${pos ? ` (${pos})` : ""}` });
  }
  return out;
}

// Just outside a part of the screen, kept inside the padding by landing in the part next to it:
// "just below the app bar" is the top of the area under it. Offered with the spots in a part,
// because "a search field at the top" of a phone screen chose its top bar at 0.98-1.00, and then
// nowhere in the bar (0.24). With these, "just below" was its answer (0.35-0.56).
export function edgesOf(root, screenId, id, skip = new Set()) {
  if (!sectionsOf(root, screenId).some((s) => s.id === id)) return [];
  const h = find(root, id);
  if (!h?.parent || h.parent.type === "row") return [];
  const out = [];
  const next = h.parent.children[h.index + 1], prev = h.parent.children[h.index - 1];
  const fits = (n) => n && !skip.has(n.id) && LAYOUT.has(n.type) && padded(root, n.id);
  if (fits(next)) out.push({ anchor: next.id, position: "inside_start", text: `just below ${describe(h.node)}, at the top of ${describe(next)}` });
  if (fits(prev)) out.push({ anchor: prev.id, position: "inside_end", text: `just above ${describe(h.node)}, at the bottom of ${describe(prev)}` });
  return out;
}

// The elements a new piece can follow when the sentence leaves the spot open ("add a filter"):
// everything inside `id` whose row or column is padded, each with where it sits. Jev picks the one
// the piece belongs next to — a filter beside the search field — and code puts it right after.
export function neighboursIn(root, id, skip = new Set()) {
  const c = find(root, id)?.node;
  if (!c) return [];
  const out = [];
  const walk = (n) => {
    for (const k of n.children ?? []) {
      if (skip.has(k.id) || k.type === "edge" || k.type === "node") continue;
      if (padded(root, n.id) && n.type !== "graph") {
        const pos = positionOf(root, k.id);
        out.push({ id: k.id, text: `${labelOf(k)}${pos ? ` · ${pos}` : ""}` });
      }
      if (LAYOUT.has(k.type) && k.type !== "table") walk(k);
    }
  };
  walk(c);
  return out;
}

// Where a whole new screen can go: after any screen there is.
export function screenGaps(root) {
  const screens = (root.children ?? []).filter((s) => s.type === "screen");
  if (!screens.length) return [{ anchor: root.id, position: "inside_end", text: "the first screen of the app" }];
  return screens.map((s, i) => ({
    anchor: s.id, position: "after",
    text: `a new screen after the "${s.text ?? ""}" screen${i === screens.length - 1 ? " (at the end)" : ""}`,
  }));
}

// The patch that puts `outline` at a gap, or in place of a node (position "replace"). This is the
// one place code turns Jev's choice of where into structure; the writer only writes the piece.
export function placeAt(root, anchor, position, outline) {
  const hit = find(root, anchor);
  if (!hit) return null;
  const body = String(outline).split("\n").filter((l) => l.trim()).map((l) => "  " + l.replace(/\s+$/, "")).join("\n");
  if (!body) return null;
  if (position === "inside_start" && hit.node.children?.length) return `before ${hit.node.children[0].id}:\n${body}\n`;
  const verb = { inside_start: "in", inside_end: "in", after: "after", before: "before", replace: "replace" }[position];
  return verb ? `${verb} ${anchor}:\n${body}\n` : null;
}

// ---- patches -----------------------------------------------------------------------------

// The verb must end at a space, a '#', a ':' or the end of the line: `delete-icon` is a line of a
// subtree, not a remove.
const HEAD = /^(in|into|inside|before|after|replace|remove|delete|set)(?![\w-])\s*(.*)$/i;
const VERB = new Map([["into", "in"], ["inside", "in"], ["delete", "remove"]]);

function header(t) {
  const m = HEAD.exec(t);
  if (!m) return null;
  const word = m[1].toLowerCase();
  const kind = VERB.get(word) ?? word;
  const tm = /^#?([\w-]+)\s*:?\s*(.*)$/.exec(m[2]);
  return tm ? { kind, id: tm[1], rest: tm[2] } : { kind, id: null, rest: m[2] };
}

// Blocks apply in order, each to the tree the previous ones left, so a later block can point at
// a node an earlier one added under its own name. A block that cannot apply is skipped with a
// warning and the rest still land: one bad id should not cost the writer the whole answer.
export function applyPatch(root, patchText) {
  const notes = [];
  const warnings = [];
  const lines = String(patchText ?? "").split(LINES);
  const first = lines.find((l) => { const t = l.trim(); return t && !t.startsWith("//") && !t.startsWith("```"); });
  if (first && /^app\b/i.test(first.trim())) {
    // Numbering starts past the old tree's, so no id from before the rewrite means something new.
    const { root: fresh, warnings: w } = parse(lines.join("\n"), { startId: nextId(root) });
    notes.push(`replaced the whole app: ${describe(fresh)}`);
    return { root: fresh, notes, warnings: w };
  }
  if (!root) {
    warnings.push("there is no tree to patch yet; a patch that starts with an app line makes one");
    return { root: null, notes, warnings };
  }

  const next = structuredClone(root);
  const before = new Set(dangling(root));
  let counter = nextId(root);

  // FORMAT.md puts headers at indent 0 and subtrees under them. A line indented deeper than the
  // header it follows is always subtree, whatever word it starts with; a writer that indents its
  // whole answer still has its headers read, since each sits no deeper than the one before.
  const blocks = [];
  let cur = null;
  lines.forEach((raw, i) => {
    const no = i + 1;
    const t = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    const h = t && !t.startsWith("//") && (!cur || indent <= cur.indent) ? header(t) : null;
    if (h) { cur = { ...h, no, indent, body: [] }; blocks.push(cur); return; }
    if (cur) { cur.body.push({ line: raw, no }); return; }
    if (t.startsWith("```")) warnings.push(`line ${no}: code fence ignored`);
    else if (t && !t.startsWith("//")) warnings.push(`line ${no}: not under any block header; ignored`);
  });
  if (!blocks.length && !warnings.length) warnings.push("the patch has no blocks; nothing changed");

  for (const b of blocks) {
    const at = (m) => warnings.push(`line ${b.no}: ${m}`);
    const label = `${b.kind} ${b.id ?? ""}`.trim();
    if (!b.id) { at(`${b.kind} needs an id; block skipped`); continue; }
    const hit = find(next, b.id);
    if (!hit) { at(`${label}: no node '${b.id}'; block skipped`); continue; }
    const target = who(hit.node);

    if (b.kind === "remove") {
      if (b.rest.trim() || b.body.some((x) => x.line.trim() && !x.line.trim().startsWith("//"))) {
        at(`${label}: anything after a remove is ignored`);
      }
      if (!hit.parent) { at(`${label}: the app itself cannot be removed; block skipped`); continue; }
      const gone = idsIn(hit.node);
      hit.parent.children.splice(hit.index, 1);
      const e = dropEdges(next, gone);
      notes.push(`removed ${target}${e ? ` and ${plural(e, "edge")}` : ""}`);
      continue;
    }

    if (b.kind === "set") {
      setBlock(hit.node, [b.rest, ...b.body.map((x) => x.line.trim())].filter(Boolean).join(" "), target, label, at, notes);
      continue;
    }

    // in / before / after / replace: a subtree. A replace frees the replaced subtree's ids first,
    // so the writer can bring #nav back under its own name. A replace of the app keeps the app,
    // and so its id: freeing that would let a new screen share it.
    const body = [];
    if (b.rest.trim()) body.push({ line: b.rest.trim(), no: b.no });
    body.push(...b.body);
    const replacesRoot = b.kind === "replace" && !hit.parent;
    const gone = b.kind === "replace" ? idsIn(hit.node) : new Set();
    if (replacesRoot) gone.delete(hit.node.id);
    const fb = new Builder({ fragment: true, startId: counter, taken: [...idsIn(next)].filter((id) => !gone.has(id)) });
    for (const x of body) fb.push(x.line, x.no);
    warnings.push(...fb.warnings);
    counter = fb.counter;
    const nodes = fb.root.children;
    if (!nodes.length) { at(`${label}: nothing under it; block skipped`); continue; }

    let parent, pos, where;
    if (b.kind === "in") {
      if (isContainer(hit.node)) { parent = hit.node; pos = parent.children.length; where = `in ${target}`; }
      else { at(`${target} holds nothing; put after it instead`); parent = hit.parent; pos = hit.index + 1; where = `after ${target}`; }
    } else if (replacesRoot) {
      if (fb.appLine) {
        if (fb.appLine.text != null) next.text = fb.appLine.text;
        next.props = { ...fb.appLine.props };
      }
      next.children = [];
      parent = next; pos = 0;
    } else if (!hit.parent) {
      at("the app has no siblings; put inside it");
      parent = next; pos = b.kind === "before" ? 0 : next.children.length; where = `in ${target}`;
    } else {
      parent = hit.parent;
      pos = b.kind === "after" ? hit.index + 1 : hit.index;
      where = `${b.kind} ${target}`;
      if (b.kind === "replace") {
        parent.children.splice(hit.index, 1);
        // One node standing in for one node keeps its id, so edges and anything else pointing at
        // it still hold, unless the writer gave the new node a name of its own.
        const only = nodes.length === 1 ? nodes[0] : null;
        if (only && fb.auto.has(only.id) && !idsIn(only).has(hit.node.id)) only.id = hit.node.id;
      }
    }
    if (fb.appLine && !replacesRoot) at("an app line inside a block is ignored; start the patch with it to replace the whole app");

    const alloc = () => {
      const have = idsIn(next);
      for (const n of nodes) for (const id of idsIn(n)) have.add(id);
      let id;
      do id = `n${counter++}`; while (have.has(id));
      return id;
    };
    insert(next, parent, pos, nodes, at, alloc);

    if (b.kind === "replace") {
      const left = idsIn(next);
      const e = dropEdges(next, new Set([...gone].filter((id) => !left.has(id))));
      const also = e ? ` · ${plural(e, "edge")} to it removed` : "";
      notes.push(replacesRoot ? `replaced everything in ${target} with ${list(nodes)}${also}` : `replaced ${target} with ${list(nodes)}${also}`);
    } else {
      notes.push(`added ${list(nodes)} ${where}`);
    }
  }

  for (const d of dangling(next)) if (!before.has(d)) warnings.push(d);
  next.next = Math.max(counter, nextId(next));
  return { root: next, notes, warnings };
}

function setBlock(n, src, target, label, at, notes) {
  const { toks, warns } = tokenize(src);
  for (const x of warns) at(`${label}: ${x}`);
  const changes = [];
  for (const t of toks) {
    if (t.kind === "kv") {
      if (t.key === "text") {
        n.text = t.empty || t.value === "" ? null : clean(String(t.value));
        changes.push(n.text == null ? "text removed" : `text "${clip(n.text, 40)}"`);
      } else if (t.key === "id" || t.key === "type") {
        at(`${label}: ${t.key} cannot be changed with set; use replace`);
      } else if (n.type === "edge" && (t.key === "from" || t.key === "to")) {
        // An end can move but not go: an edge written back out without one is a line parse()
        // skips, so the edge would vanish from every tree rebuilt from the outline. Checked
        // before `key=` deletes, since `to=` would otherwise be read as exactly that.
        const end = t.empty ? "" : cleanId(t.value);
        if (end) { n.props[t.key] = end; changes.push(`${t.key}=${end}`); }
        else at(`${label}: an edge keeps both ends; ${t.raw} ignored (remove the edge instead)`);
      } else if (t.empty) {
        if (Object.hasOwn(n.props, t.key)) { delete n.props[t.key]; changes.push(`${t.key} removed`); }
        else at(`${label}: ${t.key} was not set`);
      } else {
        n.props[t.key] = typeof t.value === "string" ? clean(t.value) : t.value;
        changes.push(propText(t.key, n.props[t.key]) ?? t.key);
      }
    } else if (t.kind === "word" && !["id", "text"].includes(t.value.toLowerCase())) {
      n.props[t.value.toLowerCase()] = true;
      changes.push(t.value.toLowerCase());
    } else if (t.kind === "quoted") {
      n.text = t.value === "" ? null : clean(t.value);
      changes.push(n.text == null ? "text removed" : `text "${clip(n.text, 40)}"`);
    } else {
      at(`${label}: ${ignored(t)}`);
    }
  }
  if (changes.length) notes.push(`set ${target}: ${changes.join(", ")}`);
  else at(`${label}: nothing to set; block skipped`);
}

// Top-level nodes of a patch block, placed at `at` in `parent`. The same two structural rules as
// the builder's fit(): a screen goes to the app (after the screen it was aimed into) and
// anything else aimed at the app goes into the nearest screen. Other misfits land as asked,
// with a warning.
function insert(root, parent, at, nodes, warn, alloc) {
  const cursor = new Map([[parent, at]]);
  const put = (p, n, start) => {
    const i = cursor.has(p) ? cursor.get(p) : start;
    p.children.splice(i, 0, n);
    cursor.set(p, i + 1);
  };
  const check = (p, n) => {
    const need = TYPES[n.type]?.parents;
    if (need && !need.includes(p.type)) warn(`${n.type} belongs in a ${need.join(" or ")}, not ${who(p)}; kept there`);
    const allow = CHILDREN.get(p.type);
    if (allow && !allow.includes(n.type)) warn(`${who(p)} holds ${allow.join(" and ")}; ${who(n)} is kept there but may not draw`);
  };
  for (const n of nodes) {
    if (n.type === "screen" && parent.type !== "app") {
      const s = root.children.findIndex((c) => contains(c, parent));
      warn(`a screen sits only in the app; ${who(n)} put after ${s >= 0 ? who(root.children[s]) : "the last screen"}`);
      put(root, n, s >= 0 ? s + 1 : root.children.length);
    } else if (parent.type === "app" && n.type !== "screen") {
      const i = cursor.get(parent);
      let s = parent.children[i - 1];
      let start;
      if (s?.type === "screen") start = s.children.length;
      else if (parent.children[i]?.type === "screen") { s = parent.children[i]; start = 0; }
      else { s = { id: alloc(), type: "screen", text: "Main", props: {}, children: [] }; put(parent, s, i); start = 0; }
      warn(`${who(n)} sits directly in the app; put in ${who(s)}`);
      check(s, n);
      put(s, n, start);
    } else {
      check(parent, n);
      put(parent, n, at);
    }
  }
}

// ---- direct edits ------------------------------------------------------------------------

// Each op is one property a person can name and see change. An op that does not fit its target
// says why and changes nothing (ok, unchanged); only a bad request (an unknown op, a missing
// node, a rename with no words) is not ok.
export function apply(root, op, id, arg) {
  if (!root) return fail(root, "there is no tree yet");
  if (!Object.hasOwn(EDITS, op) && op !== "clear") return fail(root, `unknown op '${op}'`);
  if (op === "clear") {
    if (!root.children?.length) return { ...same(root, `${who(root)} is already empty`), limit: true };
    const next = structuredClone(root);
    const n = next.children.length;
    next.children = [];
    next.next = nextId(root);
    return { ok: true, root: next, note: `cleared ${who(root)}: ${plural(n, "screen")} gone`, changed: true };
  }
  if (id == null || id === "") return fail(root, `${op} needs a target`);
  const next = structuredClone(root);
  const hit = find(next, id);
  if (!hit) return fail(root, `no node '${id}'`);
  const r = EDITS[op](hit, next, arg);
  if (r.ok === false) return fail(root, r.note);
  // `limit` marks an edit that is already as far as it goes ("already bold"): an answer, not a job
  // for the writer. The canvas branches on it rather than on the wording of the note.
  if (!r.changed) return { ...same(root, r.note), limit: Boolean(r.limit) };
  next.next = Math.max(nextId(root), nextId(next));
  return { ok: true, root: next, note: r.note, changed: true };
}

const fail = (root, note) => ({ ok: false, root, note, changed: false });
const same = (root, note) => ({ ok: true, root, note, changed: false });

const EDITS = {
  bigger:       (h) => resize(h.node, "bigger", 1),
  smaller:      (h) => resize(h.node, "smaller", -1),
  bold:         (h) => weight(h.node, true),
  regular:      (h) => weight(h.node, false),
  darker:       (h) => shade(h.node, 1),
  lighter:      (h) => shade(h.node, -1),
  wider:        (h) => scale(h.node, "w", 1),
  narrower:     (h) => scale(h.node, "w", -1),
  taller:       (h) => scale(h.node, "h", 1),
  shorter:      (h) => scale(h.node, "h", -1),
  move_earlier: (h) => move(h, -1),
  move_later:   (h) => move(h, 1),
  remove:       (h, root) => remove(h, root),
  rename:       (h, _root, arg) => rename(h.node, arg),
};

// A value outside the scale reads as the default, so a stray `size=L` steps from m instead of
// refusing.
const norm = (v, scale, dflt) => {
  const s = typeof v === "string" ? v.toLowerCase() : v;
  return scale.includes(s) ? s : dflt;
};

// The node itself when the op reaches its type; on a container, every descendant it reaches
// (every text, and also the rows of a table and the nodes of a graph); otherwise null.
function targets(n, kinds) {
  if (kinds.has(n.type)) return [n];
  if (isContainer(n)) return descendants(n).filter((d) => kinds.has(d.type));
  return null;
}

// Sizes are always written out, never left to a default: the renderer's default for a button
// or a tr may not be m, and a step from an assumed default could land where it already was.
function resize(n, op, dir) {
  const ts = targets(n, SIZED);
  if (!ts) return { changed: false, note: `${op} is a text size; ${who(n)} has none (try wider or taller)` };
  if (!ts.length) return { changed: false, note: `${who(n)} has no text in it to make ${op}` };
  let moved = 0, from, to;
  for (const t of ts) {
    const cur = norm(t.props.size, SIZES, "m");
    const nx = SIZES[SIZES.indexOf(cur) + dir];
    if (!nx) continue;
    t.props.size = nx;
    moved++;
    from = cur;
    to = nx;
  }
  const end = dir > 0 ? "xxl" : "xs";
  const single = ts.length === 1 && ts[0] === n;
  if (!moved) return { changed: false, limit: true, note: single ? `${who(n)} is already ${end}, the ${dir > 0 ? "largest" : "smallest"} size` : `every text in ${who(n)} is already ${end}` };
  if (single) return { changed: true, note: `${who(n)} size ${from} → ${to}` };
  const stuck = ts.length - moved;
  return { changed: true, note: `${plural(moved, "text")} in ${who(n)} one size ${op}${stuck ? ` · ${stuck} already ${end}` : ""}` };
}

function weight(n, on) {
  const op = on ? "bold" : "regular";
  const ts = targets(n, WEIGHTED);
  if (!ts) {
    const why = n.type === "button" ? "; a button's weight comes from primary / ghost" : "";
    return { changed: false, note: `${op} applies to text, node and tr${why}, not ${who(n)}` };
  }
  if (!ts.length) return { changed: false, note: `${who(n)} has no text in it` };
  let moved = 0;
  for (const t of ts) {
    if (!!t.props.bold === on) continue;
    if (on) t.props.bold = true;
    else delete t.props.bold;
    moved++;
  }
  const single = ts.length === 1 && ts[0] === n;
  if (!moved) return { changed: false, limit: true, note: single ? `${who(n)} is already ${op}` : `every text in ${who(n)} is already ${op}` };
  return { changed: true, note: single ? `${who(n)} → ${op}` : `${plural(moved, "text")} in ${who(n)} → ${op}` };
}

// Text-like things step their shade (default dark, as FORMAT.md says for text). A shape's shade
// is written `fill` (FORMAT.md's primitives table, and the prop render.mjs reads first), default
// light, since a stand-in picture is drawn as a pale block and "darker" should be the step that
// shows. A `shade` a shape carries from an older edit is read when there is no fill, and folded
// into fill, so the two can never disagree about what is drawn. A container steps its fill, and
// lightening past light takes the fill away.
function shade(n, dir) {
  const op = dir > 0 ? "darker" : "lighter";
  if (SHADED.has(n.type)) {
    const shape = n.type === "shape";
    const cur = shape
      ? norm(n.props.fill, SHADES, null) ?? norm(n.props.shade, SHADES, "light")
      : norm(n.props.shade, SHADES, "dark");
    const nx = SHADES[SHADES.indexOf(cur) + dir];
    if (!nx) return { changed: false, limit: true, note: `${who(n)} is already the ${dir > 0 ? "darkest" : "lightest"} shade (${cur})` };
    if (shape) { n.props.fill = nx; delete n.props.shade; }
    else n.props.shade = nx;
    return { changed: true, note: `${who(n)} shade ${cur} → ${nx}` };
  }
  if (isContainer(n)) {
    const cur = norm(n.props.fill, FILLS, "none");
    const nx = FILLS[FILLS.indexOf(cur) + dir];
    if (!nx) return { changed: false, limit: true, note: dir > 0 ? `${who(n)} already has the darkest fill` : `${who(n)} has no fill to lighten` };
    if (nx === "none") delete n.props.fill;
    else n.props.fill = nx;
    return { changed: true, note: `${who(n)} fill ${cur} → ${nx}` };
  }
  return { changed: false, note: `${op} applies to text, node, tr, shape, or a container's fill, not ${who(n)}` };
}

// A w or h in px, as a number or a "120px" string; anything else is no size.
function px(v) {
  if (typeof v === "string" && /^\d+(\.\d+)?(px)?$/i.test(v.trim())) v = parseFloat(v);
  return typeof v === "number" && v > 0 ? v : null;
}

// Size edits step a size the writer set. Something it left unsized is drawn at whatever size
// render.mjs gives it — stretched across a col, as tall as a graph's layout — and a guess at that
// size made here drifted from the renderer until "wider" could make a stretched image narrower.
// So an unsized thing is not guessed at: the edit says so, and the canvas hands the sentence to
// the writer, which can set a size. A circle is round, so one set side stands for both.
function scale(n, key, dir) {
  const dim = key === "w" ? "width" : "height";
  let v = n.props[key];
  if (v === "fill") return { changed: false, note: `${who(n)} is ${key}=fill; it takes the room it is given` };
  v = px(v) ?? (n.type === "shape" && n.props.circle ? px(n.props[key === "w" ? "h" : "w"]) : null);
  if (v == null) return { changed: false, note: `${who(n)} has no set ${dim}; it takes its size from ${key === "w" ? "its content or its parent" : "its content"}` };
  // Growing always moves at least a pixel, so a 4 px accent bar still gets wider. The 8 px floor
  // is only for shrinking: below it a thing stops being something a person can point at.
  const to = dir > 0 ? Math.max(Math.round(v * 1.25), Math.floor(v) + 1) : Math.round(v / 1.25);
  if (dir < 0 && (to < 8 || to === v)) return { changed: false, limit: true, note: `${who(n)} is already as small as it goes` };
  n.props[key] = to;
  return { changed: true, note: `${who(n)} ${key} ${v} → ${to}` };
}

// In a graph a node swaps with the next node over and an edge with the next edge: edges are
// not drawn in document order, so swapping a node with an edge would be a change nobody sees.
function move(h, dir) {
  const n = h.node;
  if (!h.parent) return { changed: false, note: "the app has nothing to move among" };
  const sibs = h.parent.children;
  const alike = (s) => h.parent.type !== "graph" || (s.type === "edge") === (n.type === "edge");
  let j = h.index + dir;
  while (j >= 0 && j < sibs.length && !alike(sibs[j])) j += dir;
  if (j < 0 || j >= sibs.length) return { changed: false, limit: true, note: `${who(n)} is already ${dir < 0 ? "first" : "last"}` };
  const way = h.parent.type === "row" ? (dir < 0 ? "left" : "right")
    : h.parent.type === "grid" || h.parent.type === "graph" ? (dir < 0 ? "earlier" : "later")
    : (dir < 0 ? "up" : "down");
  const other = sibs[j];
  sibs[h.index] = other;
  sibs[j] = n;
  return { changed: true, note: `${who(n)} moved ${way}, past ${who(other)}` };
}

function remove(h, root) {
  if (!h.parent) return { changed: false, note: "the app itself stays; clear empties it" };
  const gone = idsIn(h.node);
  h.parent.children.splice(h.index, 1);
  const e = dropEdges(root, gone);
  return { changed: true, note: `removed ${who(h.node)}${e ? ` and ${plural(e, "edge")}` : ""}` };
}

function rename(n, arg) {
  if (!TEXTED.has(n.type)) return { changed: false, note: `${who(n)} has no text to rename` };
  const raw = arg && typeof arg === "object" ? arg.text : arg;
  const text = clean(String(raw ?? "")).trim();
  if (!text) return { ok: false, changed: false, note: "rename needs the new words" };
  if (n.text === text) return { changed: false, limit: true, note: `${who(n)} already says that` };
  const was = n.text;
  n.text = text;
  return { changed: true, note: `${n.type} ${was ? `"${clip(String(was), 40)}" → ` : ""}"${clip(text, 40)}"` };
}
