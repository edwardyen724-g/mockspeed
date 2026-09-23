// brain — the writing layer. A fast, cheap model turns what the person typed into short
// instructions, one per line, in words Jev can decide on.
//
// It is the only part of the canvas that writes: the app's name, the screen names, the fake data.
// It never touches the spec. Each line it writes goes to Jev like a sentence the person could
// have typed, Jev decides which edit it is, ops.mjs applies it, and the renderer draws it. Lines
// are handed over as they stream in, so the mock assembles while the model is still writing.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
export const MODEL = "claude-haiku-4-5";

const SYSTEM = `You are the front half of a greyscale mockup canvas. A person types a request. You rewrite it as short instructions, one per line, for a small decision model that maps each line onto a closed set of edits. That model cannot write words: every name, label and piece of fake data must already be in your line, inside double quotes. It only decides which edit, which screen, which element.

Write lines in exactly these shapes:
start a new <web|phone|panel> app "<App name>"  phone for anything mobile, panel for a sidebar or plugin, else web
add a screen "<Screen name>"
on <Screen>: add a <kind> "<content>"
on <Screen>: add a heavy <kind> "<content>"      heavy = the one thing this screen is for
on <Screen>: add a quiet <kind> "<content>"      quiet = chrome and metadata
make the <element> the main thing
make the <element> louder
make the <element> quieter
move the <element> up
move the <element> down
rename the <element> to "<new words>"
remove the <element>
clear the canvas                                  everything goes; one line, never a remove per element

Content inside the quotes, by kind. ; separates rows, | separates fields within a row. Never put a double quote inside the content.
stat    "<value> | <caption> | <note>"                     ONE number, e.g. "2 blocked | 9 agents live | $4.12 of $10 today"
row     "<value> | <caption>; <value> | <caption>; ..."    numbers side by side
table   "<col> | <col> | <col>; <cell> | <cell> | <cell>; ..."   first row is the header, 4-7 body rows
list    "<text> | <sub> | <meta>; ..."                     4-7 rows
chips   "<a>, <b>, <c>"
tabs    "<Screen A>, <Screen B>, <Screen C>"               the app's sections — the same tabs on every screen
button  "<Label>"
field   "<Label> | <what is typed in it>"
text    "<one short line>"

Building an app: a request for a new app starts fresh — ignore what is on the canvas and what is marked, and write only build lines, no edits. One start line, then 2-4 screens. For each screen: its add-a-screen line, then 3-7 elements in reading order, tabs first. Exactly one heavy element per screen — the thing the screen exists for; everything else is plain or quiet. Write realistic, specific fake data that fits what the things are: real-sounding names, plausible numbers and times, a mix of states including one edge case (failed, overdue, empty, very long). No placeholders, no lorem ipsum, no "Item 1". At most twenty words of non-data text per screen: no explanatory text, no section headings, no helper text.

Editing: write exactly one line per change the person asked for, nothing more. Never add lines that tidy up around it — making something the main thing already steps the old main thing back. Call the marked element "this". Name any other element by what it shows, without quotes — quotes are only for new words ("the tasks table", "the Approve button").
  make this the main thing                  ->  make this the main thing
  the table is too loud, add a pause button ->  make the tasks table quieter
                                                on Tasks: add a button "Pause all"

If the person asks a question, makes a remark or approves, write nothing at all. If you cannot tell what they want, write one short question back to them instead of instructions.

Output only instruction lines. No numbering, no commentary, no blank lines, no markdown.`;

// What an instruction line looks like. Anything else the model writes — a question back, an
// explanation, "(no output)" — is talking to the person, not to Jev, and is handed to onProse
// instead of being decided on. Before this, prose lines went to Jev as if they were edits.
const INSTRUCTION = /^(?:start a new |add a screen |on [^:]{1,60}:\s*add |make |move |rename |remove |clear the canvas)/i;

// state: { title, frame, screens: [names], elements: [descriptions], marked }
export async function translate({ utterance, state, apiKey, model = MODEL, onLine, onProse = () => {}, signal }) {
  const started = Date.now();
  const context = [
    `Canvas now: ${state.screens.length ? `"${state.title}" (${state.frame}), screens: ${state.screens.join(", ")}` : "empty"}`,
    ...(state.elements.length ? ["Elements:", ...state.elements] : []),
    `Marked: ${state.marked ? `${state.marked} — call it "this"` : "nothing"}`,
    "",
    `The person says: ${utterance}`,
  ].join("\n");

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 4000, stream: true, system: SYSTEM,
      messages: [{ role: "user", content: context }],
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error?.message ?? msg; } catch {}
    throw new Error(`${model} ${res.status}: ${msg}`);
  }

  // Server-sent events: text arrives in content_block_delta events. Lines are cut on newlines and
  // handed on the moment each one is complete.
  let pending = "", buffer = "", lines = 0, firstLineMs = null, outputTokens = 0, stop = null;
  const emit = (raw) => {
    const line = raw.trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/, "").replace(/^`+|`+$/g, "").trim();
    if (!line) return;
    if (!INSTRUCTION.test(line)) return onProse(line);
    lines += 1;
    if (firstLineMs === null) firstLineMs = Date.now() - started;
    onLine(line);
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
        while ((nl = pending.indexOf("\n")) >= 0) { emit(pending.slice(0, nl)); pending = pending.slice(nl + 1); }
      } else if (e.type === "message_delta") {
        outputTokens = e.usage?.output_tokens ?? outputTokens;
        stop = e.delta?.stop_reason ?? stop;
      } else if (e.type === "error") {
        throw new Error(`${model} stream: ${e.error?.message ?? "error"}`);
      }
    }
  }
  emit(pending);
  return { lines, firstLineMs, ms: Date.now() - started, outputTokens, stop, model };
}
