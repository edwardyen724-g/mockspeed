// words — every string a person reads, in one place (docs/plan-web-2026-09-26.md §2).
//
// The trial talks to two readers. Jev and the writer read tree.mjs's lines — `text #n9 "$340.50"
// bold xl`, "in col · border · holds text, text, line" — and Jev's measured accuracy rests on that
// wording, so it stays. The person reads this module, and nothing else writes to them: things are
// named by what is on them ("the “Order now” button", "the “You are owed” card", "“$28.50”"), places
// by what is visible around them ("under “Address”", "at the top of the “Visit us” page"), and a
// website has pages where a phone app has screens. Scores, timings and model names are not here;
// the page shows those only with ?debug=1.
//
// trial/test/words.test.mjs renders every template below against the ten eval apps and fails on
// any engine word outside quotes (BANNED). A person's own words, and the mock's, sit inside “ ”:
// a settings page may well say “Border color”.

import { parse, find, index, shapeOf, sectionsOf } from "./tree.mjs";

// ---- the words a person must never see --------------------------------------------------------
// Checked outside “quoted” spans. "screen" is banned only in a website, where it is a page.
export const BANNED = [
  "col", "cols", "row", "rows", "node", "nodes", "element", "elements", "tier", "holds", "gap", "gaps",
  "border", "bordered", "shade", "fill", "pad", "grow", "outline", "spec", "jev", "haiku", "sonnet",
  "claude", "writer", "tree", "props", "anchor", "inside_start", "inside_end", "confidence", "px",
];
export const BANNED_WEB = ["screen", "screens"];

// ---- helpers ------------------------------------------------------------------------------
const clip = (s, n = 40) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const q = (s) => `“${clip(String(s).replace(/[“”]/g, '"').trim())}”`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const has = (s) => s != null && String(s).trim() !== "";
const wordy = (s) => has(s) && /[\p{L}\p{N}]/u.test(String(s));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const LAYOUT = new Set(["row", "col", "grid"]);
const boxed = (n) => n.props?.fill != null && n.props?.fill !== "none" || !!n.props?.border;
const listy = (n) => /^a list of/.test(shapeOf(n));

// What a website calls a screen. A phone app and a side panel have screens.
export function frameOf(root) {
  const p = root?.props ?? {};
  for (const f of ["phone", "panel", "web"]) if (p[f] === true || p.frame === f) return f;
  return "web";
}
export const pageWord = (root) => (frameOf(root) === "web" ? "page" : "screen");
export const pagesWord = (root, n) => plural(n, pageWord(root));
export function pageName(root, screen) {
  return has(screen) ? `the ${q(screen)} ${pageWord(root)}` : `this ${pageWord(root)}`;
}

// The words on a node: its own, a table row's cells, then whatever is inside it, in reading order.
function ownWords(n) {
  if (n.type === "tr") return String(n.text ?? "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ");
  if (n.type === "edge") return has(n.text) ? String(n.text) : "";
  if (n.type === "input" && !has(n.text) && has(n.props?.value)) return String(n.props.value);
  return has(n.text) ? String(n.text) : "";
}
function wordsIn(n, max = 3) {
  const out = [];
  const visit = (x) => {
    if (out.length >= max) return;
    const w = ownWords(x);
    if (x !== n && wordy(w) && !out.includes(w)) out.push(w);
    for (const c of x.children ?? []) visit(c);
  };
  visit(n);
  return out;
}
const firstWords = (n) => (wordy(ownWords(n)) ? ownWords(n) : wordsIn(n, 1)[0] ?? "");
// A group by what its parts start with: "Visit Us · Hours · Location" for a heading over a card that
// holds an Hours block and a Location block — where the first three words inside it would stop at
// "Visit Us · Hours · Mon – Fri", and a person looking for the address would not find it named.
const holdsGroups = (n) => (n.children ?? []).some((c) => LAYOUT.has(c.type));
function headings(n, max = 3) {
  const out = [];
  for (const c of n.children ?? []) {
    for (const w of LAYOUT.has(c.type) && holdsGroups(c) ? headings(c, max) : [firstWords(c)]) if (wordy(w) && !out.includes(w)) out.push(w);
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// ---- naming a thing --------------------------------------------------------------------------
const INPUTS = [["check", "checkbox"], ["toggle", "switch"], ["select", "dropdown"], ["search", "search box"], ["area", "text box"]];
const inputNoun = (p) => INPUTS.find(([k]) => p?.[k])?.[1] ?? "field";

// A thing on the mock, the way a person would point at it. Lower case; cap() it to start a sentence.
export function name(root, idOrNode, { bare = false } = {}) {
  // A node object is one not on the mock yet (a written piece): it has no neighbours to go by, and
  // its ids are its own, so nothing is looked up by them.
  const loose = typeof idOrNode === "object" && idOrNode;
  const h = loose ? { node: idOrNode, parent: null, index: -1, loose: true } : find(root, idOrNode);
  if (!h) return "that";
  // `bare`: no "under …" for a thing with no words, where the sentence already says where it is.
  const at = () => (bare ? "" : where(root, h));
  const n = h.node, p = n.props ?? {}, own = ownWords(n);
  switch (n.type) {
    case "app": return has(n.text) ? q(n.text) : "this app";
    case "screen": return pageName(root, n.text);
    case "text": return has(own) ? q(own) : `some words ${at()}`.trim();
    case "button": return has(own) ? `the ${q(own)} button` : `a button ${at()}`.trim();
    case "input": {
      // "the “Search” box", not "the “Search” search box".
      const noun = inputNoun(p).split(" ").filter((w, i, all) => !(all.length > 1 && i === 0 && own.toLowerCase().includes(w))).join(" ");
      return has(own) ? `the ${q(own)} ${noun}` : `a ${inputNoun(p)} ${at()}`.trim();
    }
    case "shape": {
      const noun = p.circle ? (Number(p.w) > 0 && Number(p.w) <= 16 ? "dot" : "circle") : "picture";
      return has(own) ? `the ${q(own)} ${noun}` : `a ${noun} ${at()}`.trim();
    }
    case "line": return `the divider ${at()}`.trim();
    case "progress": return has(own) ? `the ${q(own)} progress bar` : `a progress bar ${at()}`.trim();
    case "chart": return has(own) ? `the ${q(own)} chart` : `a ${p.line ? "line" : "bar"} chart ${at()}`.trim();
    case "tr": return has(own) ? q(own) : "an empty line of the table";
    case "node": return has(own) ? q(own) : "a step in the diagram";
    case "edge": {
      const from = h.loose ? null : find(root, p.from)?.node, to = h.loose ? null : find(root, p.to)?.node;
      const ends = from && to ? ` from ${q(firstWords(from) || "?")} to ${q(firstWords(to) || "?")}` : "";
      return has(own) ? `the ${q(own)} arrow${ends}` : `the arrow${ends}`;
    }
    case "table": {
      const head = n.children?.[0];
      return head && wordy(ownWords(head)) ? `the table ${q(ownWords(head))}` : "the table";
    }
    case "graph": {
      const w = (n.children ?? []).filter((c) => c.type === "node").map(ownWords).filter(wordy).slice(0, 3);
      return w.length ? `the diagram ${q(w.join(" · "))}` : "the diagram";
    }
  }
  return group(root, h, at);
}

// A group of things: a list by its first items, a card, bar or panel by its first words, and
// anything else by the words in it. An item of a list is named by its own words.
function group(root, h, at) {
  const n = h.node;
  const inList = h.parent && listy(h.parent);
  if (boxed(n)) {
    // A bar or a panel is named by its first few words ("the “Home · Add · Friends” bar"), a card
    // by its first ("the “You are owed” card").
    // A panel is a whole part of the screen with a background (a side nav); anything smaller that
    // is filled or outlined is a card.
    const noun = inList ? "card" : n.type === "row" ? "bar" : n.props?.fill != null && n.props.fill !== "none" && !h.loose && isSection(root, n.id) ? "panel" : "card";
    const w = noun === "card" && !holdsGroups(n) ? [firstWords(n)].filter(wordy) : headings(n);
    return w.length ? `the ${q(w.join(" · "))} ${noun}` : `a ${noun} ${at()}`.trim();
  }
  if (listy(n)) {
    const items = [...new Set((n.children ?? []).map(firstWords).filter(wordy))].slice(0, 3);
    const noun = n.type === "grid" || n.children.every((c) => LAYOUT.has(c.type) && boxed(c)) ? "cards" : "list";
    return items.length ? `the ${noun} ${q(items.join(" · "))}` : `the ${noun} ${at()}`.trim();
  }
  // An item of a list is named by all its words ("Rent · You paid $1200"); a part of the page by
  // what its parts start with.
  if (inList) { const w = wordsIn(n); if (w.length) return q(w.join(" · ")); }
  const w = headings(n);
  return w.length ? `the part with ${q(w.join(" · "))}` : `an empty part ${at()}`.trim();
}

function isSection(root, id) {
  const screen = index(root).find((n) => n.id === id)?.screen;
  const s = (root.children ?? []).find((c) => c.type === "screen" && c.text === screen);
  return Boolean(s && sectionsOf(root, s.id).some((x) => x.id === id));
}

// Where a thing with no words of its own is: beside the nearest neighbour that has some, or in
// whatever holds it.
function where(root, h) {
  const par = h.parent;
  if (!par) return "";
  const sibs = par.children ?? [];
  const across = par.type === "row";
  for (let d = 1; d < sibs.length; d++) {
    for (const j of [h.index - d, h.index + d]) {
      const s = sibs[j];
      const w = s ? firstWords(s) : "";
      if (!wordy(w)) continue;
      return `${j < h.index ? (across ? "right of" : "under") : (across ? "left of" : "above")} ${q(w)}`;
    }
  }
  if (par.type === "screen") return `on ${pageName(root, par.text)}`;
  const up = find(root, par.id);
  return up ? `in ${up.node.type === "app" ? "the app" : name(root, par.id)}` : "";
}

// ---- naming a place ----------------------------------------------------------------------------
// A place a new piece can go, or a moved thing can go to, from its structure alone: { anchor,
// position } for a spot, { into } for somewhere inside. The same shapes tree.mjs gives Jev, with
// the words a person reads. `skip` holds a thing being moved, which is not its own neighbour;
// `now` names the place it is in, which an offer made after the move calls "where it was".
export function place(root, g, skip = new Set(), now = "where it is now") {
  if (g.into != null) return `somewhere in ${name(root, g.into)}`;
  const h = find(root, g.anchor);
  if (!h) return "there";
  const n = h.node;
  if (n.type === "app") return `as the first ${pageWord(root)}`;
  if (n.type === "screen" && g.position === "after") {
    const last = (h.parent?.children ?? []).filter((c) => c.type === "screen").pop() === n;
    return `after ${pageName(root, n.text)}${last ? ", at the end" : ""}`;
  }
  const kids = (c) => (c.children ?? []).filter((k) => !skip.has(k.id));
  const at = nowAt(root, skip);
  const here = at && at.anchor === g.anchor && at.position === g.position ? ` (${now})` : "";
  if (g.position === "inside_start" || g.position === "inside_end") {
    const across = n.type === "row";
    if (n.type === "graph") return `in ${name(root, n.id)}${here}`;
    if (n.type === "screen") return `at the ${g.position === "inside_start" ? "top" : "bottom"} of ${pageName(root, n.text)}${here}`;
    if (!kids(n).length) return `in ${name(root, n.id)}${here}`;
    const end = g.position === "inside_start" ? (across ? "left end" : "top") : (across ? "right end" : "bottom");
    return `at the ${end} of ${name(root, n.id)}${here}`;
  }
  const across = h.parent?.type === "row";
  if (g.position === "after") {
    const sibs = h.parent ? kids(h.parent) : [];
    const next = sibs[sibs.indexOf(n) + 1];
    if (next) return `between ${name(root, n.id, { bare: true })} and ${name(root, next.id, { bare: true })}${here}`;
    return `${across ? "right of" : "under"} ${name(root, n.id)}${here}`;
  }
  if (g.position === "before") return `${across ? "left of" : "above"} ${name(root, n.id)}${here}`;
  if (g.position === "replace") return `in place of ${name(root, n.id)}`;
  return "there";
}

// Where a thing being moved sits now, as the place tree.mjs would offer for it.
function nowAt(root, skip) {
  if (skip.size !== 1) return null;
  const h = find(root, [...skip][0]);
  if (!h?.parent) return null;
  const all = h.parent.children;
  if (h.index === 0) return { anchor: h.parent.id, position: "inside_start" };
  if (h.index === all.length - 1) return { anchor: h.parent.id, position: "inside_end" };
  return { anchor: all[h.index - 1].id, position: "after" };
}

// The first thing a written piece draws, named before it is on the mock: "a “Call us” button",
// "the “Settings” page". The piece is parsed on its own, so it sits in a page the parser made up.
export function pieceName(root, text) {
  const top = String(text ?? "").split("\n").find((l) => l.trim() && !/^\s*\/\//.test(l)) ?? "";
  const app = parse(text).root;
  const first = /^\s*screen\b/i.test(top) ? app.children?.[0] : app.children?.[0]?.children?.[0];
  if (!first) return "it";
  if (first.type === "screen") return pageName(root, first.text);
  return name(root, first).replace(/^the /, "a ");
}

// ---- the edits, as a person says them ---------------------------------------------------------
// [verb, rest]: "make … bigger", "move … up". `change` is the writer's rewrite of one thing.
const DO = {
  bigger: ["make", "bigger"], smaller: ["make", "smaller"], bold: ["make", "bold"], regular: ["make", "not bold"],
  darker: ["make", "darker"], lighter: ["make", "lighter"], wider: ["make", "wider"], narrower: ["make", "narrower"],
  taller: ["make", "taller"], shorter: ["make", "shorter"], move_earlier: ["move", "up"], move_later: ["move", "down"],
  remove: ["remove", ""], rename: ["rename", ""], clear: ["clear", ""], change: ["change", ""],
};
export const OPS = Object.keys(DO);
const verb = (op) => DO[op] ?? ["change", ""];
const doing = (op, what) => { const [v, rest] = verb(op); return [v, what, rest].filter(Boolean).join(" "); };

// "already as big as it goes" and the rest: an answer, when the edit has nowhere left to go.
const LIMIT = {
  bigger: "already as big as it goes", smaller: "already as small as it goes", bold: "already bold", regular: "already not bold",
  darker: "already as dark as it goes", lighter: "already as light as it goes", wider: "already as wide as it goes",
  narrower: "already as narrow as it goes", taller: "already as tall as it goes", shorter: "already as short as it goes",
  move_earlier: "already first", move_later: "already last", rename: "already says that", clear: "already empty",
};

// What "the title", "the navigation" and the rest are, when there is none of them to act on.
const KIND = { text: "words like that", button: "button", input: "field", picture: "picture or shape", group: "part like that", table: "table", chart: "chart", screen: "page" };

// ---- questions ------------------------------------------------------------------------------
// Each is { text, choices } in words only; the server attaches what each choice does. Since act,
// then offer (below), the app asks first only before clearing on an unsure answer and before a new
// app when Jev is torn between that and another kind of change.
export const LEAVE = "Leave it";
export const ask = {
  clear: "Clear everything? Undo brings it back.",
  clearYes: "Yes, clear it",
  job: "What kind of change is it?",
  jobAdd: "Add something new",
  jobChange: (root, id) => (id ? `Change ${name(root, id)}` : "Change something that's there"),
  jobSeveral: "Several changes at once",
  jobNewApp: "Start a new app",
};

// ---- offers, after acting ---------------------------------------------------------------------
// Where Jev was unsure, the app does its top pick and offers the runner-up beside the reply, one
// click each (docs/plan-web-2026-09-26.md §3A): "Between “Address” and “Hours” instead", "The
// “Cancel” button instead". `named`: the name to show, from distinct() when two could read the
// same; `pages`: the pages a thing is on, said when the app has several.
export const offer = {
  target: (root, id, named = name(root, id), pages = []) => `${cap(named)}${pages.length && find(root, id)?.node.type !== "screen" ? ` ${onPages(root, pages)}` : ""} instead`,
  place: (root, g, skip) => `${cap(place(root, g, skip, "where it was"))} instead`,
  page: (root, screen) => `On ${pageName(root, screen)} instead`,
  whole: (root, whole) => (whole ? `As a new ${pageWord(root)} instead` : `On a ${pageWord(root)} that's there instead`),
  job: (root, job, id = null) => ({
    add: "Add it as something new instead",
    rewrite: id ? `Change ${name(root, id)} instead` : "Change what's there instead",
    several: "As several changes instead",
    new_app: "As a new app instead",
  })[job] ?? "Another way instead",
  // Nothing was done — Jev doesn't see the thing named — and these are the likeliest: the edit
  // itself, on each ("Make the “Home · Add” bar darker"). `op` null is a rewrite.
  doIt: (root, op, id, named = name(root, id), pages = []) => `${cap(doing(op ?? "change", named))}${pages.length && find(root, id)?.node.type !== "screen" ? ` ${onPages(root, pages)}` : ""}`,
  // This one, or every one like it (plan §4): the reverse of what was done, one click away.
  justThis: (root, id) => `Just ${name(root, id)} instead`,
  allLike: (root, id, n) => `All ${n} like ${name(root, id)} instead`,
  // Check before adding (plan §3B): what was asked for was there already, and was shown or moved
  // instead of a second one written; the second one, as asked.
  keepBoth: "Keep both",
  another: (root, id) => (find(root, id)?.node.type === "screen" ? `Add another ${pageWord(root)}` : "Add another"),
  undo: "Undo",
};

// Names for several things offered together, told apart where two would read the same: two
// “Edit” buttons on one page become "the “Edit” button right of “Email Parser”" and "… right of
// “Data Validator”". Returns one name per id, in order.
export function distinct(root, ids) {
  const names = ids.map((id) => name(root, id));
  return names.map((n, i) => {
    if (names.filter((m) => m === n).length < 2) return n;
    const h = find(root, ids[i]);
    const at = h ? where(root, h) : "";
    return at && !n.endsWith(at) ? `${n} ${at}` : n;
  });
}

// "on 3 pages" for a thing shared across pages; "on the “Menu” page" for one.
export function onPages(root, pages) {
  return pages.length > 1 ? `on ${pagesWord(root, pages.length)}` : `on ${pageName(root, pages[0])}`;
}

// ---- replies ----------------------------------------------------------------------------------
// What changed, or why nothing did. `copies`: the other pages a shared thing is also on.
const everywhere = (root, copies) => (copies ? `, on all ${pagesWord(root, copies + 1)} it's on` : "");
// "“$3.50” and the 4 others like it": one thing and its twins, named by the one pointed at.
const andLike = (what, others) => (others ? `${what} and the ${others === 1 ? "other one" : `${others} others`} like it` : what);
// A place as where something went: "to the top of …", "into …".
const toPlace = (where) => where.replace(/^at the /, "to the ").replace(/^somewhere in /, "into ").replace(/^in /, "into ");
export const reply = {
  edited: (root, op, what0, { copies = 0, across = false, to = null, others = 0 } = {}) => {
    const what = andLike(what0, others);
    if (op === "remove") return `Removed ${what}${everywhere(root, copies)}.`;
    if (op === "rename") return `Renamed ${what} to ${q(to ?? "")}${everywhere(root, copies)}.`;
    if (op === "move_earlier" || op === "move_later") return `Moved ${what} ${op === "move_earlier" ? (across ? "left" : "up") : (across ? "right" : "down")}${everywhere(root, copies)}.`;
    if (op === "clear") return "Cleared everything. Undo brings it back.";
    const [v, rest] = verb(op);
    return `${cap(v === "make" ? "made" : v)} ${what} ${rest}${everywhere(root, copies)}.`.replace(" .", ".");
  },
  limit: (op, what, others = 0) => (others
    ? `${cap(andLike(what, others))} are ${(LIMIT[op] ?? "already like that").replace(/\bit goes\b/, "they go")}.`
    : `${cap(what)} is ${LIMIT[op] ?? "already like that"}.`),
  built: (root, pages) => `Made ${name(root, root.id)}: ${pagesWord(root, pages)}.`,
  replaced: (was) => `Your earlier app, ${q(was)}, is one click away.`,
  bringBack: (was) => `Bring back ${q(was)}`,
  started: (was) => (was ? `Started fresh. ${q(was)} is one click away.` : "Started fresh."),
  added: (root, what, where, copies = 0) => `Added ${what} ${where}${everywhere(root, copies)}.`,
  changed: (root, what, copies = 0) => `Changed ${what}${everywhere(root, copies)}.`,
  moved: (what, where) => `Moved ${what} ${toPlace(where)}.`,
  alreadyThere: (what) => `${cap(what)} is already there.`,
  // Check before adding (plan §3B): "add our phone number" when the page shows one. `pages`: the
  // pages it is on.
  alreadyOn: (root, id, pages = []) => (find(root, id)?.node.type === "screen" || !pages.length
    ? `${cap(name(root, id))} is already there.`
    : `${cap(name(root, id))} is already ${onPages(root, pages)}.`),
  alreadyMoved: (what, where) => `${cap(what)} was already there, so I moved it ${toPlace(where)}.`,
  notAChange: "Nothing changed: that reads as a question or a comment.",
  noSuch: (kind) => `I don't see a ${KIND[kind] ?? "thing like that"} here, so nothing changed.`,
  notSeen: "I don't see that here, so nothing changed. Which one? Click a number on the mock.",
  gone: "That's no longer there. Say it again?",
  noPlace: (root, screen) => `I couldn't find a place for it on ${pageName(root, screen)}. Say where?`,
  missed: "That didn't come out right, so nothing changed. Try saying it again.",
  wroteNothing: "Nothing changed. Try saying it another way.",
  tooMany: "That's several changes in one. Say them one at a time.",
  noChanges: "I didn't find a change in that, so nothing changed.",
  nothingChanged: "Nothing changed.",
  more: (n) => ` (${plural(n, "more change")} after this)`,
  busy: (u) => `Still working on ${q(u)}. One thing at a time.`,
  busyAnswer: (u) => `Still working on ${q(u)}. Answer when it's done.`,
  stale: "That question has gone. Say it again?",
  offerGone: "That's no longer on offer. Say it again?",
  left: "Left as it is.",
  undone: "Undone.",
  nothingToUndo: "Nothing to undo.",
  error: "Something went wrong, so nothing changed. Try again.",
  notSetUp: "This app isn't set up yet: it needs its API keys.",
  saved: (file) => `Saved to ${q(file)}.`,
};

// ---- the toolbar on a clicked thing (plan §3C) ------------------------------------------------
// Direct edits with no words and no model: what each button says, and the one that turns every
// one like it on. `across`: the thing sits in a row, where up and down are left and right.
export const tool = {
  label: (op, across = false) => ({
    bigger: "Bigger", smaller: "Smaller", bold: "Bold", regular: "Not bold", lighter: "Lighter", darker: "Darker",
    move_earlier: across ? "← Left" : "↑ Up", move_later: across ? "Right →" : "↓ Down", remove: "Remove",
  })[op] ?? op,
  all: (n) => `All ${n} like this`,
  renameHint: "Double-click to change the words",
};

// ---- next steps (plan §3E) --------------------------------------------------------------------
// Offered under the text box, one click each, in place of a list of what can be said: on an empty
// canvas these, and after a build or a change the writer's own (writer.mjs `nextSteps`).
export const starters = [
  "A website for my bakery: menu, hours, where to find us",
  "A phone app to split rent with roommates",
  "An inbox for a small support team",
];
// The writer's next steps as the page shows them: three, each a few plain words. One that says col,
// border or the like — or screen, on a website — is left out rather than reworded.
export function chips(root, list = []) {
  const bad = new Set([...BANNED, ...(frameOf(root) === "web" ? BANNED_WEB : [])]);
  const plain = (s) => !(s.replace(/[“"][^”"]*[”"]/g, "").match(/[A-Za-z_]+/g) ?? []).some((w) => bad.has(w.toLowerCase())) && !/[#=]|->/.test(s);
  return [...new Set(list.map((s) => String(s ?? "").trim()))].filter((s) => s && s.length <= 60 && plain(s)).slice(0, 3);
}

// ---- the page around the mock -----------------------------------------------------------------
export const ui = {
  title: "mockspeed",
  placeholder: "Describe a website or app, or say what to change…",
  selectHint: "Click anything on the mock to point at it.",
  unselect: "Unselect",
  say: "Go",
  voice: "Speak",
  undo: "Undo",
  new: "New",
  save: "Save file",
  you: "You",
  empty: "Describe a website or app to start.",
};

// The line under the app's name: how many pages it has.
export function status(root) {
  const n = (root?.children ?? []).filter((c) => c.type === "screen").length;
  return n ? pagesWord(root, n) : ui.empty;
}

// What is selected, under the text box.
export function selected(root, id) {
  const hit = find(root, id);
  if (!hit) return ui.selectHint;
  const screen = index(root).find((n) => n.id === id)?.screen;
  const many = (root.children ?? []).filter((c) => c.type === "screen").length > 1;
  return `Selected: ${name(root, id)}${many && screen && hit.node.type !== "screen" ? ` on ${pageName(root, screen)}` : ""}`;
}

// While a request runs: which page a build is drawing, or what is being worked on.
export function working(root, utterance, drawing = null) {
  return drawing != null ? `Drawing ${pageName(root, drawing)}…` : `Working on ${q(utterance)}…`;
}
