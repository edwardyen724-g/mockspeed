# trial/eval — testing the trial through the app

Every test here goes through the running app. The ten requests in `prompts.json` are sent to
`/ask` exactly as the page's text box sends them, so Jev makes every decision it would make for a
person. A test that calls the writer directly skips Jev and says nothing about the product.

```bash
# 1. the app (or use the "trial" entry in .claude/launch.json)
node trial/server.mjs --port 8772 --env ~/projects/jev-context/.env.local

# 2. the run: ten builds, twelve follow-ups each, ~15-20 min, ~200 Jev decisions
node trial/eval/run.mjs trial/eval/runs/<YYYY-MM-DD>-<name>

# 3. the gallery: newest run first, older runs to compare against
node trial/eval/gallery.mjs <gallery-out-dir> trial/eval/runs/<new>="New" trial/eval/runs/2026-09-23-after-audit="Baseline"
python3 -m http.server 8774 --directory <gallery-out-dir>

# 4. the judges (Workflow tool, five agents): does each decision do what the person meant?
#    { scriptPath: "<repo>/trial/eval/judge.workflow.js", args: { run: "<abs run dir>", gallery: "<abs gallery dir>" } }
#    save its result as <run dir>/verdicts.json, then run step 3 again
```

Needs `TYPESAFE_API_KEY` (Jev) and `ANTHROPIC_API_KEY` (the writer) in the `--env` file, TypeSafe
credits (a run that runs out answers `402 billing_error` on every request after that), and Google
Chrome for the screenshots.

What the script plays: it answers "start a new app" and "yes, remove it" as the person would, and
leaves every other question ("which one?", "where should it go?") unanswered, recording it. So a
"?" in its output is a question the app put to the person, not a failure — the judges say whether
each question was fair or needless. Since act, then offer, the app mostly acts instead and offers
the runner-up as a swap beside its reply. The script records each step's swaps (`offers`) and
clicks none. "≈" is a change with a swap offered and "~" is nothing changed with a swap offered.
The judges say `swap_right` when the change was not what was meant but one click on a swap is.

## This one, or every one like it — `runs/2026-09-26-twins-probe`

Phase 1c of `docs/plan-web-2026-09-26.md` (§4). With one of five prices marked, "make the prices
bigger" changed one price. Now code finds the element's twins (tree.mjs `twinsOf`: each card's
price, each nav item, each card), and Jev answers one question, asked only when there are twins:
does the sentence mean this one or every one like it? The other reading is offered beside the reply
as a swap: *"Made “$5.75” and the 4 others like it bigger · [Just “$5.75” instead] [Undo]"*.

The question was probed before anything relied on it. This is a probe of one Jev question, not a
run through the app:

```bash
node trial/eval/probe-twins.mjs --env ~/projects/jev-context/.env.local --runs 2 --out trial/eval/runs/<dir>/results.json
```

The set has 45 sentences. The first 26 are on a bakery menu page: marked and unmarked, singular and
plural, pointing words (this, these, them) and names ("the croissant price"). The other 19 are held
out, on the email and orchestration apps from the 1b run, with nouns the wording never mentions
(times, senders, checkboxes, agent cards, status dots). Each sentence is run twice.

| wording | right | held out | "every" sentences | "one" sentences |
|---|---|---|---|---|
| the question alone ("…or on every one of `twins`? this / that / it means `target` alone; these / those / them mean every one") | 79/90 | 30/38 | ≥ 0.25 | ≤ 0.08 |
| plus: a plural means every one *even when one of them is marked* (what `jev.mjs` asks) | **90/90** | **38/38** | ≥ 0.51 | ≤ 0.05 |

- **Without that line, the mark pulled Jev to "this one".** "Make the prices bigger" with a price
  marked scored 0.39-0.48 and "make the times lighter" 0.34-0.35. The same sentences unmarked scored
  0.66-0.76.
- **A yes/no wording was worse still.** The first run tried a yes/no question beside the choice: 47/52 on
  the bakery set, and "one" sentences reached 0.22. The choice wording keeps "one" near zero.
- **The least sure answer:** "make the status dots bigger", with a dot marked, came back 0.51 and 0.63
  here. In the tuning run before it, it came back 0.49 once, the one miss out of 90. A wrong pick
  there costs one click on the swap.
- The question takes a median 118 ms and a max of 342 ms, and costs one Jev request. It is asked
  after the element is chosen, and only when the edit will be made directly. "Bigger" on a picture
  goes to the writer, and one-or-every is not asked about it.

**In the app (browser pane, the bakery built from "make a mock of my bakery's website: a menu page
with five breads as cards…").** Tested with one price marked.
- "Make the prices bigger": Jev picked bigger at 0.99, a price at 0.95 and every one at 0.93. All
  five changed, and "Just “$5.75” instead" was offered. The swap left only $5.75 bigger.
- Double-clicking "Ciabatta" and typing renamed it with no question and no model call.
- The toolbar's "All 5 like this" followed by Bold made all five bold, also with no model call.
- When Jev was unsure which element, the alternative was numbered in the mock. Clicking it there
  took the swap (§3D).

What the probe does not cover: `which()` choosing among the twins. It spreads its confidence over
five identical prices; once every one is being changed, those alternatives are dropped rather than
offered. Rewrites ("turn the prices into pills") still act on one element.

## Act, then offer — `runs/2026-09-26-act-then-offer`

Phase 1b of `docs/plan-web-2026-09-26.md` (§3A). The app no longer asks before it acts. Where Jev
is unsure, its top pick is done, and the runner-up is offered beside the reply as a one-click swap,
with Undo: *"Removed the “New Agent” button · [The “Filter” button on the “Logs” page instead]
[Undo]"*. A wrong guess costs one click. A question cost a read, a decision and a click every time,
even when Jev was right.

1. **Every former question acts.** Which element, which page, where a new piece goes (at each
   level of the top-down placement), a new page or on a page, what kind of change, and "remove
   it?". Each keeps its old answer as the swap, so a swap runs the same code an answer did.
   `trial/turn.mjs` keeps the sentence's record: per part, the canvas before it, its changes (each
   as a `redo` that makes the same change on another canvas), its doubts, and the piece it wrote. A
   swap goes back to its part's canvas and does the alternative. A new piece is put at the new
   place without being written again: it is the same piece. The later parts of a split sentence are
   then made again on top. The offer is the alternatives to the decision Jev was least sure of, one
   per part. The Undo beside the reply takes back the whole sentence; the Undo button, one change.
2. **Two questions stay.** Before a new app when Jev's likeliest kind of change is a new app by
   less than 0.2 over the next (a full build replaces everything), and before clearing on an unsure
   answer. Neither fired here.
3. **When Jev says the thing named is not there** (`exists` < 0.3: "make the navigation darker" on
   an app with no navigation), nothing is done to a stand-in. The reply says so, and the likeliest
   three are offered as the edit itself ("Make the “Title” card darker"). The counts below treat
   that as a question, and so a reply that changed nothing but offered a swap ("already there ·
   [at the top of the part with “Filter…” instead]").

372 Jev decisions, builds 10/10, no errors. Against `2026-09-26-plain-words`, same sentences (119:
one app had no button left to move):

| | plain words | act, then offer |
|---|---|---|
| questions asked first | 33 | **0** |
| nothing changed, swaps offered (counted as questions) | — | 2 |
| questions per sentence | 0.28 | **0.02** |
| follow-ups that changed the mock | 77 | **100** |
| changes with a swap offered beside them | — | 33 (9 edits, 5 rewrites, 4 adds, 6 moves, 11 split) |
| answers the script gave | 5 | 0 |
| median time per follow-up | 0.4 s | 0.9 s (more sentences run to the end) |

Judged by five agents: **104 of 119 follow-ups right**: 78 right the first time, 7 right by the
offered swap, 19 correctly nothing. Then 13 partly, 2 wrong, no questions at all. Build substance
2.0 / 3. The jev-fixes run's 90/120 counted 11 fair questions as right; there is none here.

| sentence | judged |
|---|---|
| make the title bigger | 8 right, 2 by the swap |
| remove the last button | 8 right, 1 by the swap, 1 correctly nothing |
| turn the main list into a table | 6 right, 1 by the swap, 2 partly, 1 wrong |
| add a filter and make the title bigger | 2 right, 2 by the swap, 6 partly |
| add a note to the "…" screen | 9 right, 1 by the swap |
| move the … button to the top of the screen | 7 right, 2 partly |

Still weak, from the judges (writer 36 issues, Jev 18, render 7, edit 6):

- **"Add a filter" lands at the end of the main area**, under a table, on four apps. It is an open
  sentence, so it goes to the end of the part. The swap fixed two of them.
- **"The title" in a split part went to a sure wrong pick**: a nav item, or the title on another
  page, at 0.96. A sure pick offers no swap.
- **"Remove the last button"** picks by the page being looked at, not by order ("last").
- **The writer**: tables written as a column of rows with empty cells; a second header added for
  "add a search field"; "add a filter" written as a "Clear filters" button; a new page's nav item
  missing from the other pages' copies of a shared nav.

## Plain words — `runs/2026-09-26-plain-words`

Phase 1a of `docs/plan-web-2026-09-26.md`: what a person reads is in their words, and the
questions with no decision behind them are gone.

1. **One module owns the words.** `trial/words.mjs` writes every question, choice, reply and
   page string. Things are named by what is on them ("the “You are owed” card", "the “Order
   now” button"). Places are named by what is around them ("between “Address” and “Hours”").
   A website has pages; a phone app has screens. Jev and the writer still read tree.mjs's lines,
   so their measured wording is unchanged. Scores, timings, model names and the engine's log sit
   behind `?debug=1`. `trial/test/words.test.mjs` renders every template against the twenty
   outlines of `runs/2026-09-23-jev-fixes` and fails on an engine word outside quotes.
2. **No "start a new app?"** An empty canvas builds. A new app on a full canvas replaces it and
   offers "Bring back “Relay”" (Undo), as does the new **New** button, until phase 3's project
   list keeps it.
3. **No "change the mockup, or is it a remark?"** When Jev's request gate and its route disagree,
   the sentence is taken as a change.
4. **No "what kind of change?"** once the element is known (marked and pointed at, or an
   escalated edit's target): Jev's top answer is taken when it is add, rewrite or several.
5. **No "which screen?"** when the sentence names something on one screen ("under the
   address"): a new Jev question, `anchor`, says which screen that thing is on. It was probed
   before use, since none of the ten sentences here names one (the question never fired in this
   run). 20 sentences over six apps, twice: 24/24 right at 0.94-1.00 for a thing on another
   screen. The `screen` question was under 0.6 on 18 of those 24, and its top pick was wrong 6
   times. 16/16 stayed on the screen being looked at when the sentence names nothing, or names
   something on several screens.

354 Jev decisions, builds 10/10, no errors. Against `2026-09-23-jev-fixes`, same sentences:

| | jev-fixes | plain words |
|---|---|---|
| questions put to the person | 49 | **33** |
| "start a new app?" | 9 | **0** |
| "change or remark?" | 0 | 0 |
| "what kind of change?" | 1 | 0 |
| which one / where / remove | 21 / 12 / 6 | 16 / 12 / 5 |
| answers the script gave | 16 | **5** |
| sentences that changed the mock | 87 | 87 |
| questions, choices and replies with an engine word | 110 | **1** |

The one engine word left is the writer's own: asked to add a search field that already existed,
it answered in words, quoting the outline ("…at row · input "Search"…"). "Add a search field at
the top" changed 6 apps where the baseline changed 9. No new code ran there: Jev's spot scores on
two apps' differently written top parts fell to 0.24 and 0.08, and the email writer declined as
above. Not judged: the five-agent judges (step 4) were not run on this run.

## After the Jev fixes — `runs/2026-09-23-jev-fixes`

Five changes, each probed on a sentence set before the server changed:

1. **Which element** — Jev names the kind of element (text, button, group, …); code offers only
   elements of that kind that the edit would change, or that are already as far as it goes. It
   leaves out screens and bare wrappers, and labels each one with where it sits (item 2 of a
   list, the left side of the screen, the largest text on it). A separate `exists` question
   catches "the navigation" in an app with none.
2. **Placement top down** — which part of the screen, then where in it, a few options at a time.
   A sentence that names no spot ("add a filter", "add a note to …") goes next to the element Jev
   says it belongs with, or to the end of the part, instead of asking.
3. **Only inside the padding** — no gaps directly in a screen; a move to where the element already
   is says "already there".
4. **Split parts** — a part that needs the person no longer holds up the parts after it. Jev
   decides whether a later part needs a waiting one.
5. **Shared elements** — `share=<name>` on the nav, top bar or tab bar copies (FORMAT.md). An
   edit to one copy changes every copy, and Jev sees each shared element once.

354 Jev decisions (now counting element and split-part decisions, so not comparable with the 214
below), 16 answers from the script, builds 10/10. Judged by five agents: **90 of 120 follow-ups
right** (63 right, 11 fair questions, 16 correctly nothing), then 12 partly, **16 needless
questions**, 2 wrong. Build substance 2.0 / 3 (the writer is unchanged).

| sentence | baseline → now |
|---|---|
| make the title bigger (unmarked) | 1 right, 8 fair asks → 5 right, 4 fair asks, 1 wrong |
| make the navigation darker | 2 right, 4 needless → 8 right (every shared copy), 1 needless |
| add a search field at the top | 7 right, 3 partly → 5 right, 3 partly, 1 needless, 1 wrong |
| turn the main list into a table | 2 right, 4 needless → 4 right, 3 fair, 3 needless |
| add a filter and make the title bigger | 5 needless, 4 fair → 3 right, 6 partly, 1 needless |
| move the … button to the top of the screen | 4 right, 3 partly → 5 right, 2 partly, 2 needless |
| add a note to the "…" screen | 2 right, 6 needless → 8 right, 1 needless |
| make this bold and move it to the top | 1 right, 6 partly → 6 right or correctly nothing, 4 needless |

Still weak, from the judges: a move to the top of something already at the top asks instead of
saying "already there" when Jev is unsure (4 needless). A filter lands at the end of the main area
when Jev's "next to the search field" is under 0.4. "The last button" isn't read as an order.
Where a new screen goes asked twice (the screen-gap question is unchanged).

## Baseline — `runs/2026-09-23-after-audit`

The first full run after the audit fixes (Jev decides job, screen, gap, element, pointing, move
destination, frame; questions for the person under the text box). 214 Jev decisions, 16 answers
from the script. Routed 127/128 (the other was a 529 overload, since retried). Builds 10/10.

Judged by five agents: 77 of 118 follow-ups right — 45 right, 22 fair questions, 10 correctly
nothing — then 17 partly, 21 needless questions, 2 wrong, 1 missed. Build substance 2.1 / 3.

| sentence | outcome | judged |
|---|---|---|
| build | 10 built | substance 2.1 |
| make the title bigger (unmarked) | 9 asked which one | 8 fair asks — every screen has its own title |
| make the navigation darker | 4 changed, 6 asked | 4 needless asks, 1 wrong |
| make this bigger (marked) | 10 changed | 10 right |
| remove the last button | 6 removed after yes, 4 asked | 6 right |
| add a search field at the top | 10 placed | 7 right, 3 partly (above the header) |
| is this layout too busy? | 10 nothing | 10 correctly nothing |
| add a settings screen | 10 placed | 10 right |
| turn the main list into a table | 5 changed, 5 asked | 2 right, 4 needless asks |
| add a filter and make the title bigger | 9 asked where | 5 needless asks — and the title part waited |
| move the … button to the top of the screen | 7 moved | 4 right, 3 partly (outside the padding) |
| add a note to the "…" screen | 3 placed, 6 asked | 6 needless asks |
| make this bold and move it to the top | 7 changed | 6 partly |
