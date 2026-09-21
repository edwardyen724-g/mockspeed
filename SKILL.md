---
name: mockspeed
description: Render fast, disposable greyscale mockups inline while an idea is still being talked through, so the vision in the user's head becomes something they and other people can look at. Use this proactively — the moment the user names concrete screen elements (a header, a list, a card, a button, a tab bar, a feed) while describing an app, site, tool, or plugin idea, render it without being asked. Also use it whenever the user says mock, mockup, prototype, wireframe, "what would this look like", "picture a screen where", or is clearly describing an interface in prose. Especially use it when the user is thinking out loud and has NOT asked for a prototype — that is the primary case this exists for. Do not use it for finished design work, production UI, or anything meant to be shipped.
---

# mockspeed

## What this is for

Ideas arrive faster than they can be described. The user can see a screen in their head, but words are a terrible transport for a layout, so the idea stays trapped and they burn time researching instead of looking at it. mockspeed exists to put a picture on the table within one turn, cheap enough to throw away, so the idea can keep moving.

The point is **thinking speed, not fidelity**. A mockup here is a thinking prop, in the same category as a napkin sketch. It is not a design, not a prototype, and not the beginning of a build.

## When to fire

Fire without being asked when the user names **concrete elements** — a header, a row, a list, a card, a filter, a button, a tab. Concrete enough to draw means it is time to draw it.

Do NOT fire when the idea is still purely conceptual — a market, an audience, a business model, "something for people who X". Half-formed ideas need to stay verbal a while longer, and a rendered screen anchors thinking prematurely: boxes on a grid start people solving layout before the concept has earned it. Wait for elements.

One more trigger: fire when the user is trying to describe an interface to a third party and struggling. That is the exact pain this solves.

## The loop

1. Name the **primary action** of the screen — one sentence, in your head, before rendering. Everything on the screen serves it or gets cut.
2. Write the **fake data** first (see below).
3. Lay out around the data in greyscale.
4. Render at the **end of the turn**, after your prose, so the user is never waiting mid-thought.
5. Keep talking. The render is not the response.

Each new detail the user adds earns a new render on the next turn. Never describe the mockup in words when re-rendering is cheaper than describing it.

## Rule 1 — Fake data before layout

Write the real content first. Seven actual habit names with actual streak counts. Four actual invoice rows with actual amounts and dates. Real-sounding names, plausible numbers, a mix of states including at least one edge case (empty, overdue, zero, very long).

Never render placeholders: no "Your items appear here", no lorem ipsum, no "Feature One / Feature Two", no grey bars standing in for words. A layout built around real specifics is forced to organize actual things; a layout built around placeholders drifts into arranging sections.

## Rule 2 — Starve the text

The signature failure of AI mockups is explanatory text. It does not fill empty space where data goes — it is **added on top of a layout that already had room for content**, and it pushes the useful things down and out. It is the single clearest tell that a mockup is machine-made slop.

Hard constraints, because vague instructions to "be concise" do not survive contact with generation:

- **Twenty words maximum** of non-data text per screen. Labels, buttons, and nav count. Data does not.
- **No explanatory paragraph anywhere.** No hero subtitle, no "how it works", no helper text under a field, no empty-state pep talk.
- **No section headers** unless the screen genuinely does two unrelated jobs.
- Every non-data element must justify itself against the primary action. "Orients the user" is not a justification. Cut it — do not shrink it.

If a screen needs explaining, the layout is wrong. Fix the layout.

## Rule 3 — Greyscale, but use the whole range

Greyscale keeps the mockup honestly disposable — it can never be mistaken for a finished design, so nobody starts defending it. But flat grey boxes communicate nothing to a second person.

Use **shades as hierarchy**, which is the part actually in the user's head:

- Near-black / heavy weight — the one thing that matters most on this screen
- Mid grey — supporting content
- Faint grey — chrome, nav, borders, metadata

That is depth, not style. Someone else looking at it can see what is important and where their eye should land, without any color or typographic decision having been made.

No color. No brand. No font choices beyond default sans and one weight step. No icons except simple geometric shapes. No shadows, no gradients, no rounded-corner fussing.

## Rule 4 — One current mockup

Replace the previous render; do not stack a gallery. There is one current mockup and it reflects the latest state of the idea.

At conversational speed, some renders will land after the user has already moved on. That is fine and expected. A stale render is simply ignorable — never ask "does this still match what you meant?" or narrate the drift. Just render the newer version next turn.

## Rule 5 — Quarantine the code

**The spec carries forward. The code never does.**

When the idea graduates to a real build, the mock file is not read, not imported, not "cleaned up", and not used as a starting point. Reaching for it is the lazy default and it drags every slop decision into the real thing, defeating the entire purpose.

What survives is the running spec:

```
Screens:      <list>
Primary action per screen: <one line each>
Elements:     <per screen, in hierarchy order>
Data shape:   <fields and types implied by the fake data>
Decisions:    <what was ruled out and why>
```

Keep that updated as the conversation goes. Hand that to the builder — never the HTML.

## Escalating to clickable

Default to static. Go interactive only when there is a question that **cannot be answered without clicking**:

- "Is three steps too many?" → needs clicks
- "Does the filter belong here or in a drawer?" → needs clicks
- "What goes on this screen?" → does not
- "Does this hierarchy read right?" → does not

Interactivity costs real generation time and, worse, working software invites defending instead of discarding. Let the user's question pull it out of you, not the idea simply getting more developed.

When you do go interactive: in-memory state only, same greyscale rules, same word budget, only the paths relevant to the question.

## Non-web targets

**Native app** — draw a plain phone-shaped frame with a faked status bar and tab bar. Good for judging screen count, order, and what lives where. Say plainly that it cannot judge feel: gestures, transitions, keyboard behavior, and scroll physics are all wrong on a rendered rectangle.

**Plugin or extension** — mock the panel and paint a faint fake host around it (a canvas, a browser chrome, an editor gutter) so scale reads correctly. Flag the honest limit: a plugin's value lives in its integration with the host, which is the part a mockup cannot test. The panel layout is the smaller risk.

**Dashboard, CLI, email, doc** — same rules. Real data first, starve the text, greyscale hierarchy.

## Rendering mechanics

Use whatever inline visual mechanism the current surface offers — in chat, the visualizer tool; in an agentic surface, a single self-contained HTML file. Keep the whole mock in one file with no external assets.

If subagent delegation is available, delegate the render. The reason is **context isolation**, not speed: a few hundred lines of throwaway HTML per render would otherwise pile up in the main conversation and crowd out the actual thinking. Pass the subagent the running spec, not the transcript. Note that delegation does not make rendering concurrent with the conversation — the parent still waits. Only surfaces with real background tasks (Claude Code, Cowork) can render while the user keeps typing.

## Tone

Do not announce the mechanism, explain the mockup, or list what was included. The user can see it. Say at most one line about what changed or what decision the render is testing, then keep thinking with them.
