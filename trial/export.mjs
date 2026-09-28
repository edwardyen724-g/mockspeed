// export — what a person takes away from the mock.
//
//   exportHtml(root)     the mock as one file that opens on its own: every page stacked, a list of
//                        the pages at the top, the navigation linked to them, no editor script
//   builderPrompt(root)  Markdown for an AI site builder (Lovable, v0, Cursor…): a fixed header
//                        that says what this is and how to build it, then each page in order — what
//                        is on it, word for word, in order, with its emphasis. The .md download is
//                        the same text
//   fileName(root, ext)  "crumb-bakery.html"
//
// The prompt is written by code, not a model, so it is instant and it is faithful: every word and
// number on the mock is in it, quoted as written (trial/test/export.test.mjs checks 24 mocks,
// the ten eval apps among them). It is the spec carried forward, and the builder is told to write its own HTML — the mock
// draws almost everything with divs, which is right for a sketch and wrong for a site (SKILL.md
// Rule 5: the spec carries forward, the code never does).

import { render } from "./render.mjs";
import { find, index, shares } from "./tree.mjs";
import { frameOf } from "./words.mjs";

// ---- the file names ----------------------------------------------------------------------------
export const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export const fileName = (root, ext) => `${slug(root?.text) || "mock"}.${ext}`;

// ---- HTML --------------------------------------------------------------------------------------
export function exportHtml(root) {
  return render(root, { pages: true, links: navTexts(root) });
}

// ---- helpers -----------------------------------------------------------------------------------
const has = (s) => s != null && s !== true && s !== false && String(s).trim() !== "";
const q = (s) => `“${String(s).trim()}”`;
const flag = (v) => v === true || v === "true" || v === 1;
const num = (v) => { const x = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(x) ? x : null; };
const kids = (n) => (n?.children ?? []).filter((c) => c && typeof c === "object");
const LEAVES = new Set(["text", "button", "input", "shape", "line", "progress", "chart"]);
const LAYOUT = new Set(["row", "col", "grid"]);
const SIZES = { xs: "xs", s: "s", sm: "s", small: "s", m: "m", md: "m", l: "l", lg: "l", large: "l", xl: "xl", xxl: "xxl", "2xl": "xxl" };
const sizeOf = (p) => SIZES[String(p?.size ?? "m").toLowerCase()] ?? "m";
const shadeOf = (p) => { const s = String(p?.shade ?? "dark").toLowerCase(); return ["dark", "mid", "light"].includes(s) ? s : "dark"; };
const fillOf = (p) => { const f = p?.fill; if (f == null || f === false || f === "none") return null; return ["light", "mid", "dark"].includes(String(f)) ? String(f) : "light"; };
const boxed = (n) => fillOf(n.props) != null || flag(n.props?.border);

// Emphasis, as a person would say it: "huge, bold", "small, grey".
const SIZE_WORD = { xs: "tiny", s: "small", l: "large", xl: "extra large", xxl: "huge" };
const SHADE_WORD = { mid: "grey", light: "light grey" };
function emphasis(p = {}) {
  return [SIZE_WORD[sizeOf(p)], flag(p.bold) && "bold", SHADE_WORD[shadeOf(p)], flag(p.mono) && "monospace", flag(p.under) && "underlined"].filter(Boolean);
}
const em = (s, list) => { const l = list.filter(Boolean); return l.length ? `${s} (${l.join(", ")})` : s; };

// ---- one thing on the page ---------------------------------------------------------------------
// A leaf as one line: “Bread baked every morning at 5” (huge, bold) · Button “Order now” (primary).
function leaf(n) {
  const p = n.props ?? {}, t = has(n.text) ? q(n.text) : "";
  switch (n.type) {
    case "text":
      if (!t) return null;
      return em(flag(p.pill) ? `Tag ${t}` : t, emphasis(p));
    case "button":
      return em(`Button${t ? " " + t : ""}`, [flag(p.primary) && "primary", flag(p.ghost) && "text only", ...emphasis(p), p.w === "fill" && "full width"]);
    case "input": {
      const kind = flag(p.check) ? "Checkbox" : flag(p.toggle) ? "Switch" : flag(p.select) ? "Dropdown" : flag(p.search) ? "Search box" : flag(p.area) ? "Text box" : "Field";
      let s = `${kind}${t ? " " + t : ""}`;
      if (has(p.value)) s += flag(p.select) ? `, showing ${q(p.value)}` : `, filled in with ${q(p.value)}`;
      if (flag(p.check) || flag(p.toggle)) s += flag(p.on) ? ", on" : ", off";
      return s;
    }
    case "shape": {
      const w = num(p.w), h = num(p.h), fill = fillOf(p) ?? "light";
      if (flag(p.circle) && w != null && w <= 16) return em(`Dot${t ? " " + t : ""}`, [{ dark: "dark", mid: "grey", light: "light" }[fill]]);
      if (flag(p.circle)) return `Round picture${t ? " " + t : ""}`;
      return em(`Picture${t ? " of " + t : ""}`, [h != null && h >= 240 && "tall", fill === "dark" && "dark"]);
    }
    case "line": return "Divider";
    case "progress": return `Progress bar${t ? " " + t : ""}${num(p.value) != null ? `, ${num(p.value)}% done` : ""}`;
    case "chart": {
      const vals = String(p.values ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      return `${flag(p.line) ? "Line" : "Bar"} chart${t ? " " + t : ""}${vals.length ? `, values ${vals.join(", ")}` : ""}`;
    }
  }
  return t || null;
}

// Short enough to say on one line: a card's picture, name, price and button ("Picture · “Sourdough”
// (large, bold) · “$6.00” · Button “Add”"), and in a row a small stack of words, said with "over"
// ("“Alex” (bold) over “owes $600” (tiny, grey)").
const bare = (c) => LEAVES.has(c.type) && !kids(c).length;
const stack = (c) => c.type === "col" && !boxed(c) && kids(c).length >= 2 && kids(c).length <= 3 && kids(c).every(bare);
const oneLine = (n, ctx) => {
  const k = kids(n);
  return k.length > 0 && k.length <= 6 && !k.some((c, i) => linkRun(k, i, ctx)) && k.every((c) => bare(c) || (n.type === "row" && stack(c)));
};
const joined = (n) => kids(n).map((c) => (bare(c) ? leaf(c) : kids(c).map(leaf).filter(Boolean).join(" over "))).filter(Boolean).join(" · ");

// Links or tabs: three or more short texts of one size, one of them the current one (bold, or
// underlined) and the rest grey — how the writer composes navigation (writer.mjs COMPOSE). Found as
// a run among siblings, so a side nav with the app's name above its links still has them. A
// label over its value, or a stat's number between two grey lines, differs in size and is not one.
// And they are links only where navigation is: in a bar shared across pages, as tabs (underlined),
// or naming two of the pages — an address in bold over its grey lines has the same look.
const linky = (c) => c?.type === "text" && has(c.text) && String(c.text).trim().split(/\s+/).length <= 4;
const on = (c) => flag(c.props?.bold) || flag(c.props?.under);
function linkRun(k, i, ctx) {
  if (!linky(k[i])) return null;
  const size = sizeOf(k[i].props);
  let j = i;
  while (j < k.length && linky(k[j]) && sizeOf(k[j].props) === size && (on(k[j]) || shadeOf(k[j].props) !== "dark")) j++;
  const run = k.slice(i, j);
  const current = run.filter(on);
  const tabs = run.some((c) => flag(c.props?.under));
  if (current.length !== 1 || run.length < (tabs ? 2 : 3)) return null;
  const pages = run.filter((c) => ctx.pages?.has(String(c.text).trim().toLowerCase())).length;
  if (!ctx.inShared && !tabs && pages < 2) return null;
  return { run, current: String(current[0].text).trim(), tabs };
}
function linkLine(l, ctx) {
  const items = l.run.map((c) => String(c.text).trim()).map((w) => (ctx.noCurrent || w !== l.current ? q(w) : `${q(w)} (current)`));
  return `${l.tabs ? "Tabs" : "Links"}: ${items.join(", ")}`;
}
// Where the links are in a shared bar: [{ path, from, to }], path the child indexes down to their
// container. Read from the first copy, so that in every copy the current link is looked for among
// the links themselves — a nav's bold group heading ("Pipeline", above "Leads · Active · Closed")
// is not a link, even on a page where none of the links is bold.
function linkSlots(n, path = []) {
  const k = kids(n), out = [];
  for (let i = 0; i < k.length;) {
    const l = linkRun(k, i, { inShared: true });
    if (l) { out.push({ path, from: i, to: i + l.run.length }); i += l.run.length; } else i++;
  }
  k.forEach((c, i) => out.push(...linkSlots(c, [...path, i])));
  return out;
}
function currentIn(copy, slots) {
  for (const { path, from, to } of slots) {
    let box = copy;
    for (const i of path) box = kids(box)[i];
    const lit = kids(box).slice(from, to).filter((c) => linky(c) && on(c));
    if (lit.length === 1) return String(lit[0].text).trim();
  }
  return null;
}

// A run of the same thing: the cards of a grid, the items of a list.
const kindsIn = (n) => kids(n).map((c) => c.type).join(",");
function isList(n, ctx) {
  const k = kids(n);
  if (n.type === "grid") return k.length > 0;
  if (k.length < 3) return false;
  // Links among them are said as links (each()), whatever else is there.
  if (k.some((c, i) => linkRun(k, i, ctx))) return false;
  // Words are a list when they look alike: a stat card's label, number and note differ in size.
  return k.every((c) => c.type === k[0].type && (LEAVES.has(c.type) ? sizeOf(c.props) === sizeOf(k[0].props) : kindsIn(c) === kindsIn(k[0])));
}
// A wrapper with nothing of its own around one thing is that thing.
function unwrap(n) {
  while (LAYOUT.has(n.type) && !boxed(n) && kids(n).length === 1 && LAYOUT.has(kids(n)[0].type)) n = kids(n)[0];
  return n;
}

// What a group is called: a card has an outline, a panel a background; a bar is a panel across.
function groupNoun(n) {
  const fill = fillOf(n.props);
  const base = fill == null ? "Card" : n.type === "row" ? "Bar" : "Panel";
  return em(base, [fill === "dark" && "dark background", (fill === "mid" || (fill === "light" && base === "Card")) && "shaded"]);
}

// ---- a part of a page, as indented bullets --------------------------------------------------------
// `ctx`: { shared: Map copy id → how the page refers to it, inRow, noCurrent }
function lines(n, depth, ctx) {
  const out = [];
  const put = (s, d = depth) => out.push(`${"  ".repeat(d)}- ${s}`);

  if (ctx.shared.has(n.id)) {
    const ref = ctx.shared.get(n.id);
    if (ref.inline) { put(`${ref.label}:`); out.push(...each(kids(n), depth + 1, { ...ctx, inRow: n.type === "row", inShared: true })); }
    else put(ref.label);
    return out;
  }
  if (LEAVES.has(n.type)) {
    const s = leaf(n);
    if (s) put(s);
    for (const c of kids(n)) out.push(...lines(c, depth, ctx));
    return out;
  }
  if (n.type === "table") return table(n, depth);
  if (n.type === "graph") return graph(n, depth);
  if (!LAYOUT.has(n.type) && n.type !== "screen") { if (has(n.text)) put(q(n.text)); return out; }

  const k = kids(n);
  if (!k.length) return out;
  ctx = { ...ctx, inShared: ctx.inShared || Boolean(ctx.copies?.has(n)) };
  const inner = { ...ctx, inRow: n.type === "row" };
  const whole = linkRun(k, 0, ctx);
  if (whole && whole.run.length === k.length) { put(boxed(n) ? `${groupNoun(n)}: ${linkLine(whole, ctx)}` : linkLine(whole, ctx)); return out; }

  // A card of a few lines — an address, a stat — is said on one line, not as a list of them.
  if (boxed(n) && oneLine(n, ctx)) { put(`${groupNoun(n)}${n.type === "row" ? ", side by side" : ""}: ${joined(n)}`); return out; }

  if (isList(n, ctx)) {
    const items = k.map(unwrap);
    const cards = items.every((c) => LAYOUT.has(c.type) && boxed(c));
    const cols = n.type === "grid" ? Math.max(1, Math.round(num(n.props?.cols) ?? 3)) : null;
    const head = cards ? `${k.length} cards` : n.type === "grid" ? `Grid of ${k.length}` : `List of ${k.length}`;
    const across = cols ? `, ${cols} across` : n.type === "row" ? ", side by side" : "";
    put(boxed(n) ? `${groupNoun(n)} with a list of ${k.length}${across}:` : `${head}${across}:`);
    for (const c of items) {
      if (!LAYOUT.has(c.type)) out.push(...lines(c, depth + 1, inner));
      else if (oneLine(c, ctx)) put(`${cards ? `${groupNoun(c)}: ` : c.type === "row" ? "Side by side: " : ""}${joined(c)}`, depth + 1);
      else { put(`${cards ? groupNoun(c) : "Item"}${c.type === "row" ? ", side by side" : ""}:`, depth + 1); out.push(...each(kids(c), depth + 2, { ...ctx, inRow: c.type === "row" })); }
    }
    return out;
  }

  if (boxed(n)) {
    if (oneLine(n, ctx)) { put(`${groupNoun(n)}${n.type === "row" ? ", side by side" : ""}: ${joined(n)}`); return out; }
    put(`${groupNoun(n)}${n.type === "row" ? ", side by side" : ""}:`);
    out.push(...each(k, depth + 1, inner));
    return out;
  }

  // Nothing to see of its own: a row says what sits side by side, a column in a row is one of the
  // columns, and any other column is only the order things come in.
  if (k.length === 1) return lines(k[0], depth, ctx);
  if (n.type === "row") {
    if (oneLine(n, ctx)) { put(`Side by side: ${joined(n)}`); return out; }
    put("Side by side:");
    out.push(...each(k, depth + 1, inner));
    return out;
  }
  if (n.type === "grid") {
    put(`Grid, ${Math.max(1, Math.round(num(n.props?.cols) ?? 3))} across:`);
    out.push(...each(k, depth + 1, inner));
    return out;
  }
  if (ctx.inRow) {
    if (stack(n)) { put(joined({ type: "row", children: [n] })); return out; }
    put("Column:");
    out.push(...each(k, depth + 1, inner));
    return out;
  }
  out.push(...each(k, depth, inner));
  return out;
}

// Siblings in order, a run of links among them said as one line.
function each(k, depth, ctx) {
  const out = [];
  for (let i = 0; i < k.length;) {
    const l = linkRun(k, i, ctx);
    if (l) { out.push(`${"  ".repeat(depth)}- ${linkLine(l, ctx)}`); i += l.run.length; continue; }
    out.push(...lines(k[i], depth, ctx));
    i++;
  }
  return out;
}

function table(n, depth) {
  const out = [];
  const put = (s, d) => out.push(`${"  ".repeat(d)}- ${s}`);
  const rows = kids(n).filter((c) => c.type === "tr");
  const cells = (tr) => String(tr.text ?? "").split("|").map((c) => c.trim()).map((c) => (c ? q(c) : "(empty)")).join(" | ");
  put("Table:", depth);
  rows.forEach((tr, i) => put(i === 0 ? `Columns: ${cells(tr)}` : em(cells(tr), emphasis({ ...tr.props, size: "m" })), depth + 1));
  for (const c of kids(n)) if (c.type !== "tr") out.push(...lines(c, depth + 1, { shared: new Map() }));
  return out;
}

function graph(n, depth) {
  const out = [];
  const put = (s, d) => out.push(`${"  ".repeat(d)}- ${s}`);
  const k = kids(n);
  const nodes = k.filter((c) => c.type === "node");
  const byId = new Map(nodes.map((c) => [String(c.id), c]));
  const ref = (v) => byId.get(String(v ?? "").replace(/^#/, ""));
  const dir = String(n.props?.dir ?? "right") === "down" ? "top to bottom" : "left to right";
  put(`Diagram, flowing ${dir}:`, depth);
  for (const c of nodes) {
    const p = c.props ?? {};
    const s = `${has(c.text) ? q(c.text) : "A step"}${has(p.sub) ? ` with ${q(p.sub)} under it` : ""}`;
    put(em(`Step ${s}`, [...emphasis({ ...p, size: "m" }), p.border === "dashed" && "dashed", flag(p.pill) && "rounded", flag(p.circle) && "round"]), depth + 1);
  }
  for (const c of k.filter((x) => x.type === "edge")) {
    const a = ref(c.props?.from), b = ref(c.props?.to);
    if (!a || !b) { if (has(c.text)) put(`Arrow ${q(c.text)}`, depth + 1); continue; }
    put(em(`Arrow from ${q(a.text ?? "a step")} to ${q(b.text ?? "a step")}${has(c.text) ? `, labelled ${q(c.text)}` : ""}`, [flag(c.props?.dashed) && "dashed"]), depth + 1);
  }
  for (const c of k) if (c.type !== "node" && c.type !== "edge") out.push(...lines(c, depth + 1, { shared: new Map() }));
  return out;
}

// ---- shared bars -----------------------------------------------------------------------------------
// The copies of each shared element, as the export treats them: the innermost ones. A writer that
// puts share=nav on the side nav and again on the row holding it beside the whole page has shared
// the page; what repeats is the side nav. Map name → [copy roots], in document order.
function sharedCopies(root) {
  const out = new Map();
  for (const [name, copies] of shares(root)) {
    out.set(name, copies.filter((c) => !copies.some((d) => d !== c && index(c).some((x) => x.node === d))));
  }
  return out;
}

// The navigation's page names, for the HTML export to link: the texts the prompt calls links
// (linkRun) that name a page.
function navTexts(root) {
  const pages = new Set(kids(root).filter((c) => c.type === "screen").map((s) => String(s.text ?? "").trim().toLowerCase()).filter(Boolean));
  const copies = new Set([...sharedCopies(root).values()].flat());
  const out = new Set();
  const walk = (n, inShared) => {
    inShared = inShared || copies.has(n);
    const k = kids(n);
    for (let i = 0; i < k.length; i++) {
      const l = linkRun(k, i, { inShared, pages });
      if (!l) continue;
      for (const c of l.run) if (pages.has(String(c.text).trim().toLowerCase())) out.add(c.id);
      i += l.run.length - 1;
    }
    for (const c of k) walk(c, inShared);
  };
  walk(root, false);
  return out;
}

// What a shared element is, from where it sits on its page: a top bar, a bottom bar, a side nav.
function roleOf(root, copy, phone) {
  const h = find(root, copy.id);
  const par = h?.parent;
  if (!par) return "shared part";
  const sibs = kids(par);
  if (copy.type === "col" && par.type === "row") return "side navigation";
  const first = h.index === 0, last = h.index === sibs.length - 1;
  if (first) return "top bar";
  if (last) return phone ? "tab bar" : "bottom bar";
  return "shared part";
}
const wordsOf = (n) => index(n).map((x) => `${x.node.type}:${x.node.text ?? ""}:${x.node.props?.value ?? ""}`).join("\n");

// ---- the prompt --------------------------------------------------------------------------------------
export function builderPrompt(root) {
  const frame = frameOf(root);
  const page = frame === "web" ? "page" : "screen";
  const Page = page[0].toUpperCase() + page.slice(1);
  const screens = kids(root).filter((c) => c.type === "screen");
  const loose = kids(root).filter((c) => c.type !== "screen");
  const name = has(root?.text) ? String(root.text).trim() : "Untitled";
  const noun = { web: "a website", phone: "a phone app", panel: "a browser side panel" }[frame];
  const count = `${screens.length} ${page}${screens.length === 1 ? "" : "s"}`;
  const pages = new Set(screens.map((s) => String(s.text ?? "").trim().toLowerCase()).filter(Boolean));

  const out = [
    `# ${name}`,
    "",
    `This is a greyscale wireframe of ${noun} with ${count}${screens.length ? `: ${screens.map((s) => q(s.text ?? "")).join(", ")}` : ""}. Build it for real:`,
    "",
    "- Semantic HTML: header, nav, main, section, footer; one h1 per page; forms with labels; input types that fit (tel, date, email); buttons for actions and links for navigation; images with alt text.",
    "- Responsive and accessible, with your own visual design.",
    `- Keep the ${page}s, what is on each one, the order, and the emphasis: bigger, bolder and darker means more important.`,
    "- Keep every word and number as written.",
    "- Each picture is a grey box in the wireframe: source a real one that shows what its words say.",
    "- Do not copy the wireframe's HTML or styles.",
    "",
    `Below, each ${page} is listed top to bottom. Words in “quotes” are exactly what it says.`,
  ];

  // Each shared element once, before the pages, when it is on more than one of them; on each page, a
  // line that points back at it and says which link is current there. A copy whose words differ
  // from the first (a page with one item more) is written out in full where it is.
  const shared = new Map();
  const screenOf = new Map(index(root).map((x) => [x.id, x.screen]));
  const byName = sharedCopies(root);
  const copySet = new Set([...byName.values()].flat());
  for (const copies of byName.values()) {
    if (copies.length < 2) continue;
    const first = copies[0];
    const role = roleOf(root, first, frame === "phone");
    const on = [...new Set(copies.map((c) => screenOf.get(c.id)).filter(Boolean))];
    const where = on.length === screens.length ? `on every ${page}` : `on the ${on.map(q).join(" and ")} ${page}s`;
    const slots = linkSlots(first);
    out.push("", `## The ${role}, ${where}`, "");
    if (slots.length) out.push(`On each ${page}, the link to that ${page} is shown as the current one.`, "");
    out.push(...lines(first, 0, { shared: new Map(), noCurrent: true, inShared: true, pages, copies: copySet }));
    for (const c of copies) {
      const here = currentIn(c, slots);
      const same = wordsOf(c) === wordsOf(first);
      const label = `The ${role} (as above)${here ? `, with ${q(here)} current` : ""}`;
      shared.set(c.id, same ? { label } : { label: `The ${role}, with ${here ? `${q(here)} current and ` : ""}these words on this ${page}`, inline: true });
    }
  }

  screens.forEach((s, i) => {
    out.push("", `## ${Page} ${i + 1} of ${screens.length}: ${has(s.text) ? String(s.text).trim() : "Untitled"}`, "");
    const h1 = mainWords(s, shared);
    if (h1) out.push(`The h1: ${q(h1)}`, "");
    const body = lines(s, 0, { shared, pages, copies: copySet });
    out.push(...(body.length ? body : ["- Nothing on it yet"]));
  });
  if (loose.length) {
    out.push("", `## Not on any ${page}`, "");
    for (const c of loose) out.push(...lines(c, 0, { shared, pages, copies: copySet }));
  }
  return out.join("\n") + "\n";
}

// The words a page is about: its biggest, boldest, darkest text outside the shared bars — what the
// writer is told to make of the one thing a page is for (writer.mjs APP). None when nothing on the
// page is bigger than body text.
function mainWords(screen, shared) {
  const RANK = { xs: 0, s: 1, m: 2, l: 3, xl: 4, xxl: 5 };
  let best = null, score = -1;
  const visit = (n) => {
    if (shared.has(n.id)) return;
    if (n.type === "text" && has(n.text)) {
      const p = n.props ?? {};
      const s = RANK[sizeOf(p)] * 4 + (flag(p.bold) ? 2 : 0) + ({ dark: 1, mid: 0, light: 0 }[shadeOf(p)]);
      if (s > score) { score = s; best = String(n.text).trim(); }
    }
    for (const c of kids(n)) if (n.type !== "table" && n.type !== "graph") visit(c);
  };
  visit(screen);
  return score >= RANK.l * 4 ? best : null;
}
