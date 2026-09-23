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

const ENDPOINT = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-haiku-4-5";

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

COMPOSE — there are no ready-made widgets, and you never need one:
- side nav: row h=fill, then col w=200 fill=light pad=3 gap=2 holding texts, the current one bold, the rest shade=mid; then col grow for the main area
- tabs: row gap=4 of texts, the current one bold under, the rest shade=mid
- bottom bar on a phone: the screen's last child, a row justify=between pad=3 border of small texts
- cards: col border pad=3 gap=1; a kanban board is a row of cols of cards
- chat: col gap=2 of rows, each a circle shape w=28 h=28 and a col of texts
- anything connected — a pipeline, workflow, agents handing work to each other, a state machine, an org chart — is a graph
- a status dot: shape circle w=8 h=8 fill=dark|mid|light
Name ids after what they are (#planner, #nav) — never n1, n2: those are taken by nodes without ids.

Realistic, specific fake data: real-sounding names that fit what things are, plausible numbers and times, a mix of states with one edge case (failed, empty, overdue, very long). Put the flag data on texts and tr rows that are data. No placeholders, no lorem ipsum.
Greyscale only; emphasis is size, bold and shade. Text on fill=dark turns light by itself — give it no shade unless it should be fainter.`;

const APP = `You write greyscale wireframe mockups as an indented outline that code renders. A person describes an app; you write it, starting with the app line.

${FORMAT}

BUILDING AN APP
First decide what the product's substance is and show that, not a generic dashboard of numbers: an orchestration tool shows agents handing work to each other as a graph and a run as it happens; a chat app shows the thread; a map app is mostly map. 2-3 screens. On each screen: its navigation, then the one thing the screen is for, made the biggest, boldest and darkest thing on it, then only what supports it.
At most about twenty words of non-data text per screen: no explanations, no helper text, no headings that describe the screen.

Output only the outline, starting with the app line. No markdown fences, no commentary.`;

const PIECE = `You write one piece of a greyscale wireframe mockup, as an indented outline fragment that code renders and puts in place. Where it goes has already been decided; you only write what goes there.

${FORMAT}

WRITING A PIECE
Write only the piece: top-level lines at indent 0, children indented under them. No app line, no patch headers, nothing about where it goes. Write a screen line only if you were asked for a whole screen.
Match the mockup around it: the same sizes, shades and spacing for the same kind of thing, and data that agrees with what is already there (the same people, the same amounts).
If you are replacing an element, write its replacement in full, keeping whatever the person did not ask to change.
Keep it small: what was asked for, and nothing else.
If you will not or cannot write it, answer with one line starting with // saying why, and nothing else.

Output only the fragment. No markdown fences, no commentary.`;

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

// One streamed request; `onLine` gets each complete line as it arrives.
async function stream({ system, context, apiKey, model = MODEL, onLine = () => {}, signal, maxTokens = 8000 }) {
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: context }] }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error?.message ?? msg; } catch {}
    throw new Error(`${model} ${res.status}: ${msg}`);
  }
  let text = "", pending = "", buffer = "", lines = 0, firstLineMs = null, outputTokens = 0, stop = null;
  const emit = (raw) => {
    // Fences are the one decoration models add whatever the prompt says; they are not outline.
    if (/^\s*```/.test(raw) || !raw.trim()) return;
    lines += 1;
    if (firstLineMs === null) firstLineMs = Date.now() - started;
    text += raw + "\n";
    onLine(raw);
  };
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = event.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6));
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        pending += e.delta.text;
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) { emit(pending.slice(0, nl).replace(/\r$/, "")); pending = pending.slice(nl + 1); }
      } else if (e.type === "message_delta") {
        outputTokens = e.usage?.output_tokens ?? outputTokens;
        stop = e.delta?.stop_reason ?? stop;
      } else if (e.type === "error") {
        throw new Error(`${model} stream: ${e.error?.message ?? "error"}`);
      }
    }
  }
  emit(pending);
  return { text, lines, firstLineMs, ms: Date.now() - started, outputTokens, stop, model };
}

// A new app, streamed a line at a time onto an empty canvas. `frame` is decided before the writer
// is called (Jev, or the person); when it is set, the app line must carry it.
export function writeApp({ utterance, frame = null, apiKey, model, onLine, signal }) {
  const context = `${frame ? `It runs on: ${frame}. Write the app line with that frame.\n\n` : ""}The person says: ${utterance}`;
  return stream({ system: APP, context, apiKey, model, onLine, signal });
}

// One piece. `outline` is the whole mockup with ids, for style and data; `where` is Jev's chosen
// gap in words; `replacing` is the outline of the element being replaced, when it is a rewrite.
// `screen` says the piece must be a whole screen (start with a screen line); false says it must not
// contain one. `retry` is set on the second attempt after the first came back the wrong shape.
export function writePiece({ utterance, outline, where, replacing = null, screen = false, retry = false, apiKey, model, signal }) {
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
  return stream({ system: PIECE, context, apiKey, model, signal, maxTokens: 4000 });
}

// Several changes → one per line. The writer is not shown the mockup: cutting a sentence needs
// none of it, and shown it, the writer refused to cut when a named thing was not on it, or asked
// what "this" was. `marked` says only that something is marked; Jev resolves what the words mean.
export async function split({ utterance, marked = false, apiKey, model, signal }) {
  const context = `${marked ? "The person has marked an element.\n" : ""}The person says: ${utterance}`;
  const r = await stream({ system: SPLIT, context, apiKey, model, signal, maxTokens: 600 });
  return { ...r, parts: r.text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean) };
}
