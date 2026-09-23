// ops — the closed set of edits a mockspeed spec accepts, applied by code.
//
//   import { index, apply, OPS } from "./ops.mjs"
//
// Jev decides which op and which target; nothing here asks a model anything. Every op is a pure
// function of (spec, target) and every result is re-validated before it is handed back, so an
// edit either lands whole or does not land at all.
//
// Targets are addressed as "<screen name>/<data-id>" — the same ids render.mjs writes into the
// HTML, so what the canvas points at and what this file edits are the same thing. Ids are
// per-screen and per-kind (`button1`, `button2`), which is why the screen name is part of the key.

import { validate } from "../render/render.mjs";

export const OPS = [
  "new_mock", "add_screen", "clear",
  "promote", "demote", "make_primary", "remove",
  "move_up", "move_down", "rename", "add", "none",
];

// Destructive ops are confirmed in the canvas before they are applied. new_mock throws the whole
// mock away but is not here: it is how a build starts, and undo brings the old one back. clear
// is: it is asked for on its own, and one yes is better than nineteen removes that each wait for
// one (which is what "reset the canvas" became before clear existed).
export const DESTRUCTIVE = new Set(["remove", "clear"]);

const FRAMES = ["web", "phone", "panel"];

// Kinds that can be brought into being from one line of words. The words are always written by
// someone — the person typing, or the translator model writing the fake data — never by Jev, which
// only decides where they go. A strip and a scatter need numbers laid out on axes; those are
// written in the spec.
export const CREATABLE = ["button", "text", "field", "stat", "chips", "tabs", "list", "table", "row"];

// How one line of words becomes an element of each kind. Richer kinds read a small format:
// `;` separates rows, `|` separates the fields of one row. A person typing "Inbox, Archive" gets
// what they typed; the translator writing a table writes "Agent | Status; planner | running".
const rows = (t) => t.split(/\s*;\s*/).map((r) => r.split(/\s*\|\s*/).map((c) => c.trim())).filter((r) => r.some(Boolean));
const fields = (t) => t.split(/\s*\|\s*/).map((x) => x.trim());
const some = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
const BUILD = {
  button: (t) => ({ kind: "button", label: t, tier: "mid" }),
  text:   (t) => ({ kind: "text", text: t, tier: "mid" }),
  field:  (t) => { const [label, value] = fields(t); return { kind: "field", ...some({ label, value }), tier: "mid" }; },
  stat:   (t) => { const [value, sub, note] = fields(t); return { kind: "stat", ...some({ value, sub, note }), tier: "heavy" }; },
  chips:  (t) => ({ kind: "chips", items: split(t), tier: "mid" }),
  tabs:   (t, screen) => {
    const items = split(t);
    return { kind: "tabs", items, on: items.find((i) => i.toLowerCase() === screen?.toLowerCase()) ?? items[0], tier: "faint" };
  },
  list:   (t) => ({
    kind: "list", tier: "mid",
    rows: (/[;|]/.test(t) ? rows(t) : split(t).map((x) => [x])).map(([text, sub, meta]) => some({ text, sub, meta })),
  }),
  table:  (t) => { const [columns, ...body] = rows(t); return { kind: "table", tier: "mid", columns, rows: body }; },
  // A row made from words is a row of numbers, each with its caption: "12 | running; 3 | blocked".
  row:    (t) => ({ kind: "row", tier: "mid", items: rows(t).map(([value, sub]) => ({ kind: "stat", ...some({ value, sub }), tier: "mid" })) }),
};
const split = (t) => t.split(/\s*[,;·|]\s*|\s+\/\s+/).map((x) => x.trim()).filter(Boolean);

const TIERS = ["faint", "mid", "heavy"]; // ascending

// Which field carries an element's name, per kind. `text` says what it says; a stat is its
// number; everything else is named by its caption or its own label.
const NAME_FIELD = {
  text: "text", stat: "value", button: "label", field: "label",
  chips: "label", tabs: "label", list: "label", table: "label",
  row: "label", strip: "label", scatter: "label",
};

// ---- walking the spec the way the renderer does -------------------------------------------

// Mirrors render.mjs: ids are counted per screen and per kind, `e.id` wins when the spec sets
// one, and on a phone frame the tabs element is rendered after the body. Diverging here would
// mean the canvas and the renderer disagree about which element is `button2`.
export function index(spec) {
  const out = [];
  spec.screens.forEach((s, si) => {
    const frame = s.frame ?? spec.frame ?? "web";
    const counts = {};
    const nextId = (k) => `${k}${(counts[k] = (counts[k] ?? 0) + 1)}`;
    const tabs = frame === "phone" ? s.elements.find((e) => e.kind === "tabs") : null;
    const order = tabs ? [...s.elements.filter((e) => e !== tabs), tabs] : s.elements;

    const walk = (e, list, i) => {
      const id = e.id ?? nextId(e.kind);
      out.push({
        key: `${s.name}/${id}`, id, screen: s.name, screenIndex: si,
        kind: e.kind, tier: e.tier ?? "mid", el: e, list, i,
        text: summarize(e),
      });
      if (e.kind === "row" && Array.isArray(e.items)) e.items.forEach((c, j) => walk(c, e.items, j));
    };
    order.forEach((e) => walk(e, s.elements, s.elements.indexOf(e)));
  });
  return out;
}

// One short line per element, for a human list and for Jev's state. Data is quoted as-is;
// nothing here judges or rewrites it.
function summarize(e) {
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const pick =
    e.kind === "stat" ? [e.value, e.unit].filter(Boolean).join(" ")
    : e.kind === "text" ? [e.lead, e.text].filter(Boolean).join(" ")
    : e.kind === "field" ? [e.label, e.value && `= ${e.value}`].filter(Boolean).join(" ")
    : e.kind === "chips" || e.kind === "tabs" ? (e.items ?? []).join(" · ")
    : e.kind === "list" ? `${(e.rows ?? []).length} rows · ${first(e.rows)?.text ?? ""}`
    : e.kind === "table" ? `${(e.columns ?? []).join(" | ")} · ${(e.rows ?? []).length} rows`
    : e.kind === "row" ? `${(e.items ?? []).length} side by side`
    : e.kind === "strip" ? [`${(e.values ?? []).length} values on a line`,
        (e.bands ?? []).map((b) => `band ${b[0]}–${b[1]}`).join(", "), e.marker != null && `marker ${e.marker}`]
        .filter(Boolean).join(" · ")
    : e.kind === "scatter" ? `${(e.points ?? []).length} points, ${(e.axes ?? []).join(" against ")}`
    : e.label ?? "";
  const cap = e.label && e.kind !== "field" && e.kind !== "button" ? `${e.label}: ` : "";
  const s = cap + pick;
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
}

export function find(spec, key) {
  const all = index(spec);
  return all.find((n) => n.key === key) ?? all.find((n) => n.id === key) ?? null;
}

// ---- applying one op ----------------------------------------------------------------------

// Returns { ok, spec, note, changed }. `spec` is a new object; the one passed in is never
// touched. An op that would produce an invalid spec is refused and the original comes back.
export function apply(spec, op, target, arg) {
  if (!OPS.includes(op)) return fail(spec, `unknown op '${op}'`);
  if (op === "none") return { ok: true, spec, note: "nothing to do", changed: false };

  // A new mock starts with no screens, which validate() rejects. That is the honest state of a
  // mock that is still on its way — the canvas draws an empty frame until the first screen lands.
  if (op === "new_mock") {
    const title = (arg?.title ?? "").trim();
    if (!title) return fail(spec, "what is the new app called?");
    const frame = FRAMES.includes(arg?.frame) ? arg.frame : "web";
    return { ok: true, spec: { title, frame, screens: [] }, note: `new ${frame} mock "${title}"`, changed: true };
  }
  if (op === "clear") {
    if (!spec.screens.length) return { ok: true, spec, changed: false, note: "the canvas is already empty" };
    return { ok: true, spec: { title: "new", frame: spec.frame ?? "web", screens: [] }, note: "cleared the canvas", changed: true };
  }
  if (op === "add_screen") {
    const name = (arg?.name ?? "").trim();
    if (!name) return fail(spec, "what is the screen called?");
    if (spec.screens.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      return fail(spec, `there is already a screen called ${name}`);
    }
    const next = structuredClone(spec);
    next.screens.push({ name, elements: [] });
    return { ok: true, spec: next, note: `screen "${name}"`, changed: true };
  }

  // add is the one op that brings something into existence, so it takes words rather than a
  // target: { kind, text, screen, tier }. It lands after the marked element, or at the end of the
  // named screen.
  if (op === "add") {
    const { kind, text, screen, tier } = arg ?? {};
    if (!CREATABLE.includes(kind)) {
      return fail(spec, `a ${kind ?? "that"} needs its own data — write it in the spec, not here`);
    }
    if (!(text ?? "").trim()) return fail(spec, `what should the ${kind} say?`);
    if (!spec.screens.length) return fail(spec, "there is no screen yet — add one first");
    const next = structuredClone(spec);
    const anchor = target ? find(next, target) : null;
    const s = anchor
      ? next.screens[anchor.screenIndex]
      : next.screens.find((x) => x.name === screen) ?? next.screens[0];
    if (kind === "tabs" && s.elements.some((e) => e.kind === "tabs")) {
      return fail(spec, `${s.name} already has tabs — rename those instead`);
    }
    const made = BUILD[kind](text.trim(), s.name);
    if (TIERS.includes(tier)) made.tier = tier;
    // One thing carries a screen. A kind's default never makes a second heavy element — a stat
    // added under a heavy one is supporting — and an element asked for as heavy takes over, the
    // way make_primary does, with the old one stepping back to mid.
    let stepped = 0;
    if (made.tier === "heavy") {
      const heavies = index(next).filter((n) => n.screen === s.name && n.tier === "heavy");
      if (!TIERS.includes(tier) && heavies.length) made.tier = "mid";
      else heavies.forEach((n) => { n.el.tier = "mid"; stepped += 1; });
    }
    if (anchor && anchor.list === s.elements) s.elements.splice(anchor.i + 1, 0, made);
    else s.elements.push(made);
    const errors = validate(next);
    if (errors.length) return fail(spec, `refused — ${errors[0]}`);
    const words = text.trim().length > 48 ? text.trim().slice(0, 45) + "…" : text.trim();
    const also = stepped ? ` · ${stepped} stepped back to mid` : "";
    return { ok: true, spec: next, note: `added ${made.tier} ${kind} "${words}" to ${s.name}${also}`, changed: true };
  }

  const next = structuredClone(spec);
  const node = target ? find(next, target) : null;
  if (!node) return fail(spec, target ? `no element '${target}'` : "no target");

  const what = `${node.kind} ${node.key}`;
  let note;

  switch (op) {
    case "promote":
    case "demote": {
      const dir = op === "promote" ? 1 : -1;
      const at = TIERS.indexOf(node.tier);
      const to = TIERS[at + dir];
      if (!to) return { ok: true, spec, changed: false, note: `${what} is already ${node.tier}` };
      node.el.tier = to;
      note = `${what} ${node.tier} → ${to}`;
      break;
    }
    case "make_primary": {
      // One thing carries a screen. Anything else already heavy on this screen steps back to mid.
      const demoted = index(next)
        .filter((n) => n.screenIndex === node.screenIndex && n.el !== node.el && (n.el.tier ?? "mid") === "heavy");
      demoted.forEach((n) => { n.el.tier = "mid"; });
      node.el.tier = "heavy";
      note = `${what} is now the screen` + (demoted.length ? ` · ${demoted.length} stepped back to mid` : "");
      break;
    }
    case "remove": {
      node.list.splice(node.i, 1);
      note = `removed ${what}`;
      break;
    }
    case "move_up":
    case "move_down": {
      const to = node.i + (op === "move_up" ? -1 : 1);
      if (to < 0 || to >= node.list.length) {
        return { ok: true, spec, changed: false, note: `${what} is already ${op === "move_up" ? "first" : "last"}` };
      }
      const [moved] = node.list.splice(node.i, 1);
      node.list.splice(to, 0, moved);
      note = `${what} moved ${op === "move_up" ? "up" : "down"}`;
      break;
    }
    case "rename": {
      const text = (arg ?? "").trim();
      if (!text) return fail(spec, "rename needs the new words");
      const field = NAME_FIELD[node.kind] ?? "label";
      const was = node.el[field];
      node.el[field] = text;
      note = `${what} ${was ? `"${was}" → ` : ""}"${text}"`;
      break;
    }
  }

  const errors = validate(next);
  if (errors.length) return fail(spec, `refused — ${errors[0]}`);
  return { ok: true, spec: next, note, changed: true };
}

const fail = (spec, note) => ({ ok: false, spec, note, changed: false });
