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
each question was fair or needless.

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
