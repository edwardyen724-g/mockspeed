# mockspeed

A Claude skill that renders fast, disposable greyscale mockups while an idea is still being talked through — so the screen in your head becomes something you and other people can look at, within one turn, cheap enough to throw away.

The point is thinking speed, not fidelity. A mockspeed render is a napkin sketch: not a design, not a prototype, not the beginning of a build. The skill is one file, [`SKILL.md`](SKILL.md).

## Examples

Two mocks from real sessions. Each is one screen's worth of HTML with no external assets, plus the running spec that is the thing that actually carries forward.

### leadgen

**The app:** paste a product's URL and get a large list of reachable people — email or DM — who are publicly complaining about the problem the product solves.

**The mock:** one page in two states stacked top to bottom — the Confirm step (inferred audience, pain phrases as chips, sources) above the Results table, with the reachable count as the hero and the contact column carrying the most weight.

[![leadgen mock](examples/leadgen/mock.png)](examples/leadgen/mock.html)

[`mock.html`](examples/leadgen/mock.html) · [`spec.md`](examples/leadgen/spec.md)

### Forecast

**The app:** before posting, a draft is placed against the account's own past posts by pairwise judgments from a model that only judges (Jev), and the screen shows the 90% band of views it is likely to get — with a backtest that says whether the method works on this account at all.

**The mock:** three phone frames — Draft, Result, Backtest — where the band is the headline, the draft's neighbours are real past posts, and the backtest shows the model's misses as rows rather than describing them.

[![Forecast mock](examples/forecast/mock.png)](examples/forecast/mock.html)

[`mock.html`](examples/forecast/mock.html) · [`spec.md`](examples/forecast/spec.md)

**Provenance.** The leadgen HTML is the file rendered during its session. Forecast's design session produced a judged running spec but never rendered the sketch to a file, so the mock here was rendered from that spec, under the skill's rules, for this repo. Both specs are trimmed to the mockspeed format; product decisions that belong to the build (pricing, vendors, pipeline) are left out. Most mockspeed renders never become files at all — in chat they are drawn inline and replaced by the next turn's render, which is the intended lifecycle.

## Principles

The skill is short; these are its load-bearing rules.

1. **Fake data before layout.** Write the real content first — seven actual habit names with actual streak counts, four actual invoice rows with amounts and dates, at least one edge case (empty, overdue, zero, very long). Never placeholders, never lorem ipsum, never grey bars standing in for words. A layout built around real specifics is forced to organise actual things; one built around placeholders drifts into arranging sections.

2. **Starve the text.** Twenty words maximum of non-data text per screen — labels, buttons and nav count, data does not. No explanatory paragraph anywhere, no hero subtitle, no helper text, no empty-state pep talk, no section headers unless the screen does two unrelated jobs. Explanatory text is the clearest tell of a machine-made mockup: it is added on top of a layout that already had room, and pushes the useful things out. If a screen needs explaining, the layout is wrong.

3. **Greyscale, but use the whole range.** Greyscale keeps the mock honestly disposable — nobody defends it. But shades are hierarchy: near-black for the one thing that matters most on the screen, mid grey for supporting content, faint grey for chrome and metadata. That is depth, not style; a second person can see where the eye should land without any colour or type decision having been made. No colour, no brand, no icons beyond simple shapes, no shadows, no rounded-corner fussing.

4. **One current mockup.** Each new detail earns a new render, which replaces the previous one. No gallery. A render that lands after the conversation has moved on is simply ignored — never "does this still match?"

5. **Quarantine the code.** The spec carries forward; the code never does. When the idea graduates to a build, the mock HTML is not read, not imported, not cleaned up. Reaching for it drags every slop decision into the real thing. What survives is the running spec — screens, primary action per screen, elements in hierarchy order, data shape, decisions — and that is what gets handed to the builder.

Two rules about *when*: fire the moment concrete elements are named (a header, a list, a card, a tab bar), and not before — a purely conceptual idea (a market, an audience) should stay verbal, because a rendered screen anchors thinking prematurely. And stay static; go clickable only for a question that cannot be answered without clicking ("is three steps too many?"), because working software invites defending instead of discarding.

## How to use

### Install

**Claude Code** — clone into your user-level skills folder so it is available in every project:

```bash
git clone https://github.com/edwardyen724-g/mockspeed.git ~/.claude/skills/mockspeed
```

Or copy `SKILL.md` into `<repo>/.claude/skills/mockspeed/SKILL.md` to scope it to one project.

**Claude.ai, the Claude desktop app, Cowork** — add the `mockspeed` folder (just `SKILL.md`) as a custom skill.

### Then just talk

You do not invoke it. Describe the thing you are imagining; the moment you name concrete screen elements — "a list of habits with a streak count on each row and a big button at the bottom" — the skill fires and a greyscale render appears at the end of the turn, after the prose. Saying *mock*, *mockup*, *wireframe*, *what would this look like* or *picture a screen where…* also triggers it.

Each turn:

- Claude names the screen's **primary action** to itself, writes the fake data, lays out around it, renders, and keeps talking. The render is not the response; at most one line says what decision it is testing.
- Add a detail, get a new render. Rule something out, it disappears.
- Ask a question that needs clicking, and only then does it go interactive (in-memory state, same greyscale, same word budget, only the paths the question needs).

When the idea is ready to build, ask for the **running spec** and hand that to the build — never the HTML. It looks like the two `spec.md` files above.

### Where the render shows up

In chat, it draws inline with the visualiser. In Claude Code and other agentic surfaces it writes a single self-contained HTML file to the session's scratch directory; open it in a browser, or ask for a screenshot. Native apps get a plain phone frame with a faked status bar and tab bar; plugins get a faint fake host painted around the panel so scale reads correctly. Both come with the honest caveat that a rendered rectangle cannot judge feel or integration — only screen count, order and what lives where.

## Layout

```
SKILL.md                 the skill, verbatim
examples/
  leadgen/               mock.html · mock.png · spec.md
  forecast/              mock.html · mock.png · spec.md
```

## License

MIT — see [`LICENSE`](LICENSE).
