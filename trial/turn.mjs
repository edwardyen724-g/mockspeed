// turn — act, then offer (docs/plan-web-2026-09-26.md §3A).
//
// Where Jev is unsure, the server acts on its top pick and keeps the other options as doubts. Once
// the sentence is done, the page offers the alternatives to the decision Jev was least sure of,
// beside the reply, as one-click swaps, with Undo. A wrong guess costs one click; a question costs a
// read, a decision and a click every time, even when Jev was right.
//
// A Turn is one sentence: one record per part (a split sentence's parts each get their own after
// the sentence's first), each holding the canvas and undo depth before it, the changes it made — as
// `redo`, which makes the same change on another canvas — its doubts, and the piece it wrote. A swap
// goes back to its part's canvas, does the alternative instead, and makes the later parts' changes
// again after it. A doubt in the first record of a split sentence is about the whole sentence (what
// kind of change it is), so its swap replaces the parts rather than keeping them.

import { apply, applyPatch, placeAt, find, serialize, copiesOf, mirrorsOf } from "./tree.mjs";

const record = (root, depth, whole = false) => ({ snap: { root, depth }, steps: [], doubts: [], piece: null, whole });

export class Turn {
  constructor(root, depth) {
    this.parts = [record(root, depth, true)];
    this.at = 0;
  }
  get current() { return this.parts[this.at]; }
  // A part of a split sentence starts: the canvas as it is now is what its swaps go back to.
  open(root, depth) {
    this.parts.push(record(root, depth));
    this.at = this.parts.length - 1;
  }
  // One decision Jev was unsure of: its top pick's confidence, and the alternatives to it, each
  // { label, body } — the body is what the person's answer would have posted when this was a
  // question, so a swap is that answer. `ctx` is the sentence as it stood when Jev decided.
  doubt(conf, alts, ctx) {
    if (alts.length) this.current.doubts.push({ conf, alts, ctx });
  }
  // Alternatives that no longer are any: a pick among five prices, once every price is being changed.
  forget(gone) {
    const p = this.current;
    p.doubts = p.doubts.map((d) => ({ ...d, alts: d.alts.filter((a) => !gone(a)) })).filter((d) => d.alts.length);
  }
  // A change made, as the same change on another canvas (see `redo` below), with its log entry.
  step(redo, entry) { this.current.steps.push({ redo, entry }); }
  // The swaps to offer: for each part, every alternative to the decision Jev was least sure of.
  offers() {
    const out = [];
    this.parts.forEach((p, part) => {
      if (!p.doubts.length) return;
      const least = p.doubts.reduce((a, b) => (b.conf < a.conf ? b : a));
      least.alts.forEach((a, alt) => out.push({ label: a.label, body: a.body, part, doubt: p.doubts.indexOf(least), alt }));
    });
    return out;
  }
  // Going back for a swap: what to restore (`snap`), the alternative with the sentence it belongs to,
  // the piece the part wrote, and the later parts' changes to make again after it. The turn keeps
  // the parts before, and the swapped part starts over with nothing in it. null for a swap that is
  // not on offer.
  rewind(part, doubt, alt) {
    const p = this.parts[part], d = p?.doubts[doubt], a = d?.alts[alt];
    if (!a) return null;
    const later = p.whole ? [] : this.parts.slice(part + 1).flatMap((q) => q.steps);
    this.parts = [...this.parts.slice(0, part), record(p.snap.root, p.snap.depth, p.whole)];
    this.at = part;
    return { snap: p.snap, alt: a, ctx: d.ctx, piece: p.piece, later };
  }
}

// The later parts' changes, made again one after another on the canvas a swap left: each result,
// or null for a change that can no longer be made there (what it acted on is gone).
export function replay(root, steps) {
  const out = [];
  let t = root;
  for (const step of steps) {
    const x = step.redo(t);
    if (x?.changed) t = x.root;
    out.push({ step, root: x?.changed ? x.root : null });
  }
  return out;
}

// ---- the changes, as functions of the canvas -------------------------------------------------------

// An edit to an element and, when it is shared (tree.mjs `share=`), to every copy of it on the
// other screens: one element, drawn on several.
export function applyEverywhere(root, op, target, arg) {
  const r = apply(root, op, target, arg);
  if (!r.changed) return r;
  let tree = r.root, more = 0;
  for (const c of copiesOf(root, target)) {
    const x = apply(tree, op, c.id, arg);
    if (x.changed) { tree = x.root; more += 1; }
  }
  return more ? { ...r, root: tree, copies: more, note: `${r.note} · and on ${more} other screen${more === 1 ? "" : "s"}, where it is shared` } : r;
}

// The same edit on several elements — every twin (tree.mjs twinsOf) when a sentence or the toolbar
// means every one like it — each one everywhere it is shared. `copies` counts the other pages the
// first is on, which is what a person reads ("on all 3 pages it's on"); `count` how many changed.
export function applyAll(root, op, targets, arg) {
  let tree = root, count = 0, copies = 0, limit = true, first = null;
  for (const t of targets) {
    const x = applyEverywhere(tree, op, t, arg);
    first ??= x;
    if (x.changed) { tree = x.root; count += 1; if (t === targets[0]) copies = x.copies ?? 0; }
    else if (!x.limit) limit = false;
  }
  if (!count) return { ...first, root, changed: false, limit: limit && Boolean(first?.limit), count: 0 };
  return { ok: true, root: tree, changed: true, count, copies, note: targets.length > 1 ? `${op} on ${count} of ${targets.length} alike` : first.note };
}

// The patch that puts `text` at a place (tree.mjs placeAt), and at the same place in every other
// copy when the place is inside a shared element. A shared element rewritten stays shared: its
// replacement keeps the name. Returns { patch, copies } or null.
export function placeEverywhere(root, anchor, position, text) {
  const key = find(root, anchor)?.node.props?.share;
  if (position === "replace" && key != null) {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => l.trim() && !/^\s/.test(l) && !/^\s*\/\//.test(l));
    if (i >= 0 && !/\bshare=/.test(lines[i])) lines[i] = `${lines[i].replace(/\s+$/, "")} share=${key}`;
    text = lines.join("\n");
  }
  const first = placeAt(root, anchor, position, text);
  if (!first) return null;
  const more = mirrorsOf(root, anchor, position).map((a) => placeAt(root, a, position, text)).filter(Boolean);
  return { patch: first + more.join(""), copies: more.length };
}

// The canvas with `target` taken out and put at `gap`, its ids kept, so it is the same element
// afterwards. null when either is no longer there.
export function relocate(root, target, gap) {
  const hit = find(root, target);
  if (!hit) return null;
  const without = applyPatch(root, `remove ${target}\n`).root;
  if (!find(without, gap.anchor)) return null;
  return applyPatch(without, placeAt(without, gap.anchor, gap.position, serialize(hit.node))).root;
}

// Each kind of change the server makes, as the same change on another canvas: { root, changed },
// or null when it cannot be made there.
export const redo = {
  edit: (op, target, arg) => (t) => applyEverywhere(t, op, target, arg),
  edits: (op, targets, arg) => (t) => applyAll(t, op, targets, arg),
  place: (anchor, position, text) => (t) => {
    const p = placeEverywhere(t, anchor, position, text);
    return p ? { root: applyPatch(t, p.patch).root, changed: true } : null;
  },
  move: (target, gap) => (t) => {
    const r = relocate(t, target, gap);
    return r ? { root: r, changed: true } : null;
  },
  clear: () => (t) => apply(t, "clear", null),
};
