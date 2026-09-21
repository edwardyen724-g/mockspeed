# Forecast — running spec (judged 2026-09-19; the mock was rendered from this)

This is the artifact that carries forward from a mockspeed session. The HTML next to it does not.
Condensed to the mockspeed format from the full judged spec; the fake data below is what every
screen is drawn from.

```
Screens:      Where are the posts? (import) · Draft (home) · Result · History · Backtest · Account
              · Which account? · What's this account about?
              The mock renders the three that carry the idea: Draft, Result, Backtest.

Primary action per screen:
  Import     pick the analytics CSV so this account has a History; columns inferred, never chosen
  Draft      type or paste the post and place it against this account's History
  Result     see where the draft lands among the account's own posts, then take the text to X
  History    read what each past post did, newest first
  Backtest   judge whether the method works on this account at all; run it again to see Jev's drift
  Account    check the facts Jev is given about this account, change any of them

Elements (hierarchy order):
  Draft
    1. the post field — heaviest, the only always-open field, label "Post"
    2. "Place it"
    3. account cluster, mid — avatar, handle, one-line about, "X · 63 posts · ρ 0.46 (0.24 – 0.64)"
    4. tab bar, faint — Forecast · History · Backtest · Account
    edge: 301 characters → "301 / 280", the pill stays (the limit is X's; the forecast still runs)
    edge: an account with 5 posts shows "X · 5 posts" and no ρ
  Result
    1. the 90% band, heaviest — "190 – 1,900 views"; a rank band that reaches the top post shows "9,800+"
    2. range strip, mid — log axis, all 63 past posts as dots, 90% bar, 50% bar, middle tick, the draft's ring
    3. "beats 45 of 63 · 50% 300 – 560"
    4. stamp, faint — "Placed 12:41 · 0.4 s"; while running, "● Placing · 126 questions"
    5. ranked slice, mid — 7 neighbours: views · text one line · date; the draft's row is the dark one
    6. trust line, faint, links to Backtest — "ρ 0.46 · 0.24 – 0.64 · n 63"
    7. "Post it" (opens x.com/intent with the text; the app never posts) · "Change it"
    edge: n < 9 → "beats 3 of 5", no strip, no band, no trust line
    edge: Jev unreachable → the headline slot stays empty, "Jev didn't answer", pill becomes "Try again"
  Backtest
    1. "ρ 0.46", heaviest — greyed when its interval spans 0
    2. "0.24 – 0.64 · n 63" (bootstrap 95%) · "58 / 63 in band"
    3. run log — "0.46 · Sep 18 14:02 · 0.43 · Sep 18 09:10 · 0.41 · Sep 12" (Jev's drift, shown not described)
    4. stamp, faint — "Leave one out · 3,906 questions"
    5. rank scatter, mid — guess rank vs actual rank, diagonal, the newest post's dot dark
    6. "forward · 4 posted · 3 in band"
    7. list sorted by actual rank — guess · actual · views · text; ✕ on a row the band missed
    8. "Run it again"

Data shape:
  Account  { id, platform: 'x'|'instagram', handle, about: string (may be ''), playsWord: 'views'|'plays',
             source: string (file name), importedAt, mapping: { plays, reposts, saves, followers: string|null } }
  Post     { id, accountId, text, postedAt, plays: int, likes: int, reposts: int, saves: int,
             followersAtPost: int|null, charCount: int, dedupeKey: normalised text + postedAt }
  Forecast { id, accountId, text, placedAt, wins: int, of: int, percentile: 0..1, w: number, se: number,
             middlePlays: int|null, lo90, hi90, hi90Open: boolean, lo50, hi50, hi50Open: boolean,
             questions: int, ms: int, model: string, matchedPostId: string|null, inBand: boolean|null }
  BacktestRun { id, accountId, ranAt, n, rho: number|null, rhoLo, rhoHi, q90, q50, coverage: int|null, questions, ms }

Fake data (the account every screen is drawn from):
  @edbuildthings · X · "Solo founder shipping small AI tools in public" · 63 posts · Jun 2 – Sep 18 2026
  views: min 0 (a deleted "test" post the export still lists), median 210, max 2,310
  top of the ranking: 2,310 "ran the benchmark against ten products' own compaction…" ·
    1,620 "compaction is a judgment problem wearing a tokenizer costume" ·
    1,140 "anthropic's compaction api drops a system message in one of our fixtures…"
  around the draft: 460 · 445 · 430 · [draft ≈420] · 412 · 395 · 370
  the draft: "jev-compactor is on npm. it compacts an agent's context by asking a model that cannot write,
    only judge. 1.2 MB of docs for a 40 KB library."
  backtest: ρ 0.46 (0.24 – 0.64), 58 / 63 in band, runs 0.46 / 0.43 / 0.41;
    misses: the aphorism ranked 2nd was guessed 21st; the 0-view "test" ranked 63rd was guessed 41st
  edge accounts: theagora.reels (Instagram, 28 reels, ρ 0.12 with an interval spanning 0);
    @sealedrun (X, 5 posts — the n < 9 account)

Decisions:
  - the moment is the phone: the app exists for the seconds before posting
  - Draft is home with the field always open; Result is a separate page so the band never flickers beside a keystroke
  - the headline is the 90% band, never a point; the 50% band sits on the line beneath it
  - open band edges: a band that reaches the top post shows "+", never a clamped ceiling
  - n < 9 guard: a 90% conformal band needs ⌈0.9(n+1)⌉ ≤ n, so a 5-post account gets "beats 3 of 5" and nothing else
  - ρ is greyed when its interval spans 0: "the method does not work on this account yet" is shown, not said
  - one Jev question type only: a two-label choice per pair, both label orders averaged; score rubrics rejected
    because they need an absolute scale Jev does not have
  - the backtest is every ordered pair once (3,906 questions for 63 posts), leave-one-out by construction
  - the run log shows Jev's drift as three ρ values with dates rather than describing it
  - the app never posts: "Post it" opens x.com/intent; on Instagram it reads "Copy it"
  - views, likes, reposts, bookmarks are facts about a post, shown as facts, never a ranking of people
  - no section headers; the stamp names the last run and is the one live element on the screen
```
