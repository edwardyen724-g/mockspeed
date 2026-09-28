// writer — the writing layer of the trial. A fast model writes words and structure; it decides
// nothing about where things go. Three jobs, each with its own instructions:
//
//   writeApp    a whole new app, as an outline of primitives (trial/FORMAT.md), onto an empty canvas
//   writePiece  one piece — a new element, section or screen, or the replacement for one element —
//               as an outline fragment; Jev has already chosen where it goes, code puts it there
//   split       a sentence asking for several changes, rewritten as one change per line, each of
//               which then goes back through Jev on its own
//
// In canvas/ the writer wrote sentences and Jev re-read each one to recover its structure, a round
// trip where most of the canvas's bugs lived. In the first version of this trial the writer also
// wrote patches ("in n12:", "after n30:") and so chose where its own pieces went; through the app,
// half of those patches came back garbled. Placement is a closed choice, so it is Jev's.

import { meter } from "./meter.mjs";

// The writer's models: Sonnet 5 writes a whole new app, the first thing a person sees; Haiku 4.5
// writes pieces and cuts sentences, where speed and price matter more than range.
export const MODEL = "claude-haiku-4-5";
export const BUILD_MODEL = "claude-sonnet-5";

const FORMAT = `FORMAT
One node per line; two-space indentation is nesting.
<type> [#id] ["text"] [key=value | key="value with spaces" | flag]...
edge <from> -> <to> ["label"]

app "Name" web|phone|panel     the root; its children are screens
screen "Name"                  one artboard; children stack top to bottom
row | col | grid cols=N        containers
text "words"                   size=xs|s|m|l|xl|xxl  bold  shade=dark|mid|light  mono  pill  under  data
button "Label"                 primary | ghost   (default outlined)
input "Label"                  value="..."  area | check | toggle | select | search   on
shape "label"                  circle | pill  w= h=   stands in for any picture: image, avatar, icon, map, video
line                           a divider
progress "label"               value=0..100
chart "caption"                bar | line  values=3,5,2,8  h=
table, then tr "a | b | c"     the first tr is the header row
graph dir=right|down h=        children: node #id "Label" sub="second line", and edge a -> b "label"
Layout, on containers (w, h and grow on anything): w=<px>|fill  h=<px>|fill  grow  gap=0..6  pad=0..6  fill=light|mid|dark  border  divider  align=start|center|end|stretch  justify=start|center|end|between
share=<name>                   on something drawn on several screens — the side nav, a top bar, a bottom bar: every copy carries the same share=<name>, and a change to one is made to all

COMPOSE — there are no ready-made widgets, and you never need one:
- side nav: row h=fill, then col share=nav w=200 fill=light pad=3 gap=2 holding texts, the current one bold, the rest shade=mid; then col grow for the main area
- tabs: row gap=4 of texts, the current one bold under, the rest shade=mid
- bottom bar on a phone: the screen's last child, a row share=tabs justify=between pad=3 border of small texts
- what every screen shows — the side nav, a top bar with the app's name, a bottom bar — is one element drawn on each: write it the same on every screen, with the same share=<name>; only which item is current differs
- cards: col border pad=3 gap=1; a kanban board is a row of cols of cards
- chat: col gap=2 of rows, each a circle shape w=28 h=28 and a col of texts
- anything connected — a pipeline, workflow, agents handing work to each other, a state machine, an org chart — is a graph
- a status dot: shape circle w=8 h=8 fill=dark|mid|light
Name ids after what they are (#planner, #nav) — never n1, n2: those are taken by nodes without ids.

Realistic, specific fake data: real-sounding names that fit what things are, plausible numbers and times, a mix of states with one edge case (failed, empty, overdue, very long). Put the flag data on texts and tr rows that are data. No placeholders, no lorem ipsum.
Greyscale only; emphasis is size, bold and shade. Text on fill=dark turns light by itself — give it no shade unless it should be fainter.`;

// The next steps a person might take, offered under the text box as one-click suggestions:
// written in the same call as what they follow, so they cost a line.
const NEXT_STEPS = `NEXT STEPS
End with one more line: // next: followed by five things the person might ask for next, separated by |. Each is a short instruction in plain words, at most six words, the way the person would say it: something to add that is not there yet, a new page, or a change to what is there. For example: // next: Add customer reviews | Add a catering page | Make the prices bigger | Add a photo of the shop | Turn the menu into a list
Say page for a website and screen for a phone app. Never use layout words (row, column, border, padding) or ids.`;

const APP = `You write greyscale wireframe mockups as an indented outline that code renders. A person describes an app; you write it, starting with the app line.

${FORMAT}

BUILDING AN APP
First decide what the product's substance is and show that, not a generic dashboard of numbers: an orchestration tool shows agents handing work to each other as a graph and a run as it happens; a chat app shows the thread; a map app is mostly map. 2-3 screens. On each screen: its navigation, then the one thing the screen is for, made the biggest, boldest and darkest thing on it, then only what supports it.
At most about twenty words of non-data text per screen: no explanations, no helper text, no headings that describe the screen.

${NEXT_STEPS}

Output only the outline, starting with the app line, then the next line. No markdown fences, no commentary.`;

const PIECE = `You write one piece of a greyscale wireframe mockup, as an indented outline fragment that code renders and puts in place. Where it goes has already been decided; you only write what goes there.

${FORMAT}

WRITING A PIECE
Write only the piece: top-level lines at indent 0, children indented under them. No app line, no patch headers, nothing about where it goes. Write a screen line only if you were asked for a whole screen.
Match the mockup around it: the same sizes, shades and spacing for the same kind of thing, and data that agrees with what is already there (the same people, the same amounts).
If you are replacing an element, write its replacement in full, keeping whatever the person did not ask to change.
Keep it small: what was asked for, and nothing else.
If you will not or cannot write it, answer with one line starting with // saying why, and nothing else.

${NEXT_STEPS} Think of the mockup with your piece in it.

Output only the fragment, then the next line. No markdown fences, no commentary.`;

const SPLIT = `A person asked for several changes to a mockup in one sentence. Cut it into separate requests, one change per line. Cutting is all you do: copy the person's words exactly, including every word they used to point at things — this, it, that, the title, the settle up button — spelled exactly as they wrote it. What those words point at is decided after you, so you never need to know it and never ask about it. Do not add, drop, merge or rename anything. If the sentence cannot be cut, write it back unchanged on one line.

Examples:
make this bold and move it to the top
->
make this bold
move it to the top

remove the settle up button and add a pay button
->
remove the settle up button
add a pay button

make it bigger, bold, and put it under the header
->
make it bigger
make it bold
put it under the header

Output only the lines. No numbering, no commentary.`;

// Where the writer's words come from — the writer provider switch. Anthropic by default. OpenRouter,
// one OpenAI-shaped API in front of many models, is there to try a cheaper writer: it takes its own
// key and its own model names ("google/gemini-2.5-flash"), and says what each call cost. Each
// provider makes the request and reads one server-sent event: the text in it, and into `u` what it
// says about tokens and stopping.
const take = (u, x) => {
  if (!x) return;
  if (x.input_tokens != null) u.input = x.input_tokens;
  if (x.output_tokens != null) u.output = x.output_tokens;
  if (x.cache_read_input_tokens != null) u.cacheRead = x.cache_read_input_tokens;
  if (x.cache_creation_input_tokens != null) u.cacheWrite = x.cache_creation_input_tokens;
};
// Thinking, per model, for a writer that streams to a person watching: Sonnet 5 thinks by default
// when the request says nothing, which holds back the first line; off, the page starts drawing
// sooner. Haiku 4.5 does not think unless asked.
const THINKING = { "claude-sonnet-5": { type: "disabled" } };
export const PROVIDERS = {
  anthropic: {
    endpoint: "https://api.anthropic.com/v1/messages",
    request: ({ apiKey, model, system, context, maxTokens }) => ({
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: { model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: context }], ...(THINKING[model] ? { thinking: THINKING[model] } : {}) },
    }),
    read(e, u) {
      if (e.type === "message_start") take(u, e.message?.usage);
      else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") return e.delta.text;
      else if (e.type === "message_delta") { take(u, e.usage); u.stop = e.delta?.stop_reason ?? u.stop; }
      else if (e.type === "error") throw new Error(`stream: ${e.error?.message ?? "error"}`);
      return "";
    },
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    request: ({ apiKey, model, system, context, maxTokens }) => ({
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: { model, max_tokens: maxTokens, stream: true, usage: { include: true }, messages: [{ role: "system", content: system }, { role: "user", content: context }] },
    }),
    read(e, u) {
      if (e.error) throw new Error(`stream: ${e.error.message ?? "error"}`);
      if (e.usage) {
        u.cacheRead = e.usage.prompt_tokens_details?.cached_tokens ?? 0;
        u.input = (e.usage.prompt_tokens ?? 0) - u.cacheRead;
        u.output = e.usage.completion_tokens ?? u.output;
        if (typeof e.usage.cost === "number") u.cost = e.usage.cost;
      }
      const c = e.choices?.[0];
      if (c?.finish_reason) u.stop = c.finish_reason;
      return c?.delta?.content ?? "";
    },
  },
};

// One streamed request; `onLine` gets each complete line as it arrives. Each request is told to
// the meter (trial/meter.mjs) with what it was for (`purpose`), whether it finished, and the tokens
// the provider reported — a refused request with none.
async function stream({ system, context, apiKey, model = MODEL, provider = "anthropic", purpose = "write", onLine = () => {}, signal, maxTokens = 8000 }) {
  const P = PROVIDERS[provider];
  if (!P) throw new Error(`no writer provider "${provider}"`);
  const started = Date.now();
  const u = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, stop: null, cost: undefined };
  const told = (status) => meter({ provider, model, purpose, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, ms: Date.now() - started, firstLineMs, status, ...(u.cost != null ? { cost: u.cost } : {}) });
  let firstLineMs = null;
  const { headers, body } = P.request({ apiKey, model, system, context, maxTokens });
  let res;
  try {
    res = await fetch(P.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (e) { told("failed"); throw e; }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = j.error?.message ?? msg; } catch {}
    told(`http ${res.status}`);
    throw new Error(`${model} ${res.status}: ${msg}`);
  }
  let text = "", pending = "", buffer = "", lines = 0;
  const emit = (raw) => {
    // Fences are the one decoration models add whatever the prompt says; they are not outline.
    if (/^\s*```/.test(raw) || !raw.trim()) return;
    lines += 1;
    if (firstLineMs === null) firstLineMs = Date.now() - started;
    text += raw + "\n";
    onLine(raw);
  };
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = event.split("\n").find((l) => l.startsWith("data: "));
        if (!data || data === "data: [DONE]") continue;
        pending += P.read(JSON.parse(data.slice(6)), u);
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) { emit(pending.slice(0, nl).replace(/\r$/, "")); pending = pending.slice(nl + 1); }
      }
    }
  } catch (e) {
    told("broken");
    throw new Error(`${model} ${e.message}`);
  }
  emit(pending);
  told(u.stop === "max_tokens" || u.stop === "length" ? "cut off" : "ok");
  return { text, lines, firstLineMs, ms: Date.now() - started, outputTokens: u.output, inputTokens: u.input, stop: u.stop, model };
}

// The next steps an answer ends with ("// next: Add reviews | Add a catering page"), taken off it:
// { text, next }. They are the writer's words for the person, not outline.
const NEXT = /^\s*\/\/\s*next\s*:\s*/i;
export function nextSteps(text) {
  const lines = String(text ?? "").split("\n");
  const at = lines.findIndex((l) => NEXT.test(l));
  if (at < 0) return { text, next: [] };
  const next = [...new Set(lines[at].replace(NEXT, "").split("|")
    .map((s) => s.trim().replace(/^["“'`]+|["”'`.]+$/g, "").trim()).filter(Boolean))];
  return { text: lines.filter((_, i) => i !== at).join("\n"), next };
}
const withNext = (r) => ({ ...r, ...nextSteps(r.text) });

// A new app, streamed a line at a time onto an empty canvas. `frame` is decided before the writer
// is called (Jev, or the person); when it is set, the app line must carry it.
export async function writeApp({ utterance, frame = null, apiKey, model = BUILD_MODEL, provider, onLine = () => {}, signal }) {
  const context = `${frame ? `It runs on: ${frame}. Write the app line with that frame.\n\n` : ""}The person says: ${utterance}`;
  return withNext(await stream({ system: APP, context, apiKey, model, provider, purpose: "build", onLine: (l) => { if (!NEXT.test(l)) onLine(l); }, signal }));
}

// One piece. `outline` is the whole mockup with ids, for style and data; `where` is Jev's chosen
// gap in words; `replacing` is the outline of the element being replaced, when it is a rewrite.
// `screen` says the piece must be a whole screen (start with a screen line); false says it must not
// contain one. `retry` is set on the second attempt after the first came back the wrong shape.
export async function writePiece({ utterance, outline, where, replacing = null, screen = false, retry = false, apiKey, model, provider, signal }) {
  const shape = screen
    ? " It is a whole new screen: start with a screen line."
    : " It goes on a screen that already exists: do not write a screen line.";
  const context = [
    `The mockup now:\n${outline}`,
    "",
    (replacing ? `You are replacing this element:\n${replacing}` : `The new piece goes ${where}.`) + shape +
      (retry ? " Your last answer had the wrong shape; follow this exactly." : ""),
    "",
    `The person says: ${utterance}`,
  ].join("\n");
  return withNext(await stream({ system: PIECE, context, apiKey, model, provider, purpose: replacing ? "rewrite" : "piece", signal, maxTokens: 4000 }));
}

// Several changes → one per line. The writer is not shown the mockup: cutting a sentence needs
// none of it, and shown it, the writer refused to cut when a named thing was not on it, or asked
// what "this" was. `marked` says only that something is marked; Jev resolves what the words mean.
export async function split({ utterance, marked = false, apiKey, model, provider, signal }) {
  const context = `${marked ? "The person has marked an element.\n" : ""}The person says: ${utterance}`;
  const r = await stream({ system: SPLIT, context, apiKey, model, provider, purpose: "split", signal, maxTokens: 600 });
  return { ...r, parts: r.text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean) };
}
