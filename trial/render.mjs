// render — turns a trial tree into one self-contained greyscale HTML document.
//
//   import { render } from "./render.mjs"
//   render(root, { title }) → "<!doctype html>…"
//
// The tree is the one FORMAT.md describes: a few nestable primitives, each node
// { id, type, text, props, children }. Nothing here knows what a side nav, a kanban board or a chat
// thread is. Those are compositions of row, col, fill and w, and this file's whole job is to make
// real flexbox do what the props say, so a composition the writer spelled out looks the way it was
// meant to without anyone coding the thing it is.
//
// Three promises the canvas depends on:
//   - every node owns exactly one element carrying its data-id (a screen's also carries
//     data-screen), and that element sits inside its parent's, so `closest("[data-id]")` from a
//     click lands on the innermost node and `querySelector('[data-id="…"]')` finds the right one;
//   - any prefix of a tree renders. The writer streams and the canvas redraws after every line, so a
//     half-built graph, an empty table or an edge to a node not yet written is ordinary input;
//   - greyscale only. Emphasis is size, weight and shade, things a person can name and see change.

// ---- vocabulary --------------------------------------------------------------------------

const SCALE = [0, 4, 8, 12, 16, 24, 32];            // gap=0..6 and pad=0..6
const SIZES = ["xs", "s", "m", "l", "xl", "xxl"];
const SIZE_ALIAS = { xxs: "xs", sm: "s", small: "s", md: "m", medium: "m", lg: "l", large: "l", "2xl": "xxl" };
const SHADES = ["dark", "mid", "light"];
const FRAMES = { web: { w: 1200, h: 720 }, phone: { w: 375, h: 760 }, panel: { w: 360, h: 640 } };
const LEAVES = new Set(["text", "button", "input", "shape", "line", "progress", "chart", "tr", "node", "edge"]);
const KNOWN = new Set(["app", "screen", "row", "col", "grid", "table", "graph", ...LEAVES]);
const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const JUSTIFY = { start: "flex-start", center: "center", end: "flex-end", between: "space-between" };

// Heights of things the writer did not size. The chart's is also tree.mjs's stand-in for
// `taller` on an unsized chart, so the first step grows the plot by a quarter.
const RECT_H = 120, CHART_H = 120;

// Rows, cols and grids get an 8px gap unless they say otherwise; screens get none. A col of
// inputs with no gap looks broken, and a writer who forgets `gap` should still get something that
// reads. A screen is different: it is the app shell, and a header bar, a side nav or a tab bar
// belongs flush against the artboard edge — `pad` and `gap` on the screen are there when wanted.
const GAP_DEFAULT = 2;

// ---- reading a node tolerantly ------------------------------------------------------------
// The parser already normalises, but render() is also handed hand-built and half-built trees, so
// nothing here trusts a field to exist or to have the right type.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const props = (n) => (n && typeof n.props === "object" && n.props !== null ? n.props : {});
const kids = (n) => (Array.isArray(n?.children) ? n.children.filter((c) => c && typeof c === "object") : []);
const rawType = (n) => String(n?.type ?? "").trim().toLowerCase();
const typeOf = (n) => (KNOWN.has(rawType(n)) ? rawType(n) : "shape");
const flag = (v) => v === true || v === "true" || v === 1;
const words = (v) => (v === null || v === undefined || v === true || v === false ? "" : String(v));
const num = (v) => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r1 = (x) => Math.round(x * 10) / 10;

// A dimension is a pixel count ("120" or "120px") or "fill"; anything else (a typo, "30%",
// "20rem", "1fr") is ignored rather than guessed at. parseFloat alone would read "30%" as 30px,
// which is a far worse drawing than the element's natural size.
const PX = /^\s*(\d+\.?\d*|\.\d+)\s*(px)?\s*$/i;
function dim(v) {
  if (v === "fill" || v === "full") return "fill";
  const x = typeof v === "number" ? v : typeof v === "string" && PX.test(v) ? parseFloat(v) : null;
  return x !== null && Number.isFinite(x) && x > 0 ? Math.min(Math.round(x), 4000) : null;
}
const step = (v) => { const x = num(v); return x === null ? null : SCALE[clamp(Math.round(x), 0, 6)]; };
const sizeOf = (v) => { const k = String(v ?? "").toLowerCase(); const s = SIZE_ALIAS[k] ?? k; return SIZES.includes(s) ? s : null; };
const shadeOf = (v) => { const k = String(v ?? "").toLowerCase(); return SHADES.includes(k) ? k : null; };
const growOf = (v) => (flag(v) ? 1 : num(v) > 0 ? num(v) : 0);
const fillOf = (v) => shadeOf(v) ?? (flag(v) ? "light" : null);

function frameOf(n, fallback) {
  const p = props(n);
  if (FRAMES[p.frame]) return p.frame;
  for (const f of ["phone", "panel", "web"]) if (flag(p[f])) return f;
  return fallback;
}

// ---- html helpers ------------------------------------------------------------------------

const DATA = ' data-lint="data"';
const IGN = ' data-lint="ignore"';
const cls = (xs) => xs.filter(Boolean).join(" ");

// The one element a node owns. Nodes without an id (only possible in hand-built trees) get no
// data-id, so a click on them falls through to the nearest ancestor that has one.
function open(tag, n, classes, style = [], extra = "") {
  const id = n?.id === null || n?.id === undefined ? "" : ` data-id="${esc(n.id)}"`;
  const st = style.length ? ` style="${esc(style.join(";"))}"` : "";
  return `<${tag} class="${cls(classes)}"${id}${st}${extra}>`;
}

// ---- layout ------------------------------------------------------------------------------
// ctx.dir is the direction the parent lays its children out in ("row", "col", "grid" or "none"),
// ctx.align whether the parent set `align` itself. Both are needed because w, h and grow mean
// different CSS along the main axis and across it.

// How a node sizes itself inside its parent. `d.self` is where a leaf sits on the cross axis when
// the parent did not say: rows stretch their children so a side nav fills the screen height, but a
// button or a tag pulled to the height of the tallest thing in its row looks broken, so leaves in
// a row sit at the top and only containers stretch. `d.basis` is a leaf's natural width in a row,
// for leaves (an input, a chart) that have no intrinsic width and would otherwise collapse.
function sizing(p, ctx, d = {}) {
  const w = dim(p.w), h = dim(p.h), g = growOf(p.grow);
  const s = [];
  if (ctx.dir === "row" || ctx.dir === "col") {
    const [main, cross, mp, cp] = ctx.dir === "row" ? [w, h, "width", "height"] : [h, w, "height", "width"];
    if (g || main === "fill") s.push(`flex:${g || 1} 1 ${typeof main === "number" ? main : 0}px`);
    else if (typeof main === "number") s.push(`${mp}:${main}px`, "flex:none");
    else if (ctx.dir === "row" && d.basis) s.push(`flex:0 1 ${Math.round(d.basis)}px`);
    if (typeof cross === "number") s.push(`${cp}:${cross}px`);
    else if (cross === "fill") s.push("align-self:stretch");
    else if (!ctx.align && d.self?.[ctx.dir]) s.push(`align-self:${d.self[ctx.dir]}`);
  } else {
    if (typeof w === "number") s.push(`width:${w}px`);
    else if (ctx.dir === "grid" && w !== "fill" && !ctx.align && d.self?.col) s.push("justify-self:start");
    if (typeof h === "number") s.push(`height:${h}px`);
  }
  return s;
}

// How a container lays out its own children.
function flow(p, dir, { gap: gapDefault = GAP_DEFAULT } = {}) {
  const style = [], classes = [];
  const gap = step(p.gap) ?? SCALE[gapDefault];
  const pad = step(p.pad);
  if (dir !== "table" && dir !== "graph") style.push(`gap:${gap}px`);
  if (flag(p.divider) && (dir === "row" || dir === "col")) {
    // The line sits in the middle of the gap: the gap above it, the same again as padding below.
    classes.push(dir === "row" ? "dv-row" : "dv-col");
    style.push(`--g:${gap}px`);
  }
  if (pad && dir !== "graph") style.push(`padding:${pad}px`);
  const a = ALIGN[String(p.align ?? "").toLowerCase()];
  if (a && dir !== "table" && dir !== "graph") style.push(`align-items:${a}`);
  const j = JUSTIFY[String(p.justify ?? "").toLowerCase()];
  if (j && (dir === "row" || dir === "col")) style.push(`justify-content:${j}`);
  const f = fillOf(p.fill);
  if (f) classes.push("fill-" + f);
  if (flag(p.border)) classes.push("bordered");
  return { style, classes, align: Boolean(a), pad: pad ?? 0 };
}

// ---- nodes -------------------------------------------------------------------------------

function renderNode(n, ctx) {
  if (!n || typeof n !== "object") return "";
  const t = typeOf(n);
  const html = KIND[t](n, ctx);
  // A misplaced child under a leaf (the parser attaches it rather than dropping it) is drawn right
  // after the leaf, as its sibling: visible, clickable, and removable, instead of silently lost.
  // That holds for an edge outside a graph too: the edge has nothing to join, its children do.
  const extra = LEAVES.has(t) ? kids(n).map((c) => renderNode(c, ctx)).join("") : "";
  return html + extra;
}

function container(n, ctx, dir, extraClass = [], extraAttrs = "") {
  const p = props(n);
  const f = flow(p, dir);
  const style = [...sizing(p, ctx), ...f.style];
  if (dir === "grid") {
    const cols = clamp(Math.round(num(p.cols) ?? 3), 1, 12);
    style.push(`grid-template-columns:repeat(${cols},minmax(0,1fr))`);
  }
  const inner = { dir, align: f.align, run: ctx.run };
  return open("div", n, [dir, ...extraClass, ...f.classes], style, extraAttrs) +
    kids(n).map((c) => renderNode(c, inner)).join("") + "</div>";
}

const KIND = {
  row: (n, ctx) => container(n, ctx, "row"),
  col: (n, ctx) => container(n, ctx, "col"),
  grid: (n, ctx) => container(n, ctx, "grid"),
  // Out of place (not the root, or not under the app): still a column, still addressable.
  app: (n, ctx) => container(n, ctx, "col"),
  screen: (n, ctx) => container(n, ctx, "col", ["nested-screen"], ` data-screen="${esc(screenKey(n))}"`),

  text: (n, ctx) => {
    const p = props(n);
    const pill = flag(p.pill), under = flag(p.under);
    const shade = shadeOf(p.shade);
    const classes = ["t", "sz-" + (sizeOf(p.size) ?? "m"), flag(p.bold) && "b", shade && shade !== "dark" && "sh-" + shade,
      flag(p.mono) && "mono", pill && "pill", under && "under"];
    const style = sizing(p, ctx, { self: { row: "flex-start", col: pill || under ? "flex-start" : null } });
    return open("div", n, classes, style, flag(p.data) ? DATA : "") + esc(words(n.text)) + "</div>";
  },

  button: (n, ctx) => {
    const p = props(n);
    const kind = flag(p.primary) ? "primary" : flag(p.ghost) ? "ghost" : null;
    const classes = ["btn", kind, "sz-" + (sizeOf(p.size) ?? "m"), flag(p.bold) && "b"];
    const style = sizing(p, ctx, { self: { row: "flex-start", col: "flex-start" } });
    return open("div", n, classes, style) + esc(words(n.text)) + "</div>";
  },

  input: (n, ctx) => {
    const p = props(n);
    const variant = ["area", "check", "toggle", "select", "search"].find((k) => flag(p[k])) ?? "plain";
    const on = flag(p.on);
    const label = words(n.text);
    const value = words(p.value);
    const classes = ["inp", variant, "sz-" + (sizeOf(p.size) ?? "m")];
    const boxed = variant !== "check" && variant !== "toggle";
    const style = sizing(p, ctx, { self: { row: "flex-start" }, basis: boxed ? 240 : 0 });
    const t = `<span class="t">${esc(label)}</span>`;
    let inner;
    if (variant === "check") {
      inner = `<span class="cb${on ? " on" : ""}">${on ? ICON.tick : ""}</span>${t}`;
    } else if (variant === "toggle") {
      inner = `${t}<span class="tg-pill${on ? " on" : ""}"><span class="tg-circle"></span></span>`;
    } else {
      // With a value, the words are the field's label and the value sits in the box; without one
      // they are the placeholder. That is how an empty form and a filled-in one both read right.
      const shown = value ? `<span class="v"${DATA}>${esc(value)}</span>` : `<span class="ph">${esc(label)}</span>`;
      const box = variant === "search" ? ICON.search + shown : variant === "select" ? shown + ICON.chevron : shown;
      inner = (value && label ? `<span class="inp-label">${esc(label)}</span>` : "") + `<span class="inp-box">${box}</span>`;
    }
    return open("div", n, classes, style) + inner + "</div>";
  },

  // A shape is anything pictorial. Its size defaults make an unsized one still read as what it is:
  // a rectangle is an image block, a circle an avatar, a pill a badge. An unknown type arrives here
  // too, labelled with its own type name so the person can see what was asked for.
  shape: (n, ctx) => {
    const p = props(n);
    const form = flag(p.circle) ? "circle" : flag(p.pill) ? "pill" : "rect";
    const q = { ...p };
    if (form === "circle") {
      const d = [dim(p.w), dim(p.h)].find((x) => typeof x === "number") ?? 40;
      if (typeof dim(q.w) !== "number") q.w = d;
      if (typeof dim(q.h) !== "number") q.h = d;
    } else if (form === "pill") {
      if (dim(q.w) === null) q.w = 96;
      if (dim(q.h) === null) q.h = 32;
    } else if (dim(q.h) === null && !(ctx.dir === "col" && growOf(p.grow))) {
      q.h = RECT_H;
    }
    // FORMAT.md names a shape's shade `fill`; `shade` is read too, in case an edit steps that.
    const tone = fillOf(p.fill) ?? shadeOf(p.shade) ?? "light";
    const label = n.text ?? (KNOWN.has(rawType(n)) ? "" : rawType(n));
    const style = sizing(q, ctx, { self: { row: "flex-start", col: form === "rect" ? null : "flex-start" }, basis: 160 });
    // A picture told to take the remaining height is still a picture where there is none to take:
    // .shp clips its overflow, which lets flexbox shrink it to nothing in a card that is only as
    // tall as its content. It keeps an unsized one's height as its floor.
    if (form === "rect" && typeof dim(q.h) !== "number") style.push(`min-height:${RECT_H}px`);
    const small = form === "circle" && (dim(q.w) ?? 40) < 24;
    // A circle is usually an avatar or an icon; a label wider than it would only show as "set…".
    // Initials read as what an avatar shows: "Sarah Chen" → SC, "settings" → S.
    const fits = form !== "circle" || textWidth(label, 10) <= (dim(q.w) ?? 40) - 6;
    const shown = fits ? label : label.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
    return open("div", n, ["shp", form, "f-" + tone], style) + (shown && !small ? `<span>${esc(shown)}</span>` : "") + "</div>";
  },

  // Oriented by the parent's direction; always stretched across it, because a divider that only
  // spans its own content is invisible.
  line: (n, ctx) => {
    const p = props(n);
    const vertical = ctx.dir === "row";
    return open("div", n, ["ln", vertical ? "v" : "h"], sizing(p, { ...ctx, align: true })) + "</div>";
  },

  progress: (n, ctx) => {
    const p = props(n);
    const v = clamp(num(p.value) ?? 0, 0, 100);
    const label = words(n.text);
    const style = sizing(p, ctx, { self: { row: "flex-start" }, basis: 200 });
    return open("div", n, ["prog"], style, DATA) +
      (label ? `<span class="prog-label">${esc(label)}</span>` : "") +
      `<span class="prog-track"><span class="prog-bar" style="width:${r1(v)}%"></span></span></div>`;
  },

  chart: (n, ctx) => {
    const p = props(n);
    const h = dim(p.h);
    const H = typeof h === "number" ? h : CHART_H;
    // The chart's `h` is the plot's height, not the element's: the caption sits below it. A chart
    // that takes the remaining height (h=fill, or grow down a col) hands that height to its plot,
    // with H as the plot's floor — a tall empty box under a short plot reads as a bug.
    const style = sizing({ ...p, h: h === "fill" ? "fill" : undefined }, ctx, { self: { row: "flex-start" }, basis: 240 });
    const fills = h === "fill" || (ctx.dir === "col" && growOf(p.grow) > 0);
    const cap = words(n.text);
    return open("div", n, ["chart"], style, DATA) + plot(flag(p.line) ? "line" : "bar", series(p.values), H, fills) +
      (cap ? `<span class="ch-cap">${esc(cap)}</span>` : "") + "</div>";
  },

  table: (n, ctx) => table(n, ctx),

  // A row outside a table still reads as a row of cells. The wrapper has no data-id: the <tr> is
  // the node's one element.
  tr: (n, ctx) => {
    const style = sizing(props(n), ctx);
    return `<div class="tb solo"${style.length ? ` style="${esc(style.join(";"))}"` : ""}>` +
      `<table><tbody>${trHtml(n, Math.max(1, cellsOf(n).length), "td")}</tbody></table></div>`;
  },

  graph: (n, ctx) => graph(n, ctx),

  // A node outside a graph is drawn as the same box, in the flow.
  node: (n, ctx) => {
    const p = props(n);
    const form = flag(p.circle) ? "circle" : flag(p.pill) ? "pill" : null;
    const shade = shadeOf(p.shade);
    const sub = words(p.sub);
    const classes = ["nd", form, flag(p.bold) && "bold", shade && shade !== "dark" && "sh-" + shade,
      (p.border === "dashed" || flag(p.dashed)) && "dashed", "sz-" + (sizeOf(p.size) ?? "m")];
    return open("div", n, classes, sizing(p, ctx, { self: { row: "flex-start", col: "flex-start" } })) +
      `<span class="nd-l"${DATA}>${esc(words(n.text))}</span>` + (sub ? `<span class="nd-s"${DATA}>${esc(sub)}</span>` : "") + "</div>";
  },

  // An edge outside a graph has no two boxes to join; like an edge to a missing node, it is skipped.
  edge: () => "",
};

const ICON = {
  search: `<svg class="ic" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><path d="M9.5 9.5L13 13"/></svg>`,
  chevron: `<svg class="ic" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4"/></svg>`,
  tick: `<svg class="ic" width="10" height="8" viewBox="0 0 10 8" aria-hidden="true"><path d="M1 4l3 3 5-6"/></svg>`,
};

// ---- chart -------------------------------------------------------------------------------

function series(v) {
  const list = Array.isArray(v) ? v : typeof v === "number" ? [v] : typeof v === "string" ? v.split(/[\s,;|]+/) : [];
  const vals = list.map(num).filter((x) => x !== null).slice(0, 200);
  // A chart the writer gave no values is still a chart stand-in, the way a shape stands in for an
  // image; an empty box would read as a bug.
  return vals.length ? vals : [3, 5, 4, 7, 6, 8];
}

// The plot is stretched to its element's width (preserveAspectRatio="none"), so strokes are kept
// at their written width with non-scaling-stroke and nothing round (no dots) is drawn. When the
// chart fills, the plot is stretched to its height the same way, and H only sets its floor.
function plot(kind, vals, H, fills = false) {
  const W = 300, pad = 6;
  // All zeros: with no range the zero line would land on the top padding; give it a range of 1
  // so the zero bars sit on the floor of the plot like any other zero.
  const lo = Math.min(0, ...vals);
  let hi = Math.max(0, ...vals);
  if (hi === lo) hi = 1;
  const span = hi - lo;
  const y = (v) => r1(pad + ((hi - v) / span) * (H - 2 * pad));
  const grid = [pad, H / 2, H - pad].map((g) => `<path class="ch-grid" d="M0 ${r1(g)}H${W}"/>`).join("");
  let marks;
  if (kind === "line") {
    const x = (i) => r1(vals.length === 1 ? W / 2 : (i / (vals.length - 1)) * W);
    const pts = vals.map((v, i) => `${x(i)} ${y(v)}`);
    marks = `<path class="ch-area" d="M${pts.join("L")}L${x(vals.length - 1)} ${y(0)}L${x(0)} ${y(0)}Z"/>` +
      `<path class="ch-line" d="M${pts.join("L")}"/>`;
  } else {
    const slot = W / vals.length, bw = slot * 0.62;
    marks = vals.map((v, i) => {
      const top = Math.min(y(v), y(0)), hh = Math.max(Math.abs(y(v) - y(0)), 1);
      return `<rect class="ch-bar" x="${r1(i * slot + (slot - bw) / 2)}" y="${r1(top)}" width="${r1(bw)}" height="${r1(hh)}"/>`;
    }).join("");
  }
  // A filling plot gets no height attribute: the attribute would count as a CSS height, and an
  // explicit min-height stops the svg's aspect ratio from setting its minimum instead.
  const size = fills ? `style="flex:1 1 0px;min-height:${H}px"` : `height="${H}" style="height:${H}px"`;
  return `<svg class="ch-plot" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ${size} aria-hidden="true">${grid}${marks}</svg>`;
}

// ---- table -------------------------------------------------------------------------------

const cellsOf = (tr) => (tr.text === null || tr.text === undefined ? [] : String(tr.text).split("|").map((c) => c.trim()));

function trHtml(tr, ncol, cell) {
  const p = props(tr);
  const cells = cellsOf(tr);
  while (cells.length < ncol) cells.push("");
  const shade = shadeOf(p.shade);
  const size = sizeOf(p.size);
  const lint = flag(p.data) ? DATA : "";
  return open("tr", tr, [size && "sz-" + size, flag(p.bold) && "b", shade && shade !== "dark" && "sh-" + shade]) +
    cells.map((c) => `<${cell}${lint}>${esc(c)}</${cell}>`).join("") + "</tr>";
}

function table(n, ctx) {
  const p = props(n);
  const f = flow(p, "table");
  const all = kids(n);
  const rows = all.filter((k) => typeOf(k) === "tr");
  const ncol = Math.max(1, ...rows.map((r) => cellsOf(r).length));
  const head = rows[0];
  // Anything that is not a tr still gets drawn, as a full-width row, where it was written; so
  // does anything attached under a tr, right after its row (the header's go first in the body).
  const inner = { dir: "col", align: false, run: ctx.run };
  const other = (k) => `<tr class="tb-other"><td colspan="${ncol}">${renderNode(k, inner)}</td></tr>`;
  const under = (tr) => kids(tr).map(other).join("");
  const body = (head ? under(head) : "") + all.filter((k) => k !== head)
    .map((k) => (typeOf(k) === "tr" ? trHtml(k, ncol, "td") + under(k) : other(k))).join("");
  const style = [...sizing(p, ctx), ...f.style];
  return open("div", n, ["tb", flag(p.divider) && "dv", ...f.classes], style) +
    `<table>${head ? `<thead>${trHtml(head, ncol, "th")}</thead>` : ""}<tbody>${body}</tbody></table></div>`;
}

// ---- graph -------------------------------------------------------------------------------
// Layered layout, done here in a page of code rather than with a library (FORMAT.md: no
// dependencies). Nodes are measured from their words, layered by longest path from a source,
// kept in document order inside a layer, and joined by cubic curves. There is no crossing
// minimisation: document order is the order the writer thought of things in, and a graph that
// reshuffles itself when one more node streams in is harder to follow than one with a crossing.

const NODE_FS = { xs: 10, s: 11.5, m: 13, l: 15, xl: 18, xxl: 22 };
const G = { margin: 16, nodeGap: 20, rowGap: 28, layerGap: 56, padX: 14, padY: 9, minW: 72, maxW: 280, back: 30, backStep: 14 };

// Rough per-character widths for a system sans, in em. Only used to size boxes; a label that
// the estimate gets wrong still sits centred in its box.
function textWidth(s, px, bold = false) {
  let em = 0;
  for (const ch of String(s ?? "")) {
    em += /[\s.,:;'|!ilj·]/.test(ch) ? 0.28
      : /[MWmw@%]/.test(ch) ? 0.84
      : /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-￯]/.test(ch) ? 1
      : /[A-Z0-9#&]/.test(ch) ? 0.64
      : 0.53;
  }
  return em * px * (bold ? 1.06 : 1);
}

function fit(s, maxW, px, bold) {
  if (textWidth(s, px, bold) <= maxW) return s;
  const chars = [...s];
  while (chars.length && textWidth(chars.join("") + "…", px, bold) > maxW) chars.pop();
  return chars.join("") + "…";
}

function measure(n) {
  const p = props(n);
  const fs = NODE_FS[sizeOf(p.size) ?? "m"];
  const sfs = r1(fs * 0.85);
  const bold = flag(p.bold);
  const shape = flag(p.circle) ? "circle" : flag(p.pill) ? "pill" : "rect";
  const padX = shape === "pill" ? G.padX + 6 : G.padX;
  const room = G.maxW - 2 * padX;
  const label = fit(typeOf(n) === "node" ? words(n.text) : words(n.text) || rawType(n), room, fs, bold);
  const sub = fit(words(p.sub), room, sfs, false);
  const tw = Math.max(textWidth(label, fs, bold), textWidth(sub, sfs));
  const lineH = fs * 1.3, subH = sub ? sfs * 1.3 + 2 : 0;
  let w = Math.max(G.minW, Math.ceil(tw + 2 * padX));
  let h = Math.ceil(lineH + subH + 2 * G.padY);
  if (shape === "circle") w = h = Math.min(Math.max(w - 8, h + 16, 56), 200);
  return { w, h, fs, sfs, lineH, subH, label, sub, shape, bold };
}

const ref = (v) => words(v).trim().replace(/^#/, "");

// Can `to` be reached from `from` along the edges accepted so far?
function reaches(from, to, out) {
  const seen = new Set([from]), stack = [from];
  while (stack.length) {
    const u = stack.pop();
    if (u === to) return true;
    for (const v of out.get(u)) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  return false;
}

const bez = (P, t) => {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * P[0][0] + b * P[1][0] + c * P[2][0] + d * P[3][0], a * P[0][1] + b * P[1][1] + c * P[2][1] + d * P[3][1]];
};

// Edge routing. Every edge is one cubic, so the canvas draws it as one path and its label sits
// at t = 0.5. Nodes are painted over edges, so a curve that crosses a box other than its own two
// ends is hidden behind that box, label and all: a skip connection drawn straight through the
// step it skips reads as a plain pipeline, and a retry loop cut through a sibling reads as coming
// from the sibling. So each edge tries a few shapes in order and keeps the first that crosses no
// other box:
//   forward  straight across to the next layer; else an arc over everything it spans (to the
//            left of it for dir=down); else one under it.
//   back     a loop under everything it spans (to the right for dir=down); else one over it.
// An arc leaves a box from its outer side (a skip jumps over the step it skips), else from the
// side facing along the flow, and is pushed further out until it clears every box on its way.
// Arcs on one side stack, each a little further out than the last, so two never draw on top of
// each other. When nothing clears, the shape that crosses least is kept.
//
// The geometry is written once, along the flow (u) and across it (v), and turned into x/y for
// the graph's direction. "Under" is +v: below for dir=right, to the right for dir=down.
const CLEAR = 4;     // how far a curve keeps from a box it does not join
const PUSH = 12;     // how much further out an arc goes on each try
const TRIES = 24;

function route(edges, items, dir) {
  const across = dir === "right";
  const box = (it) => (across
    ? { u0: it.x, u1: it.x + it.w, v0: it.y, v1: it.y + it.h }
    : { u0: it.y, u1: it.y + it.h, v0: it.x, v1: it.x + it.w });
  const xy = (P) => (across ? P : P.map(([u, v]) => [v, u]));
  const boxes = new Map(items.map((it) => [it, box(it)]));
  const uc = (q) => (q.u0 + q.u1) / 2, vc = (q) => (q.v0 + q.v1) / 2;
  const stacked = { "-1": 0, "1": 0 };

  // How much of a candidate curve (in x/y) would be hidden: samples inside a box it does not
  // join, plus every box its label would sit on.
  const hidden = (P, e) => {
    let n = 0;
    for (let i = 1; i < 48; i++) {
      const [x, y] = bez(P, i / 48);
      for (const it of items) {
        if (it !== e.a && it !== e.b && x > it.x - CLEAR && x < it.x + it.w + CLEAR && y > it.y - CLEAR && y < it.y + it.h + CLEAR) n++;
      }
    }
    if (e.label) {
      const [x, y] = bez(P, 0.5), hw = textWidth(e.label, 11) / 2 + 3, hh = 9;
      for (const it of items) if (x + hw > it.x && x - hw < it.x + it.w && y + hh > it.y && y - hh < it.y + it.h) n++;
    }
    return n;
  };

  for (const e of edges) {
    if (e.kind === "self") {
      const A = e.a;
      const x0 = A.shape === "circle" ? A.x + A.w / 2 : A.x + A.w - 18, y0 = A.y;
      const x3 = A.x + A.w, y3 = A.shape === "circle" ? A.y + A.h / 2 : A.y + 12;
      e.points = [[x0, y0], [x0, y0 - 30], [x3 + 30, y3], [x3, y3]];
      e.mid = bez(e.points, 0.5);
      continue;
    }
    const a = boxes.get(e.a), b = boxes.get(e.b);
    const f = e.kind === "forward" ? 1 : -1;   // which way along the flow the edge runs
    const tries = f > 0
      ? [[0], [-1, "outer"], [-1, "flow"], [1, "outer"], [1, "flow"]]
      : [[1, "outer"], [-1, "outer"], [1, "flow"], [-1, "flow"]];
    let best = null;
    for (const [side, port] of tries) {
      let found = null;
      if (!side) {
        // Leave the side facing the next layer, enter the opposite one.
        const d = (b.u0 - a.u1) / 2;
        const P = xy([[a.u1, vc(a)], [a.u1 + d, vc(a)], [b.u0 - d, vc(b)], [b.u0, vc(b)]]);
        found = { P, n: hidden(P, e), side };
      } else {
        const outer = port === "outer";
        const p0 = outer ? [uc(a), side < 0 ? a.v0 : a.v1] : [f > 0 ? a.u1 : a.u0, vc(a)];
        const p3 = outer ? [uc(b), side < 0 ? b.v0 : b.v1] : [f > 0 ? b.u0 : b.u1, vc(b)];
        const k = outer ? 0 : f * Math.min(28, Math.abs(p3[0] - p0[0]) / 3);
        // Start just outside every box the arc passes alongside, its own two included.
        const lo = Math.min(p0[0], p3[0]), hi = Math.max(p0[0], p3[0]);
        const spanned = [a, b, ...items.map((it) => boxes.get(it)).filter((q) => q.u1 > lo && q.u0 < hi)];
        let c = side < 0 ? Math.min(...spanned.map((q) => q.v0)) : Math.max(...spanned.map((q) => q.v1));
        c += side * (G.back + G.backStep * stacked[side]);
        for (let i = 0; i < TRIES && found?.n !== 0; i++, c += side * PUSH) {
          const P = xy([p0, [p0[0] + k, c], [p3[0] - k, c], p3]);
          const n = hidden(P, e);
          if (!found || n < found.n) found = { P, n, side };
        }
      }
      if (!best || found.n < best.n) best = found;
      if (!best.n) break;
    }
    if (best.side) stacked[best.side] += 1;
    e.points = best.P;
    e.mid = bez(best.P, 0.5);
  }
}

// Positions for one graph node's children, in the graph's own coordinates. Exported for tests
// and for anything that wants to know where a node landed; render() is the only caller here.
export function layoutGraph(graph) {
  const p = props(graph);
  const dir = /^(down|vertical|v|tb|column|col)$/i.test(words(p.dir).trim()) ? "down" : "right";
  const items = [], byId = new Map(), edgeNodes = [];
  // Any leaf in a graph that is not an edge is laid out as a node, even a misplaced `text`: the
  // parser attached it there, and a box with its words is the most honest drawing of that. A
  // misplaced container is not a box: graph() draws it as itself, under the drawing.
  for (const c of kids(graph)) {
    if (typeOf(c) === "edge") { edgeNodes.push(c); continue; }
    if (!LEAVES.has(typeOf(c))) continue;
    const it = { id: c.id ?? null, node: c, order: items.length, layer: 0, x: 0, y: 0, ...measure(c) };
    items.push(it);
    if (it.id !== null && !byId.has(String(it.id))) byId.set(String(it.id), it);
  }

  // Cycles are broken in document order: edges are accepted one at a time as written, and an edge
  // whose target can already reach its source would close a loop, so it becomes a back edge. The
  // first-written direction of a loop is the one the layout follows — "retry" written after
  // "plan -> code -> test" curls back, rather than turning the pipeline around.
  const out = new Map(items.map((it) => [it, []]));
  const edges = [], skipped = [];
  for (const e of edgeNodes) {
    const ep = props(e);
    const a = byId.get(ref(ep.from)), b = byId.get(ref(ep.to));
    if (!a || !b) { skipped.push(e.id ?? null); continue; }
    const kind = a === b ? "self" : reaches(b, a, out) ? "back" : "forward";
    if (kind === "forward") out.get(a).push(b);
    edges.push({ id: e.id ?? null, node: e, a, b, kind, label: words(e.text), dashed: flag(ep.dashed) });
  }

  // Longest path from a source: a node's layer is one more than its deepest predecessor's.
  const indeg = new Map(items.map((it) => [it, 0]));
  for (const vs of out.values()) for (const v of vs) indeg.set(v, indeg.get(v) + 1);
  const queue = items.filter((it) => indeg.get(it) === 0);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of out.get(u)) {
      v.layer = Math.max(v.layer, u.layer + 1);
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  const layers = [];
  for (const it of items) (layers[it.layer] ??= []).push(it);

  // Room between layer i and i+1 for the widest label on an edge from layer i to layer i+1, with
  // enough clear line either side of it that the arrowhead is not buried under the label. An
  // edge that skips layers is routed round them (route below), so its label is not in this gap.
  const labelRoom = (i, across) => Math.max(0, ...edges
    .filter((e) => e.kind === "forward" && e.a.layer === i && e.b.layer === i + 1 && e.label)
    .map((e) => (across ? textWidth(e.label, 11) + 60 : 36)));

  if (dir === "right") {
    const colW = layers.map((l) => Math.max(...l.map((it) => it.w)));
    const colH = layers.map((l) => l.reduce((s, it) => s + it.h, 0) + G.nodeGap * (l.length - 1));
    const maxH = Math.max(0, ...colH);
    let x = 0;
    layers.forEach((l, i) => {
      let y = (maxH - colH[i]) / 2;
      for (const it of l) { it.x = x + (colW[i] - it.w) / 2; it.y = y; y += it.h + G.nodeGap; }
      x += colW[i] + Math.max(G.layerGap, labelRoom(i, true));
    });
  } else {
    const rowH = layers.map((l) => Math.max(...l.map((it) => it.h)));
    const rowW = layers.map((l) => l.reduce((s, it) => s + it.w, 0) + G.rowGap * (l.length - 1));
    const maxW = Math.max(0, ...rowW);
    let y = 0;
    layers.forEach((l, i) => {
      let x = (maxW - rowW[i]) / 2;
      for (const it of l) { it.x = x; it.y = y + (rowH[i] - it.h) / 2; x += it.w + G.rowGap; }
      y += rowH[i] + Math.max(G.layerGap - 8, 20 + labelRoom(i, false));
    });
  }

  route(edges, items, dir);

  // Fit the viewBox to everything drawn — boxes, sampled curves and labels — then shift it all to
  // start at the margin, so a loop above the first node or a label past the last is never cut.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y, hw = 0, hh = 0) => { x0 = Math.min(x0, x - hw); y0 = Math.min(y0, y - hh); x1 = Math.max(x1, x + hw); y1 = Math.max(y1, y + hh); };
  for (const it of items) { grow(it.x, it.y); grow(it.x + it.w, it.y + it.h); }
  for (const e of edges) {
    for (let i = 0; i <= 32; i++) grow(...bez(e.points, i / 32), 5, 5);
    if (e.label) grow(e.mid[0], e.mid[1], textWidth(e.label, 11) / 2 + 3, 9);
  }
  if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 0; }
  const dx = G.margin - x0, dy = G.margin - y0;
  for (const it of items) { it.x = r1(it.x + dx); it.y = r1(it.y + dy); }
  for (const e of edges) {
    e.points = e.points.map(([x, y]) => [r1(x + dx), r1(y + dy)]);
    e.mid = [r1(e.mid[0] + dx), r1(e.mid[1] + dy)];
  }
  const width = Math.ceil(x1 - x0 + 2 * G.margin), height = Math.ceil(y1 - y0 + 2 * G.margin);
  return { dir, width, height, nodes: items, edges, skipped };
}

function graph(n, ctx) {
  const p = props(n);
  const L = layoutGraph(n);
  const f = flow(p, "graph");
  const h = dim(p.h);
  // A container misplaced in a graph is drawn as itself, and anything attached under a box or an
  // edge is drawn too, all under the drawing in the order written: the way a table draws a child
  // that is not a tr. None of it is a box in the drawing, and none of it is dropped.
  const extras = kids(n).flatMap((c) => (LEAVES.has(typeOf(c)) ? kids(c) : [c]));
  const drawH = L.height + 2 * f.pad;
  // Without an `h` the box is exactly as tall as the drawing (and what is under it); with one,
  // the drawing fits inside it.
  const q = { ...p, h: h ?? (extras.length ? undefined : drawH) };
  const style = sizing(q, ctx, { basis: L.width + 2 * f.pad });
  const grows = h === "fill" || (!h && growOf(p.grow) && ctx.dir === "col");
  if (grows) style.push("min-height:120px");
  const mk = `mk${++ctx.run.seq}`;

  const edges = L.edges.map((e) => {
    const [a, b, c, d] = e.points;
    const path = `M${a[0]} ${a[1]}C${b[0]} ${b[1]} ${c[0]} ${c[1]} ${d[0]} ${d[1]}`;
    return open("g", e.node, ["g-edge", e.dashed && "dashed", e.kind !== "forward" && e.kind]) +
      `<path class="g-hit" d="${path}"/><path class="g-line" d="${path}" marker-end="url(#${mk})"/>` +
      "</g>";
  }).join("");
  // Labels go on after every line. A label's white outline hides the lines drawn before it, so
  // drawn with its own edge it hid nothing drawn later — the next edge out of the same node ran
  // straight through it ("342 targets" in the orchestration mock).
  // Each node owns exactly one data-id element, so the label points at its edge with data-for;
  // the canvas follows it, and clicking the words marks the edge they belong to.
  const labels = L.edges.filter((e) => e.label).map((e) =>
    `<text class="g-elabel"${e.node?.id != null ? ` data-for="${esc(String(e.node.id))}"` : ""} x="${e.mid[0]}" y="${e.mid[1]}" text-anchor="middle" dominant-baseline="central">${esc(e.label)}</text>`).join("");

  const nodes = L.nodes.map((it) => {
    const np = props(it.node);
    const shade = shadeOf(np.shade);
    const cx = r1(it.x + it.w / 2), cy = r1(it.y + it.h / 2);
    const box = it.shape === "circle"
      ? `<circle class="g-box circle" cx="${cx}" cy="${cy}" r="${r1(it.w / 2)}"/>`
      : `<rect class="g-box${it.shape === "pill" ? " pill" : ""}" x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" rx="${it.shape === "pill" ? r1(it.h / 2) : 4}"/>`;
    const block = it.lineH + it.subH;
    const ly = r1(it.sub ? cy - block / 2 + it.lineH / 2 : cy);
    const sy = r1(cy + block / 2 - it.subH / 2 + 1);
    return open("g", it.node, ["g-node", it.shape, it.bold && "bold", shade && shade !== "dark" && "sh-" + shade,
      (np.border === "dashed" || flag(np.dashed)) && "dashed"], [], ` data-layer="${it.layer}"`) + box +
      `<text class="g-label" x="${cx}" y="${ly}" font-size="${it.fs}" text-anchor="middle" dominant-baseline="central"${DATA}>${esc(it.label)}</text>` +
      (it.sub ? `<text class="g-sub" x="${cx}" y="${sy}" font-size="${it.sfs}" text-anchor="middle" dominant-baseline="central"${DATA}>${esc(it.sub)}</text>` : "") +
      "</g>";
  }).join("");

  // When the drawing is bigger than the box it is scaled down to fit, never scrolled: the canvas
  // is for looking at the whole thing and pointing at parts of it, and a node scrolled out of view
  // can be neither seen nor clicked. The svg is capped at its natural size so it is never scaled
  // up — a graph in a wide box stays at reading size, centred. `taller` / `wider` fix small text.
  const svg = `<svg viewBox="0 0 ${L.width} ${L.height}" preserveAspectRatio="xMidYMid meet" ` +
    `style="max-width:${L.width}px;max-height:${L.height}px" role="img" aria-label="graph">` +
    `<defs><marker id="${mk}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto">` +
    `<path class="g-arrow" d="M0 1L10 5L0 9z"/></marker></defs>${edges}${labels}${nodes}</svg>`;
  const fit = `<div class="gfit" style="inset:${f.pad}px">${svg}</div>`;
  if (!extras.length) return open("div", n, ["graph", ...f.classes], style) + fit + "</div>";
  // With something under it, the drawing gets its own box: its natural height when the graph is
  // as tall as its content, else whatever the things under it leave.
  const draw = typeof h === "number" || grows ? `flex:1 1 0px;min-height:${Math.min(drawH, 120)}px` : `height:${drawH}px`;
  const inner = { dir: "col", align: false, run: ctx.run };
  return open("div", n, ["graph", "gx", ...f.classes], style) + `<div class="gdraw" style="${draw}">${fit}</div>` +
    `<div class="gextra" style="padding:0 ${f.pad}px ${f.pad}px">${extras.map((c) => renderNode(c, inner)).join("")}</div></div>`;
}

// ---- screens -----------------------------------------------------------------------------

// The canvas and lint address a screen by its name; a screen not yet named falls back to its id.
const screenKey = (s) => words(s.text) || words(s.id);

const STATUS = `<div class="status"${IGN}><span>9:41</span><span class="sig"><i class="s1"></i><i class="s2"></i><i class="s3"></i><b></b></span></div>`;
const HOST = `<div class="host"${IGN}><i class="w1"></i><i class="w2"></i><i class="w3"></i><i class="w4"></i><i class="w2"></i><i class="w3"></i></div>`;

// One artboard. `n` is the screen node, or null for the implicit board that holds children the
// parser attached directly to the app — drawn under a faint note, never dropped.
function board(n, frame, children, run) {
  const p = n ? props(n) : {};
  const f = flow(p, "col", { gap: 0 });
  const w = dim(p.w), h = dim(p.h);
  const W = typeof w === "number" ? w : FRAMES[frame].w;
  const H = typeof h === "number" ? h : FRAMES[frame].h;
  const inner = { dir: "col", align: f.align, run };
  const body = children.map((c) => renderNode(c, inner)).join("");
  const bodyCls = cls(["body", ...f.classes]);
  const bodyStyle = f.style.join(";");
  const size = `width:${W}px;min-height:${H}px`;
  let art;
  if (frame === "phone") {
    // The status bar is part of the screen, so the screen's fill goes on the whole board.
    const tone = f.classes.filter((c) => c.startsWith("fill-"));
    const rest = cls(["body", ...f.classes.filter((c) => !c.startsWith("fill-"))]);
    art = `<div class="${cls(["board", "phone", ...tone])}" style="${size}">${STATUS}<div class="${rest}" style="${esc(bodyStyle)}">${body}</div></div>`;
  } else if (frame === "panel") {
    art = `<div class="board panel-host">${HOST}<div class="panel ${bodyCls}" style="${esc(size + ";" + bodyStyle)}">${body}</div></div>`;
  } else {
    art = `<div class="board web ${bodyCls}" style="${esc(size + ";" + bodyStyle)}">${body}</div>`;
  }
  if (!n) return `<section class="screen loose ${frame}"><div class="board-name"${IGN}>outside a screen</div>${art}</section>`;
  return open("section", n, ["screen", frame], [], ` data-screen="${esc(screenKey(n))}"`) +
    `<div class="board-name"${IGN}>${esc(words(n.text))}</div>${art}</section>`;
}

// ---- document ----------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;-webkit-font-smoothing:antialiased}
.mock,.board,.fill-light,.fill-mid{--ink:#111;--ink2:#666;--ink3:#aaa;--bg:#fff;--card:#fff;--soft:#f4f4f4;--mid:#e6e6e6;--line:#ddd;--edge:#aaa;--solid:#222;--on-solid:#fff;color:var(--ink)}
.mock{display:flex;flex-direction:column;align-items:flex-start;gap:56px;padding:40px;min-height:100vh}
.lane{display:flex;flex-wrap:wrap;gap:40px;align-items:flex-start}
.screen{display:flex;flex-direction:column;gap:8px;flex:none}
.board-name{font-size:12px;color:#aaa;min-height:17px}
.board{position:relative;display:flex;flex-direction:column;background:#fff;border:1px solid #ddd;border-radius:4px}
.board.phone{overflow:hidden}
.phone>.body{flex:1 1 auto}
.status{flex:none;height:36px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;font-size:12px;font-weight:600;color:var(--ink)}
.status .sig{display:flex;align-items:flex-end;gap:2px}
.status i{display:block;width:3px;background:currentColor}
.status .s1{height:4px}.status .s2{height:6px}.status .s3{height:8px}
.status b{display:block;width:20px;height:10px;margin-left:6px;border:1px solid currentColor;border-radius:3px}
.board.panel-host{flex-direction:row;background:#f4f4f4}
.host{width:200px;flex:none;padding:20px 16px;display:flex;flex-direction:column;gap:12px}
.host i{display:block;height:8px;background:#e6e6e6;border-radius:2px}
.host .w1{width:55%}.host .w2{width:90%}.host .w3{width:75%}.host .w4{width:40%}
.panel{background:#fff;border-left:1px solid #ddd}
.body,.col,.nested-screen{display:flex;flex-direction:column}
.row{display:flex;flex-direction:row}
.grid{display:grid}
.row>*{min-width:0}
.dv-col>*+*{border-top:1px solid var(--line);padding-top:var(--g)}
.dv-row>*+*{border-left:1px solid var(--line);padding-left:var(--g)}
.bordered{border:1px solid var(--line);border-radius:4px}
.fill-light{background:#f4f4f4;--bg:#f4f4f4}
.fill-mid{background:#e6e6e6;--bg:#e6e6e6;--mid:#ddd;--line:#aaa}
.fill-dark{background:#222;--bg:#222;--ink:#fff;--ink2:#ccc;--ink3:#999;--card:#222;--soft:#111;--mid:#666;--line:#666;--edge:#666;--solid:#fff;--on-solid:#111;color:var(--ink)}
.sz-xs{font-size:11px}.sz-s{font-size:12px}.sz-m{font-size:14px}
.sz-l{font-size:18px;line-height:1.3}
.sz-xl{font-size:24px;line-height:1.2;letter-spacing:-.01em}
.sz-xxl{font-size:34px;line-height:1.1;letter-spacing:-.02em}
.b{font-weight:600}
.t{color:var(--ink);overflow-wrap:anywhere}
.t.sh-mid{color:var(--ink2)}.t.sh-light{color:var(--ink3)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.t.pill{border:1px solid currentColor;border-radius:999px;padding:1px 10px;white-space:nowrap}
.t.under{border-bottom:2px solid currentColor;padding-bottom:4px}
.btn{display:block;flex:none;max-width:100%;padding:.5em 1.1em;border:1px solid var(--edge);border-radius:4px;background:var(--card);color:var(--ink);
  font-weight:500;line-height:1.3;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn.primary{background:var(--solid);border-color:var(--solid);color:var(--on-solid);font-weight:600}
.btn.ghost{background:none;border-color:transparent}
.inp{display:flex;flex-direction:column;gap:4px;color:var(--ink)}
.inp-label{font-size:.86em;color:var(--ink2)}
.inp-box{display:flex;align-items:center;gap:8px;min-height:2.6em;padding:0 .75em;border:1px solid var(--edge);border-radius:4px;background:var(--card);white-space:nowrap;overflow:hidden}
.inp-box>span{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ph{color:var(--ink3)}.v{color:var(--ink)}
.inp.area .inp-box{flex:1 1 auto;align-items:flex-start;min-height:6.4em;padding:.6em .75em;white-space:normal}
.inp.check,.inp.toggle{flex-direction:row;align-items:center;gap:10px}
.inp.toggle{justify-content:space-between}
.cb{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;border:1px solid var(--edge);border-radius:3px;background:var(--card)}
.cb.on{background:var(--solid);border-color:var(--solid)}
.tg-pill{flex:none;position:relative;width:34px;height:20px;border-radius:999px;background:var(--mid)}
.tg-pill.on{background:var(--solid)}
.tg-circle{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff}
.tg-pill.on .tg-circle{left:16px;background:var(--on-solid)}
.ic{flex:none;fill:none;stroke:var(--ink3);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.cb .ic{stroke:var(--on-solid);stroke-width:2}
.shp{display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:4px;font-size:12px}
.shp.f-light{background:var(--soft);border:1px solid var(--line);color:var(--ink3)}
.shp.f-mid{background:var(--mid);color:var(--ink2)}
.shp.f-dark{background:var(--solid);color:var(--ink3)}
.shp.pill{border-radius:999px}.shp.circle{border-radius:50%}
.shp>span{padding:0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.shp.circle>span{font-size:10px;padding:0 2px}
.ln{flex:none;background:var(--line)}
.ln.h{height:1px;align-self:stretch}.ln.v{width:1px;align-self:stretch}
.prog{display:flex;flex-direction:column;gap:6px}
.prog-label{font-size:12px;color:var(--ink2)}
.prog-track{display:block;height:6px;background:var(--mid);border-radius:3px;overflow:hidden}
.prog-bar{display:block;height:100%;background:var(--ink);border-radius:3px}
.chart{display:flex;flex-direction:column;gap:6px}
.ch-plot{display:block;width:100%}
.ch-grid{fill:none;stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.ch-bar{fill:var(--ink3)}
.ch-area{fill:var(--soft)}
.ch-line{fill:none;stroke:var(--ink);stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.ch-cap{font-size:12px;color:var(--ink2)}
.tb{overflow:hidden}
.tb table{width:100%;border-collapse:collapse}
.tb th{text-align:left;font-size:.86em;font-weight:600;color:var(--ink2);padding:6px 12px 8px 0;border-bottom:1px solid var(--line);white-space:nowrap}
.tb td{padding:8px 12px 8px 0;vertical-align:top;color:var(--ink);font-variant-numeric:tabular-nums}
.tb.dv tbody tr+tr td{border-top:1px solid var(--line)}
.tb tr.b td,.tb tr.b th{font-weight:600}
.tb tr.sh-mid td{color:var(--ink2)}.tb tr.sh-light td,.tb tr.sh-light th{color:var(--ink3)}
.nd{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:8px 14px;border:1px solid var(--edge);border-radius:4px;background:var(--card);text-align:center}
.nd.pill{border-radius:999px}.nd.circle{border-radius:50%;aspect-ratio:1}
.nd.bold{border-color:var(--ink);font-weight:600}.nd.dashed{border-style:dashed}
.nd.sh-mid{color:var(--ink2)}.nd.sh-light{color:var(--ink3);border-color:var(--line)}
.nd-s{font-size:.85em;font-weight:400;color:var(--ink2)}
.graph{position:relative}
.graph.gx{display:flex;flex-direction:column;gap:8px}
.gdraw{position:relative;flex:none}
.gextra{display:flex;flex-direction:column;gap:8px}
.gfit{position:absolute;display:flex;align-items:center;justify-content:center}
.gfit>svg{display:block;width:100%;height:100%;overflow:visible}
.g-box{fill:var(--card);stroke:var(--edge);stroke-width:1}
.g-label{fill:var(--ink)}.g-sub{fill:var(--ink2)}
.g-node.bold .g-box{stroke:var(--ink);stroke-width:1.5}
.g-node.bold .g-label{font-weight:600}
.g-node.dashed .g-box{stroke-dasharray:4 3}
.g-node.sh-mid .g-label{fill:var(--ink2)}
.g-node.sh-light .g-label,.g-node.sh-light .g-sub{fill:var(--ink3)}
.g-node.sh-light .g-box{stroke:var(--line)}
.g-line{fill:none;stroke:var(--ink2);stroke-width:1.25}
.g-edge.dashed .g-line{stroke-dasharray:5 4}
.g-hit{fill:none;stroke:#fff;stroke-opacity:0;stroke-width:12}
.g-arrow{fill:var(--ink2)}
.g-elabel{font-size:11px;fill:var(--ink2);paint-order:stroke;stroke:var(--bg);stroke-width:8px;stroke-linejoin:round}
.g-node.marked .g-box,.g-edge.marked .g-line{stroke:#111;stroke-width:2.5}
`;
// The palette is the greys FORMAT.md names (and white, for text on dark). It is set on the page
// and again on every artboard, so a fill on the app shades the page behind the artboards but
// never reaches into them: each one starts white with dark ink, whatever it sits on.
// The last rule is the one concession to the canvas: it outlines a marked element, and an
// outline does not draw on an svg <g>, so a marked graph node or edge darkens its stroke instead.

export function render(root, { title } = {}) {
  const run = { seq: 0 };
  let app = root && typeof root === "object" ? root : null;
  // Handed a screen or a lone subtree instead of an app: draw it inside an app that has no id.
  if (app && typeOf(app) !== "app") app = { type: "app", text: null, props: {}, children: [app] };
  const frame = app ? frameOf(app, "web") : "web";

  // Consecutive phone screens share a lane and sit side by side; web and panel screens stack.
  // Children of the app that are not screens are kept together on one implicit board.
  const blocks = [];   // { lane: [html] } | { html } | { loose: [node] }, in the order written
  let lane = null, loose = null;
  for (const c of kids(app)) {
    if (typeOf(c) === "screen") {
      loose = null;
      const f = frameOf(c, frame);
      const html = board(c, f, kids(c), run);
      if (f === "phone") { if (!lane) blocks.push({ lane: (lane = []) }); lane.push(html); }
      else { lane = null; blocks.push({ html }); }
    } else {
      lane = null;
      if (!loose) blocks.push({ loose: (loose = []) });
      loose.push(c);
    }
  }
  const html = blocks.map((b) => (b.lane ? `<div class="lane">${b.lane.join("")}</div>`
    : b.loose ? board(null, frame, b.loose, run)
    : b.html)).join("\n");

  const p = props(app);
  const f = flow(p, "col", { gap: 0 });
  const style = [];
  const gap = step(p.gap), pad = step(p.pad);
  if (gap !== null) style.push(`gap:${gap}px`);
  if (pad !== null) style.push(`padding:${pad}px`);
  const name = words(title) || words(app?.text) || "mock";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title>
<style>${CSS}</style></head>
<body>${open("main", app, ["mock", ...f.classes.filter((c) => c.startsWith("fill-"))], style)}
${html}
</main>
</body></html>
`;
}
