// jev — the decide layer of the trial. One request per sentence the person types: where it goes
// (route), and — asked in the same call, so a direct edit costs nothing more — which concrete edit,
// on which node, with which new words.
//
// The edits are visible property changes, named the way a person would name what they see change:
// bigger, bold, lighter, wider, earlier. canvas/ offered "louder", "quieter" and "the main thing",
// which are ideas about hierarchy a person has to translate before they can tell whether the edit
// did what they meant.

import { spans, unquoted } from "../canvas/jev.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";

// Jev's API answers 429 and 529 ("system_overloaded") under load, and TypeSafe's own SDK retries
// those and 5xx with backoff. The raw calls here do the same, twice, then give up and say so —
// the canvas shows the error rather than act without Jev's answer.
async function ask(body, signal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${body.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: body.state, questions: body.questions }),
      signal,
    });
    if (res.ok) return res.json();
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 2) throw new Error(`jev ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    await new Promise((ok) => setTimeout(ok, 400 * 2 ** attempt));
  }
}

export { unquoted };

// Handlers for what the person typed (docs.typesafe.ai/patterns/intent-routing). A new handler —
// the research route — is a new label here and a branch in server.mjs.
export const ROUTES = {
  none: "not a request: a question about whether the current design is good, a remark, or an approval",
  direct: "exactly one visible change to something already on the mockup that needs no new words written: make its text bigger or smaller, bold or regular, darker or lighter; make it wider, narrower, taller or shorter; move it earlier or later; remove it; rename it to words the sentence gives; or clear the whole canvas. this, it or that means the marked element",
  write: "anything that has to be written or built: a new app or tool (even a bare description), a new screen, section or element, content, a different layout or arrangement, several changes at once, or a vague wish to improve something",
};

// What a sentence on the writer's route asks for. Each is handled differently: a new app is
// written whole (and on a full canvas the person decides whether to replace it), an addition is
// written as one piece and put where Jev chooses, a rewrite replaces one element Jev chooses, and
// several changes are split into single ones by the writer and each is decided on its own.
// Measured 2026-09-23: 11/11 on two runs, confidence 0.92-1.00.
export const JOBS = {
  new_app: "a whole new app or tool, a different product from the one on the canvas",
  add: "put one new piece into the app on the canvas: an element, a section, a field, a screen",
  rewrite: "redo or restructure one piece already on the canvas: turn it into something else, rearrange it",
  several: "more than one change at once",
  none: "none of these",
};

// The direct edits, each described by what visibly happens (trial/tree.mjs `apply`).
export const OPS = {
  bigger: "make the text bigger or larger",
  smaller: "make the text smaller",
  bold: "make it bold",
  regular: "make it not bold, normal weight",
  darker: "make it darker, blacker, more contrast",
  lighter: "make it lighter, greyer, fainter, less contrast",
  wider: "make it wider",
  narrower: "make it narrower, thinner",
  taller: "make it taller",
  shorter: "make it shorter, less tall",
  move_earlier: "move it up, or left, before the thing next to it",
  move_later: "move it down, or right, after the thing next to it",
  remove: "delete it, take it off, get rid of it",
  rename: "change its words to different words the sentence gives",
  clear: "remove everything and leave a blank canvas: reset, clear, wipe, start over",
  none: "none of these",
};

// nodes: [{ id, screen, line }] — `line` is describe(node). Jev sees each node as one line, and the
// target question offers every node as a label, so there are no indices to bleed between.
// screens: screen names; viewing: the one on the person's screen. `routing` adds the questions
// only the person's own sentence needs: where it goes, what job it is, which screen.
// context: for a part of a sentence the writer split, the whole sentence, so "this" in one part
// can still be resolved against what the person said and marked.
export async function decide({ utterance, marked, nodes, screens = [], viewing = null, context = null, apiKey, signal, routing = true }) {
  const cand = spans(utterance);
  const state = {
    said: utterance,
    instruction: unquoted(utterance),
    marked: marked ?? null,
    viewing: viewing ?? null,
    context: context ?? null,
    elements: nodes.map((n) => `${n.id} — ${n.line}${n.screen ? ` · on ${n.screen}` : ""}`),
  };
  const questions = {
    route: { type: "choice", instructions: "Which way should `said` be handled?", criteria: ROUTES },
    job: { type: "choice", instructions: "What does `instruction` ask to be done to the mockup described in `elements`?", criteria: JOBS },
    whole: { type: "noul", instructions: "Does `instruction` ask for a whole new screen or page, rather than something on a screen?" },
    // What a new app runs on is the person's, not the writer's: it is decided here and handed to
    // the writer as a requirement.
    frame: {
      type: "choice",
      instructions: "If `said` asks for a new app, what does it run on?",
      criteria: { web: "a web app, website or desktop tool", phone: "a phone or mobile app", panel: "a side panel, browser extension, plugin or narrow sidebar", unspecified: "it does not say, or it is not a new app" },
    },
    // "move it above the table" names where it should end up; "move it up" is one step. Measured
    // 2026-09-23 on ten move sentences: this wording 10/10; one that asked only about "another
    // named element" read "to the top of the screen" and "at the bottom" as steps (0.43-0.44).
    dest: { type: "noul", instructions: "Does `said` name a place for the element to end up — such as the top or bottom of the screen, the start or end of a row, or above, below, next to or inside another element — rather than only a direction to nudge it one step (up, down, earlier, later)?" },
    request: {
      type: "noul",
      instructions: "Is `said` a request — to mock up an app or tool (a bare description like \"a phone app for X\" is a request), to show what something would look like, to add, change, move or remove something, or a statement of how an element should be (\"this should be bigger\", \"that should be bold\")? Answer no for a question about whether the current design is good, a remark, or an approval.",
    },
    op: {
      type: "choice",
      instructions: "Which single visible edit does `instruction` ask for? `marked` is the element the speaker has pointed at, if any.",
      criteria: OPS,
    },
  };
  if (!routing) for (const q of ["route", "job", "whole", "request", "frame"]) delete questions[q];
  // Whether "this", "it" or "that" means the marked element is a question about meaning, so Jev
  // answers it, not a word list. Measured 2026-09-23: 6/6 on two runs ("make this bigger" 0.74,
  // "make the title bigger" with a button marked 0.07). It and the screen question read `said`,
  // quotes and all: a person writes names in quotes (make "Revenue" bold, the "Orders" screen),
  // and blanking them hid exactly the name the question is about.
  if (marked) {
    questions.points = {
      type: "noul",
      instructions: "Does `said` refer to the `marked` element by pointing at it (this, that, it, here) rather than naming a different element? If `context` is set, `said` is one part of it, and a pointing word may point through it.",
    };
  }
  if (routing && screens.length) {
    questions.screen = {
      type: "choice",
      instructions: "Which screen does `said` name? If it names none, answer the screen in `viewing`.",
      criteria: Object.fromEntries(screens.map((n) => [n, `the ${n} screen`])),
    };
  }
  if (nodes.length) {
    questions.target = {
      type: "choice",
      // Reads the whole sentence: an element is named by its visible words, which may be quoted.
      instructions: "Which element in `elements` does `said` act on? Each label is that element's id; its description is the element. If `said` points at it with a word like this, that or it, the answer is `marked`.",
      criteria: Object.fromEntries(nodes.map((n) => [n.id, `${n.line}${n.screen ? ` · on ${n.screen}` : ""}`])),
    };
  }
  if (cand.length) {
    questions.span = {
      type: "choice",
      instructions: "If `said` gives new words for an element, which candidate is exactly those words, with no surrounding instruction? Answer `none` if it gives none.",
      criteria: { ...Object.fromEntries(cand.map((s, i) => [`s${i + 1}`, `the new words would be: ${s}`])), none: "no new words are given" },
    };
  }

  const started = Date.now();
  const { answers } = await ask({ apiKey, state, questions }, signal);
  // An unanswered question is not an answer: nothing downstream may read a default as Jev's word.
  for (const q of Object.keys(questions)) if (!answers?.[q]) throw new Error(`jev returned no answer for ${q}`);
  return {
    ms: Date.now() - started,
    route: answers.route?.choice ?? null,
    routeConfidence: answers.route?.confidence ?? 0,
    request: answers.request?.noul ?? null,
    op: answers.op?.choice ?? "none",
    opConfidence: answers.op?.confidence ?? 0,
    target: answers.target?.choice ?? null,
    targetConfidence: answers.target?.confidence ?? 0,
    targets: answers.target?.probabilities ?? {},
    span: /^s\d+$/.test(answers.span?.choice ?? "") ? cand[Number(answers.span.choice.slice(1)) - 1] ?? null : null,
    spanConfidence: answers.span?.confidence ?? 0,
    frame: answers.frame?.choice && answers.frame.choice !== "unspecified" ? answers.frame.choice : null,
    frameConfidence: answers.frame?.confidence ?? 0,
    dest: answers.dest?.noul ?? 0,
    screens: answers.screen?.probabilities ?? {},
    job: answers.job?.choice ?? null,
    jobConfidence: answers.job?.confidence ?? 0,
    whole: answers.whole?.noul ?? 0,
    points: answers.points?.noul ?? null,
    screen: answers.screen?.choice ?? null,
    screenConfidence: answers.screen?.confidence ?? 0,
  };
}

// Where a new piece goes: one choice over the gaps on a screen (trial/tree.mjs `gaps`), each
// labelled by position and described by what is around it. A second request, because the gaps
// depend on the screen the first one chose.
export async function place({ utterance, gaps, screen, marked = null, apiKey, signal }) {
  const started = Date.now();
  const { answers } = await ask({
    apiKey,
    state: { said: utterance, screen: screen ?? null, marked: marked ?? null },
    questions: {
      gap: {
        type: "choice",
        instructions: "Where should the piece `said` asks for go? Each option is a gap in the layout, described by what is around it. If `said` points with this, it or here, it means next to `marked`.",
        criteria: Object.fromEntries(gaps.map((g, i) => [`g${i + 1}`, g.text])),
      },
    },
  }, signal);
  const at = (label) => (/^g\d+$/.test(label ?? "") ? Number(label.slice(1)) - 1 : -1);
  const ranked = Object.entries(answers.gap?.probabilities ?? {}).sort((a, b) => b[1] - a[1]).map(([l]) => at(l)).filter((i) => i >= 0);
  return { ms: Date.now() - started, index: at(answers.gap?.choice), confidence: answers.gap?.confidence ?? 0, ranked };
}
