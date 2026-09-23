// jev — the decide layer. One request, three or four questions, ~300 ms.
//
// Jev does not write anything. It answers closed questions about what was just said: does this
// ask for a change at all, which op, which element, and — when the op is a rename — which span of
// the utterance is the new name, copied verbatim. Code does the rest: thresholds are policy,
// spans are sliced by code, the edit is applied by ops.mjs.
//
// Why choice-over-labels rather than one question per element: per-index fan-out over a long
// array bleeds onto neighbouring indices (jev-context docs/JEV-API.md), and a single choice with
// one label per element has no indices to bleed between.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

import { OPS } from "./ops.mjs";


const KIND_MEANS = {
  button: "something you press: an action",
  text: "a line of words",
  field: "somewhere to type, with a label",
  stat: "one number that is the point of the screen",
  chips: "several short tags side by side",
  tabs: "the bar of sections you switch between",
  list: "rows of things, one under the other",
  table: "a grid with columns and rows",
  strip: "numbers spread along a line",
  scatter: "a plot of points on two axes",
  row: "several numbers side by side, each with a caption",
};

// Where a sentence the person typed goes — intent routing (docs.typesafe.ai/patterns/intent-routing):
// one choice whose labels are handlers, asked in the same call as everything the direct handler
// needs (speculative fan-out), so a direct edit costs one Jev request and no model call. Each
// label is a handler in server.mjs; a research agent is a new label here and a branch there.
// Measured on 29 sentences against a live canvas: 26-27/29, every miss on the safe side — a
// direct edit escalated to the writer, or a borderline question handed to the writer, which
// answers questions in words rather than edits.
export const ROUTES = {
  none: "not a request: a question about whether the current design is good, a remark, or an approval",
  direct: "exactly one change to an element already on the mockup that needs no new words written: make it louder, quieter, bigger, smaller or the main thing, move it, remove it, rename it to words the sentence gives, add a button, text or field whose words the sentence gives, or clear the whole canvas. this, it or that means the marked element",
  write: "new words must be written that the sentence does not give, or it asks for more than one change: a new app or tool to mock up (even a bare description), a new screen, an element with content such as a list, table, rows or numbers, several changes at once, or a vague wish to improve something",
};

const OP_MEANS = {
  clear: "remove everything and leave a blank canvas: reset, clear, wipe, empty it, start over from nothing",
  new_mock: "start over with a brand-new, empty mockup of a different app, throwing the current one away",
  add_screen: "add a whole new screen, page or view to the mockup",
  promote: "make this element louder / bigger / more important (one step up the hierarchy)",
  demote: "make this element quieter / smaller / less important (one step down)",
  make_primary: "make this the one thing the screen is about, above everything else",
  remove: "delete this element, take it off the screen, get rid of it",
  move_up: "move this element earlier / higher / above its neighbour",
  move_down: "move this element later / lower / below its neighbour",
  rename: "change the words of this element to different words the speaker gave",
  add: "put a new element — a button, a number, a list, a table, some text — on a screen where it is not yet",
  none: "no edit is being asked for — a question, a remark, an approval, or something unclear",
};

// Spans a rename could be naming. Code proposes; Jev picks one; code slices it back out
// verbatim, so the model never writes the text that lands in the spec.
export function spans(utterance) {
  const out = [];
  const push = (s) => {
    const t = (s ?? "").trim().replace(/^["'“”‘’]+|["'“”‘’.,!?]+$/g, "").trim();
    if (t && t.length <= 600 && !out.includes(t)) out.push(t);
  };
  const bare = (s) => (s ?? "").replace(/\s+(instead|now|please|rather|ok|okay)$/i, "");
  const both = (s) => { push(s); push(bare(s)); };
  // Double quotes carry whole contents — a table's rows, a list — so they are allowed to be long.
  // Single and curly quotes stay short: an apostrophe inside ordinary speech must not open a span.
  for (const m of utterance.matchAll(/"([^"]{1,600})"/g)) both(m[1]);
  for (const m of utterance.matchAll(/[“‘']([^"'”’]{1,60})[”’']/g)) both(m[1]);
  for (const m of utterance.matchAll(/\b(?:call it|call this|rename (?:it |this )?to|change it to|make it say|label it|say)\s+(.+)$/gi)) both(m[1]);
  for (const m of utterance.matchAll(/\b(?:called|labell?ed|named|saying|that says|which says|reading)\s+(.+)$/gi)) both(m[1]);
  for (const m of utterance.matchAll(/\bto\s+(.+)$/gi)) both(m[1]);
  return out.slice(0, 8);
}

// A sentence with its double-quoted content blanked out. Quoted content is data — a table's
// rows, an error message in a log — and data must not steer the decision about what the sentence
// asks for: screen names inside a tabs line pulled the screen answer to the wrong screen, and an
// error message inside a list dragged "is this an add?" below threshold. Every question reads the
// instruction; only the span question sees the content.
export const unquoted = (s) => s.replace(/"[^"]*"/g, '"…"');

export async function decide({ utterance, marked, elements, screens, apiKey, signal, routing = false }) {
  const state = {
    said: utterance,
    instruction: unquoted(utterance),
    marked: marked ?? null,
    screens: screens.map((s) => ({ name: s.name, primary: s.primary ?? null })),
    elements: elements.map((e) => `${e.key} — ${e.kind}, ${e.tier}, ${e.text}`),
  };

  const cand = spans(utterance);
  const questions = {
    // Both phrasings below are literal on purpose (Jev reads instructions literally). Measured on
    // tabs lines arriving for the 2nd and 3rd screen, where the first screen already had tabs:
    // "a change to the mockup described in `elements`" fired at 0.55-0.65, this at 0.94; "which
    // screen is it talking about?" chose the right screen at 0.19-0.66, "which screen does it
    // name?" at 0.89-0.93.
    fire: {
      type: "noul",
      instructions: "Is `instruction` a request to change the mockup — to start one, add a screen, add an element, or change or remove one? A question, a remark or an approval is not.",
    },
    op: {
      type: "choice",
      instructions: "Which single edit does `instruction` ask for? `marked` is the element the speaker has pointed at, if any.",
      criteria: Object.fromEntries(OPS.map((o) => [o, OP_MEANS[o]])),
    },
    kind: {
      type: "choice",
      instructions: "If `instruction` asks for a new element to be put on a screen, what kind of thing is it? Answer `none` if no new element is being asked for — a new screen or a new mockup is not an element.",
      criteria: { ...Object.fromEntries(Object.entries(KIND_MEANS)), none: "no new element is being asked for" },
    },
    // "faint" is the canvas's own tier label and appears all over `elements`; inside an instruction
    // Jev read "add faint text" as a kind of text (P(none) 0.94). "quiet" reads as prominence
    // (0.78-0.95), so the translator writes quiet and the criteria lead with it.
    tier: {
      type: "choice",
      instructions: "Does `instruction` say how prominent the thing it adds or changes should be?",
      criteria: {
        heavy: "yes — heavy, the main thing, the most important, big, primary, louder",
        faint: "yes — quiet, quieter, small, secondary, subtle, metadata, chrome",
        none: "it does not say",
      },
    },
    frame: {
      type: "choice",
      instructions: "If `instruction` starts a new mockup, what does it run on?",
      criteria: { web: "a web app, website or desktop tool", phone: "a phone or mobile app", panel: "a side panel, plugin or narrow sidebar", none: "not starting a new mockup" },
    },
  };
  // Only for what the person typed, not for the writer's lines. `request` is the gate; it reads
  // "this is the main thing" as a request once told statements count (0.15 → 0.85).
  if (routing) {
    questions.route = { type: "choice", instructions: "Which way should `said` be handled?", criteria: ROUTES };
    questions.request = {
      type: "noul",
      instructions: "Is `said` a request — to mock up an app or tool (a bare description like \"a phone app for X\" is a request), to show what something would look like, to add, change, move or remove something, or a statement of how an element should be (\"this is the main thing\", \"that should be bigger\")? Answer no for a question about whether the current design is good, a remark, or an approval.",
    };
  }
  // An empty mock has nothing to point at and nowhere to put things yet; a choice with no labels
  // is not a question.
  if (elements.length) {
    questions.target = {
      type: "choice",
      // The one question that reads the whole sentence: an element is named by its visible words,
      // and those may be quoted (make the "New Task" button the main thing).
      instructions: "Which element in `elements` does `said` act on? Each label is that element's key; its description is the element. If `said` points at it with a word like this, that or it, the answer is `marked`.",
      criteria: Object.fromEntries(elements.map((e) => [e.key, `${e.kind}, ${e.tier}: ${e.text}`])),
    };
  }
  if (screens.length) {
    questions.screen = {
      type: "choice",
      instructions: "Which screen does `instruction` name? A line that starts `on <Screen>:` names that screen. If it names none, answer with the screen holding the element it acts on.",
      criteria: Object.fromEntries(screens.map((s) => [s.name, s.primary ?? s.name])),
    };
  }
  // Candidates are labelled by position, not by their own text: a table's contents make a poor
  // label, and the answer only has to point at one of them.
  if (cand.length) {
    questions.span = {
      type: "choice",
      instructions: "If `said` gives new words — a new name, a label, or the contents of something new — which candidate is exactly those words, with no surrounding instruction? Answer `none` if `said` gives no new words.",
      criteria: { ...Object.fromEntries(cand.map((s, i) => [`s${i + 1}`, `the new words would be: ${s}`])), none: "no new words are given" },
    };
  }

  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state, questions }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jev ${res.status}: ${body.slice(0, 200)}`);
  }
  const { answers } = await res.json();

  return {
    ms: Date.now() - started,
    fire: answers.fire?.noul ?? 0,
    op: answers.op?.choice ?? "none",
    opConfidence: answers.op?.confidence ?? 0,
    target: answers.target?.choice ?? null,
    targetConfidence: answers.target?.confidence ?? 0,
    targets: answers.target?.probabilities ?? {},
    span: /^s\d+$/.test(answers.span?.choice ?? "") ? cand[Number(answers.span.choice.slice(1)) - 1] ?? null : null,
    spanConfidence: answers.span?.confidence ?? 0,
    kind: answers.kind?.choice && answers.kind.choice !== "none" ? answers.kind.choice : null,
    kindConfidence: answers.kind?.confidence ?? 0,
    tier: answers.tier?.choice && answers.tier.choice !== "none" ? answers.tier.choice : null,
    tierConfidence: answers.tier?.confidence ?? 0,
    frame: answers.frame?.choice && answers.frame.choice !== "none" ? answers.frame.choice : null,
    frameConfidence: answers.frame?.confidence ?? 0,
    screen: answers.screen?.choice ?? null,
    screenConfidence: answers.screen?.confidence ?? 0,
    route: answers.route?.choice ?? null,
    routeConfidence: answers.route?.confidence ?? 0,
    request: answers.request?.noul ?? null,
  };
}
