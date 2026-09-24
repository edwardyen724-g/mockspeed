# Handoff — the five Jev fixes, measured through the app

Date: 2026-09-24 · Written for the next session in `~/projects/mockspeed` · Body-safe: no secrets.

This session took the five open items from `docs/handoff-2026-09-23-trial.md` §5. Each one was
probed on a sentence set against the ten baseline apps before any server code changed. Then all
ten apps were re-run through the app and judged by the same five-agent workflow. The new run beats
the baseline on every count of the done-condition.

---

## 0. TL;DR

- Committed on `main` in the commit that adds this file. **Not pushed:** Edward said commit; push
  waits for his yes.
- `README.md` still carries an older canvas session's uncommitted edit. It is not this session's
  and is not in the commit.
- New run `trial/eval/runs/2026-09-23-jev-fixes` against the baseline `2026-09-23-after-audit`:
  - judged right (a fair question or a correct "nothing" counts): **90/120**, was 77/118
  - needless questions: **16**, was 21
  - questions left for the person: 33, was 44
  - builds 10/10
  - tests: 261 pass, was 250
  - build substance: 2.0, was 2.1 (the writer was not changed)
- Edward's read (2026-09-24): some of the fixes make the UI look worse. That is acceptable for
  now, because a perfect prototype is not the goal yet. **The goal he named: a person can use
  mockspeed on their own to make a mock of their site.**

## 1. What changed

Each item: what code offers, what Jev decides, and what was measured before building it.

1. **"Which one?"** — `decide()` now asks `kind` (text, button, input, picture, group, table,
   chart, screen) and `exists`. `choose()`/`candidates()` in `server.mjs` then offer only
   elements of that kind that the edit would change, or that are already at their limit (marked
   as such). Screens and bare wrappers are left out. Each candidate is labelled with where it
   sits (`positionOf`, the part of the screen it is in, "the largest text on X"). `which()` in
   `jev.mjs` is a second call. Probed: right-and-sure picks went from 15/40 (one choice over every
   node) to 29-30/40.
2. **Placement top down** — `pickGap()`: which part of the screen (`partsOf`, whose labels say
   where each part is and how big), then where in it (`spotsIn`, `edgesOf`). There are a few
   options per level, and a level with one option asks nothing. Jev's `open` question says
   whether the sentence named a spot. When unsure and `open`: `nextTo()` (the element it belongs
   next to, ≥ 0.4), else the end of the part.
3. **Padding** — no gaps directly in a screen, and a lone wrapper or a full-height row of columns
   is looked through (`sectionsOf`). A move whose spot is where the element already is says
   "already there". Gaps name "where it is now" for a moved element.
4. **Split parts** — `runParts()`/`nextPart()`: a part that asks the person waits; a later part
   waits too only if Jev's `needs()` says it depends on it (13/13 on two probe runs). Waiting
   questions are then put one at a time; "leave it" drops the parts that needed that one.
5. **Shared elements** — `share=<name>` (FORMAT.md). The writer is told to mark the nav, top bar
   and tab bar copies. `applyEverywhere()` and `placeEverywhere()` mirror direct edits, pieces and
   rewrites to every copy (`copiesOf`, `mirrorsOf`), and Jev sees each shared element once
   (`sharedView`).

Also fixed on the way: a "which screen?" answer during a move used to add a new piece instead of
moving the element (`pending.moving` was never set).

## 2. Files touched

**New:** `trial/eval/runs/2026-09-23-jev-fixes/` (results, 20 outlines, verdicts) · this file

**Modified:**
- `trial/jev.mjs` — `KINDS`, `kind`/`exists` in `decide`, `which`, `spot`, `nextTo`, `needs`.
  The target question in `decide` is now asked only when an element is marked.
- `trial/server.mjs` — `choose`/`candidates`, `pickGap`/`openSpot`/`pickScreenGap`, `runParts`/
  `nextPart`, `applyEverywhere`/`placeEverywhere`, and `nodes({ once })`. New policy constants
  `OPEN_SPOT`, `ACT_NEXT` and `NOT_THERE`, each with its measurement in a comment.
- `trial/tree.mjs` — `positionOf`, `padded`, `sectionsOf`, `partsOf`, `spotsIn`, `edgesOf`,
  `neighboursIn`, `shares`, `copiesOf`, `firstCopy`, `sharedView`, `mirrorsOf`.
- `trial/writer.mjs` — `share=` in the format and the compose hints.
- `trial/FORMAT.md` — shared elements, and the new functions in the module API.
- `trial/eval/run.mjs` — `--only a,b` for smoke runs. The Jev count now includes element and
  split-part decisions, so 354 is not comparable with the baseline's 214.
- `trial/eval/gallery.mjs`, `gallery.html` — show element choices ("which").
- `trial/eval/README.md` — the new run, per sentence, against the baseline.
- `trial/test/tree.test.mjs` — 11 new tests (positions, parts, spots, edges, where-it-is-now,
  sharing).

## 4. Things you should know

- **Probe first.** The scratchpad scripts from this session (`t-target*.mjs`, `t-place.mjs`,
  `t-down*.mjs`, `t-section.mjs`, `t-depends.mjs`, `t-edge.mjs`) died with its scratchpad. The
  pattern is small: load a baseline outline, build the question, and call
  `https://api.typesafe.ai/v1/systemone` with `{ model: "jev-latest", state, questions }`.
- **Wording results worth keeping:**
  - A `none` option inside a choice drains probability on vague phrases ("the title", "the main
    list"). Ask `exists` as a separate yes/no on the full element list instead; asked of a
    narrowed list it scored 12/39.
  - Part labels need size and position in words ("a strip 80 px tall", "the widest part"). With
    the container description alone, notes went to the side nav.
  - Offering "just below the top bar" at the part level split phone searches 50/50 and pulled
    notes up, so it is offered only inside a part.
- **Jev's `confidence` is not the option's probability.** A two-option choice can come back 0.00.
- **Phone apps:** "at the top" confidently chooses the top bar, and then Jev is unsure where in
  it. That causes most of the phone asks.
- **Builds differ run to run** (Haiku), so smoke runs on 2-3 apps (`--only`) are noisy. Judge only
  full runs.
- The screen-gap question ("add a settings screen") was not changed, yet asked twice in this run
  against none in the baseline. Treat that as run noise.

## 5. Still open

From the judges' verdicts (`verdicts.json`, and trial/eval/README.md "Still weak"):
- A move to the top of something already at the top still asks where on phone and nav apps (4
  needless) — even when Jev's top option is "where it is now". Decide "already there" from Jev's
  answer; probe first.
- "Add a filter" falls to the end of the main area when `nextTo` (the search field) is under 0.4
  (support 0.34). Probe the `nextTo` wording or the threshold.
- "The last button" is not read as an order across screens (orchestration 0.20 of 2). Try the
  viewing hint in `which()`; in one probe it helped buttons.
- Moves inside a shared element are not mirrored to the other copies. A new screen's nav copy can
  gain an item (Settings) that the other copies lack.
- The writer duplicates what it is placed next to (a second "New Agent" button, a second search
  field) — writer prompt, not Jev.

Older, still open: the writer's taste (substance 2.0/3 — Sonnet 5 as the build writer; the
research-for-taste gallery, parked). The judges' suggested fixes are not in this list: several
have code interpret the person's words ("resolve 'last' in document order"), which breaks the
Jev-decides rule.

**Toward Edward's goal** (a person makes a mock of their site on their own): the trial app runs
locally, needs `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY` from `~/projects/jev-context/.env.local`,
and starts from a sentence, not from an existing site. What a first independent user would hit has
not been scoped yet; that is the next session's question.

## 6. Verified at time of writing

```
node --test trial/test/*.test.mjs    -> 261 pass, 0 fail
node trial/eval/run.mjs trial/eval/runs/2026-09-23-jev-fixes
                                     -> 10 apps, builds 10/10, 354 Jev decisions, 16 answered by the script
judge.workflow.js (5 agents)         -> 10/10 apps judged; 63 right, 11 fair, 16 correctly nothing,
                                        12 partly, 16 needless, 2 wrong
node trial/eval/gallery.mjs <out> <new>="After the Jev fixes" <baseline>="Baseline"
                                     -> 2 runs, 20 apps, 40 screenshots
```
