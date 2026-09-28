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

## Engine as a library — `runs/2026-09-27-engine-library`

The canvas moved out of `trial/server.mjs` into `trial/engine.mjs`, one `project()` per canvas, with
its logic line for line as it was. The server routes `/` to the project it opened (the one this
script drives, at the paths it always used) and `/p/<id>/` to the others. This run checks that the
move changed nothing the app does. It is not a new measurement, and the judges were not re-run.

364 Jev decisions, builds 10/10, 130 steps, no errors, **0 questions asked first**. 97 of 120
follow-ups changed the mock, 49 of them with a swap offered. 8 changed nothing, each with a swap
offered, and each is from phases 1c–1d or the writer's builds, not the move:
- 3× "make this bold and move it to the top" on a marked element already bold and at the top.
- 2× "add a search field at the top" where the build already had one, so it was shown with "Add
  another" (check before adding).
- 2× "make the navigation darker" with no navigation.
- 1× the writer answering in words.

The last full run before this, `2026-09-26-act-then-offer`, came before phases 1c–1d: 100 of 119
changed and 2 changed nothing.

## Export — `runs/2026-09-27-export-probe`

The footer's Export menu offers three things. **Download the mock (.html)** is the render with each
page anchored, the pages listed at the top, the navigation's page names linked, and no script
(`/export.html`). **Copy a prompt for your AI site builder** is `/prompt`, and **Download the prompt
as a file (.md)** is the same text (`/export.md`). The prompt is built by code from the outline
(`trial/export.mjs`), not by a model: a fixed header that asks for semantic HTML and says to keep
the pages, the order, the emphasis and every word, then each shared bar once, then each page top to
bottom, every word quoted as written.

The bar is that the prompt, pasted once into an AI builder, yields a site with semantic tags.
Sonnet 5 stood in for the builder, with one line of system prompt standing in for the builder's own
("answer with one complete HTML file"):

```bash
node trial/eval/probe-export.mjs --env ~/projects/jev-context/.env.local --outline <mock.outline> --out trial/eval/runs/<dir>
```

The mock was a bakery built through the app from the first starter, plus "add a contact form with name,
email, phone and a message on the hours & location page" (`bakery.outline`; the prompt is `prompt.md`,
2,994 characters). It came back in 104 s, 10,908 output tokens (5,476 of them thinking), about $0.11:

| asked for | in `built.html` |
|---|---|
| header, nav, main, footer | 1 each, and a `section` per page (3) |
| one h1 per page | 3: “Flour & Rise”, “Menu”, “Hours”, the prompt's own picks |
| forms with labels | 3 forms, 12 fields, 12 labelled |
| input types that fit | email, tel, textarea, text |
| buttons for actions, links for navigation | 3 buttons, 7 links |
| images with alt text | 1 of 1 |
| every word as written | 40 of 40 |

Two things the export had to cope with, both from the writer and both kept as they are in the mock:
`share=nav` on the side nav **and** on the row holding it beside the whole page, where the export takes
the innermost copies as the shared element; and a nav whose items don't match the page names. The
second passes through to the prompt, faithfully.

Unit tests (`trial/test/export.test.mjs`) hold the prompt to every word on 24 mocks (the bakery, the
three fixtures and the twenty outlines of `runs/2026-09-26-plain-words`) and to the plain-words rule of
`words.mjs`. A run of short texts reads as links only where navigation is: in a shared element, as tabs,
or naming two pages. Before that rule, an address in bold over three grey lines read as “Links”.

## Check before adding, and next steps — `runs/2026-09-27-already-probe`

In a check of whether a stranger could use the app, "add our phone number" duplicated a phone number
the page already showed. Now an addition asks Jev first (`jev.mjs` `already`): is the thing already
on the mock, which element is it, and does the sentence name a page or a place for it? Then:

- **It names neither** ("add our phone number"). The one there is selected and scrolled into view,
  nothing changes, and "Add another" is offered.
- **It names a place on that page** ("…under the address"). The one there is moved to that place,
  and "Keep both" is offered, which puts it back and writes a new one at that place.
- **The page it asks for is another** ("add the opening hours to the home page"). A new one is added
  there as asked, since it is not on that page.

A page, or a thing shared across pages, is never moved; it is shown. After every build and every
change, three next steps sit under the text box, one click each. The writer ends each answer with a
`// next:` line in the same call; an empty canvas shows three starters.

The question was probed before anything relied on it:

```bash
node trial/eval/probe-already.mjs --env ~/projects/jev-context/.env.local --runs 2 --out trial/eval/runs/<dir>/results.json
```

The set has 46 sentences. The first 28 are on a three-page bakery: the thing there with no place
named, with a page named (its own or another), with a place named; the thing not there; "another" /
"a second" / only the same kind; and not there while the place it names is ("an email address under
our phone number", where decide()'s `exists` would read yes). The other 18 are held out, on the
email and CRM apps from the 1b run. Each is run twice. Rows where the thing is on another page from
the one asked for are scored on `open` and `page` only, since the answer to `there` changes nothing.

| wording of `there` | right | held out | there | not there |
|---|---|---|---|---|
| the question alone ("Is the thing `said` asks to add already on the mockup…?") | 90/92 | 36/36 | ≥ 0.73 | ≤ 0.62 |
| plus: another / a second / only the same kind means no, and a place named is not the thing (what `jev.mjs` asks) | **92/92** | **36/36** | ≥ 0.65 | ≤ 0.40 |

- **Without those lines, "a second phone number" read as there** (0.57-0.62), and "another bread
  card" came back 0.40.
- **`open` alone could not tell a page from nowhere.** spot()'s `open` asks about a place *on a
  screen*, so "to the home page" is open (0.88-0.91). The `page` question splits them: at least 0.94
  when a page is named, at most 0.19 when not. The first run, without it, scored "add the opening
  hours to the home page" wrong on both wordings.
- **Which element:** 38/38, the phone number itself (0.91-1.00) more often than its labelled group.
- The call takes a median 127 ms and a max of 355 ms, and costs one Jev request per addition.

**In the app (browser pane, a bakery built from "make a mock of my bakery's website: a menu page
with five breads as cards with prices, and a visit us page with our address, phone number and
opening hours").**
- The build showed three next steps, from the writer's five. A click sent one ("Add email
  address"), which was checked (not there), added, and replaced by three new steps. "Make the prices
  bigger" and a toolbar Bigger kept them. Undo brought back the ones that went with the mock before,
  less the one taken.
- "Add our phone number": there 0.85, open 0.94, page 0.07. The reply was "“(503) 555-0147” is
  already on the “Visit Us” page." The number was selected and in view, with "Add another"
  offered, and nothing changed.
- "Add our phone number under the address", with the number above it in a "Call" block: there
  0.80, it 0.92, open 0.09. It was moved under the address, and "Keep both" was offered. Keep both put
  it back and had the writer add a second one under the address.
- **Unmarked, "add our phone number above the hours" routed direct as a move** (0.87), while Jev's
  job answer was add. Its element, chosen by kind ("group" 0.47), was the whole column. Such a
  sentence now goes to the addition, which moves the one there, found by `already`, or adds one.
- **Placement is still top down, by parts.** On one run "under the address" chose the brand row as
  the part (0.42) and put the number at the top of the content. The right part was the offered swap,
  and taking it kept "Keep both". An edge spot also landed "just above the hours" at the right end
  of the nav row: edges into a row are no longer offered (tree.mjs `edgesOf`).

What this does not cover:
- A value moved out of its labelled block leaves the label behind ("Call" with nothing under it).
- A mock opened from a file has no next steps until the first thing the writer writes.
- Jev does not rank the writer's steps against the mock; they are shown in the writer's order.

## This one, or every one like it — `runs/2026-09-26-twins-probe`

With one of five prices marked, "make the prices bigger" changed one price. Now code finds the
element's twins (tree.mjs `twinsOf`: each card's price, each nav item, each card), and Jev answers
one question, asked only when there are twins: does the sentence mean this one or every one like it?
The other reading is offered beside the reply as a swap: *"Made “$5.75” and the 4 others like it
bigger · [Just “$5.75” instead] [Undo]"*.

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
  took the swap.

What the probe does not cover: `which()` choosing among the twins. It spreads its confidence over
five identical prices; once every one is being changed, those alternatives are dropped rather than
offered. Rewrites ("turn the prices into pills") still act on one element.

## Act, then offer — `runs/2026-09-26-act-then-offer`

The app no longer asks before it acts. Where Jev is unsure, its top pick is done, and the runner-up
is offered beside the reply as a one-click swap, with Undo: *"Removed the “New Agent” button · [The
“Filter” button on the “Logs” page instead] [Undo]"*. A wrong guess costs one click. A question cost
a read, a decision and a click every time, even when Jev was right.

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

What a person reads is in their words, and the questions with no decision behind them are gone.

1. **One module owns the words.** `trial/words.mjs` writes every question, choice, reply and
   page string. Things are named by what is on them ("the “You are owed” card", "the “Order
   now” button"). Places are named by what is around them ("between “Address” and “Hours”").
   A website has pages; a phone app has screens. Jev and the writer still read tree.mjs's lines,
   so their measured wording is unchanged. Scores, timings, model names and the engine's log sit
   behind `?debug=1`. `trial/test/words.test.mjs` renders every template against the twenty
   outlines of `runs/2026-09-23-jev-fixes` and fails on an engine word outside quotes.
2. **No "start a new app?"** An empty canvas builds. A new app on a full canvas replaces it and
   offers "Bring back “Relay”" (Undo), as does the new **New** button, until a project
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
