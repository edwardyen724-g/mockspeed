# Handoff — Jev decides; trial tested through the app

Date: 2026-09-23 · Written for the next session in `~/projects/mockspeed` · Body-safe: no secrets.

This session (22–23 Sep) took the mark-and-say canvas over from the previous session, made its
input box a fast writer (Haiku 4.5) that Jev routes, then replaced the eleven-widget vocabulary
with a tree of nestable primitives in a new `trial/` app beside it. Edward then set the rule that
**every semantic decision in the app is Jev's** and that **decisions for the person sit next to the
text box**; the trial was rebuilt around that, audited for violations by two agents, and tested
three times through the app. The last full run is the baseline the next session measures against.

---

## 0. TL;DR

- `main` is at `63c370a`, in sync with `origin/main`. Nothing from 22–23 Sep is committed yet
  (see §1 for what the close did).
- `trial/` is this session's. `canvas/` is the previous session's files plus this session's
  changes. `README.md` carries the previous session's edit, not this session's.
- The next session starts from the baseline in `trial/eval/runs/2026-09-23-after-audit/`: 77 of 118
  follow-ups judged right, 21 needless questions, build substance 2.1 / 3.

## 1. What shipped

Nothing is deployed; mockspeed has no deploy target. "Shipped" here means committed and pushed to
github.com/edwardyen724-g/mockspeed. What the close committed, if anything, is recorded in the
memory entry `project-mockspeed-canvas-llm-drives-jev` and in `git log`.

## 2. Files I touched

**New:** `trial/FORMAT.md` (the outline format, the contract) · `trial/tree.mjs` (parse, stream,
serialize, patch, direct edits, `gaps()` / `screenGaps()` / `placeAt()` / `shapeOf()`) ·
`trial/render.mjs` · `trial/jev.mjs` (every Jev question) · `trial/writer.mjs` (Haiku: whole app,
one piece, split) · `trial/server.mjs` (routing, policy, questions for the person) ·
`trial/shell.html` · `trial/test/*` (250 tests) · `trial/eval/*` (run, gallery, judge workflow,
baseline) · `canvas/brain.mjs`

**Modified:** `canvas/jev.mjs`, `canvas/ops.mjs`, `canvas/server.mjs`, `canvas/shell.html` — Jev
routing (direct / write / none), a `clear` op, Haiku translator lines, the pipeline log, questions
under the input.

## 3. Files we BOTH touched — check these first

`canvas/jev.mjs` · `canvas/ops.mjs` · `canvas/server.mjs` · `canvas/shell.html` — created by the
session "mockspeed canvas: mark and say" (`local_24e6c77b…`, not running; its ledger still says
open and claims `canvas/**`). Edward handed that work to this session, so this version is the
authoritative one. `canvas/` is the older approach (widget vocabulary, the writer writes sentences
Jev re-reads); `trial/` is the current direction.

## 4. Things you should know

- **Test through the app.** `trial/eval/run.mjs` sends every sentence to `/ask`. The first
  ten-app test called the writer directly, made zero Jev decisions, and Edward rightly asked what
  the point was. See `trial/eval/README.md`.
- **Jev decides; the person is asked; code never breaks a tie** — the memory entry
  `feedback-mockspeed-jev-decides` has the three rules. Before relying on a new Jev question, probe
  it on a sentence set: wording decides accuracy (a gap choice named by position words placed
  6-7/7 where a flat element choice placed 2-3/6; the move-destination question went 8/10 → 10/10
  on rewording).
- **TypeSafe credits run out** — then every request answers `402 billing_error` and the app shows
  the error. Edward adds credits. `529 system_overloaded` also happens; `trial/jev.mjs` retries
  408/429/5xx twice.
- **Haiku habits:** shown ids, it copies `#n12` into its pieces (the writer is shown outlines
  without ids); shown the mockup when splitting a sentence, it refuses or asks what "this" is (the
  splitter sees only the sentence, and needs its worked examples).
- **Ports:** the trial runs on 8772 because another chat's server held 8771. `.claude/launch.json`
  is gitignored and session-specific (entries `trial`, `gallery`, `canvas`).
- **Tests:** `node --test trial/test/*.test.mjs` — Node 25 does not accept a bare directory.
- **Screenshots:** headless Chrome saves the PNG and then does not always exit — one profile per
  capture, killed once its file exists (`trial/eval/gallery.mjs` does this).
- `trial/eval/judge.workflow.js` ends with a top-level `return`: valid in the Workflow runner only.

## 5. Still open (not mine to close)

From the judges of the baseline run (details in its `verdicts.json`, issues with category `jev`):
1. **"which one?" options** include the screen, containers and nav items and leave out real
   candidates — offer only elements the edit applies to.
2. **21 needless questions**, mostly placement: Jev's top gap was right but under 0.5 among 40+
   gaps. Choose the section first, then the spot.
3. **Pieces placed outside a screen's padding** (above its header) via screen-level gaps.
4. **A split part that needs the person blocks the independent parts after it.**
5. **Each screen has its own copy of the nav and title** — an edit changes one copy, and "the
   title" is ambiguous in most apps. Shared elements need a format change.

Also open, older: the writer's taste (substance 2.1/3 — Sonnet 5 as the build writer; Edward's
research-for-taste gallery, parked); two low audit items (whether "bigger" on a container means its
texts or its box is still code's call; gap badges collide on a shared anchor); in `canvas/`,
`/new` and `/append` still let an outside agent write the mock.

## 6. Verified at time of writing

```
node --test trial/test/*.test.mjs                 -> 250 pass, 0 fail
node trial/eval/gallery.mjs <out> trial/eval/runs/2026-09-23-after-audit
                                                  -> 10 apps, 20 screenshots; scoreboard 214 Jev decisions,
                                                     127/128 routed, 10/10 builds, 77/118 judged right,
                                                     21 needless questions, substance 2.1
git rev-list --left-right --count '@{u}...HEAD'   -> 0 0
```
