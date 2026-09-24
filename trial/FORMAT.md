# trial — a mock as a tree of primitives

The canvas in `canvas/` draws from a closed list of eleven widgets, so it can only draw what that
list anticipated: dashboards and editorial pages. This trial closes the *edits* instead of the
*things*. A mock is a tree of a few nestable primitives; a side nav, a kanban board, a chat thread
or an orchestration graph is a composition, not a feature someone codes.

Three layers, as in `canvas/`: a writer model writes the outline, code parses and renders it, Jev
routes what the person types and makes direct edits. The difference: **code parses the writer's
output exactly** — Jev is not asked to re-read machine-written lines.

## The outline

One node per line. Indentation (2 spaces per level; any consistent width is accepted) is nesting.
The first line is the root.

```
app "Relay" web
  screen "Runs"
    row h=fill
      col #nav w=200 fill=light pad=3 gap=2
        text "Relay" size=l bold
        text "Runs" bold
        text "Agents" shade=mid
        text "Settings" shade=mid
      col grow pad=4 gap=3
        row justify=between align=center
          text "Run 1482" size=xl bold
          button "Stop run" primary
        graph dir=right h=260
          node #plan "Planner" sub="done · 12s"
          node #code "Coder" sub="running" bold
          node #test "Tester" sub="waiting" shade=light border=dashed
          edge plan -> code
          edge code -> test "on pass"
        table
          tr "Step | Agent | Tokens | Time"
          tr "Plan tasks | Planner | 1,204 | 12s" data
          tr "Write fix | Coder | 8,730 | 41s" data
```

### Line grammar

```
<type> [#id] ["text"] [key=value | key="value with spaces" | flag]...
edge <from> -> <to> ["label"] [flag]...
```

- `type` is one of the primitives below. Case-insensitive.
- `#id` names a node so other lines (edges, patches) can point at it. Optional; nodes without one get
  an automatic id `n1`, `n2`, … in document order.
- The first double-quoted string is the node's `text`. Double quotes cannot appear inside it.
- `key=value` sets a prop. Numbers are parsed as numbers. `key="…"` allows spaces.
- A bare word that is not a type, id or key=value is a flag: `bold` means `bold=true`.
- Blank lines and lines starting with `//` are ignored.
- The parser is tolerant: an unknown type becomes a `shape` whose label is the line, an unknown prop
  is kept but ignored by the renderer, a misplaced child is still attached. Each is reported in
  `warnings`, never thrown.

### Primitives

| type | text | props | notes |
|---|---|---|---|
| `app` | app name | `web` \| `phone` \| `panel` (flag; default web) | the root; children are screens |
| `screen` | screen name | `web` \| `phone` \| `panel` to override the app | one artboard; lays its children out as a column |
| `row` | — | layout props | children left to right |
| `col` | — | layout props | children top to bottom |
| `grid` | — | `cols=N` + layout props | children fill N equal columns, wrapping |
| `text` | the words | `size=xs\|s\|m\|l\|xl\|xxl` (default m), `bold`, `shade=dark\|mid\|light` (default dark), `mono`, `pill` (rounded outline, for tags and status), `under` (underline, for the active tab), `data` | |
| `button` | label | `primary` (filled), `ghost` (text only); default outlined; `w=fill` | |
| `input` | label or placeholder | `value="…"`, and one of `area` (multi-line), `check`, `toggle`, `select`, `search`; `on` for check/toggle | |
| `shape` | optional label shown inside | `circle`, `pill` (else rectangle), `w`, `h`, `fill=light\|mid\|dark` (default light) | stand-in for an image, avatar, icon, map, video — anything pictorial; a small filled circle is a status dot |
| `line` | — | — | divider; horizontal in a col, vertical in a row |
| `progress` | optional label | `value=0..100` | |
| `chart` | optional caption | `bar` \| `line` (flag; default bar), `values=3,5,2,8`, `h` | greyscale, no axes text |
| `table` | — | layout props | children are `tr` |
| `tr` | cells separated by `|` | `bold`, `shade`, `data` | the first `tr` of a table renders as the header |
| `graph` | — | `dir=right\|down` (default right), `w`, `h` | children are `node` and `edge`; laid out automatically |
| `node` | label | `sub="…"` (second line), `bold`, `shade`, `border=dashed`, `pill`, `circle` | only inside a graph |
| `edge` | label (optional) | `dashed` | `edge a -> b`; `a`, `b` are node ids; only inside a graph |

**Layout props** (any container — `app`, `screen`, `row`, `col`, `grid`, `table`, `graph`):
`w=<px>|fill`, `h=<px>|fill`, `grow` (take the remaining space along the parent's direction),
`gap=0..6`, `pad=0..6` (scale: 0 4 8 12 16 24 32 px), `fill=light|mid|dark` (background shade;
text on `dark` turns white), `border` (1px outline), `divider` (a line between children),
`align=start|center|end|stretch` (cross axis), `justify=start|center|end|between` (main axis).
`w`, `h` and `grow` also apply to leaves.

Everything is greyscale. Emphasis is only ever size, weight and shade — concrete properties a
person can name and see change.

**Shared elements.** `share=<name>` on any node below a screen says it is one element drawn on
several screens — the side nav, a top bar, a bottom bar. Every copy carries the same name; the copies
may differ in which item is current, or one may have an item more. An edit to a copy, or to anything
in one, is made to every copy (a node's copies are the nodes at the same place inside the other
copies, when they are of the same type), and Jev is shown each shared element once. The renderer
draws `share` as nothing.

```
  screen "Runs"
    row h=fill
      col share=nav w=200 fill=light pad=3
        text "Runs" bold
        text "Agents" shade=mid
      …
  screen "Agents"
    row h=fill
      col share=nav w=200 fill=light pad=3
        text "Runs" shade=mid
        text "Agents" bold
      …
```

## In memory

```js
// Node
{ id: "n12" | "plan", type: "row", text: null | "…", props: { gap: 2, fill: "light", bold: true, … }, children: [Node] }
// edge
{ id: "n19", type: "edge", text: "on pass" | null, props: { from: "code", to: "test", dashed?: true }, children: [] }
```

The tree is plain JSON (structuredClone-safe). The root is the `app` node. Automatic ids are
`n<integer>`; `nextId(root)` is one more than the largest in use, so ids are never reused. Writers
do name nodes `#n1` — an explicit id that looks automatic is kept, and automatic numbering skips
every id already taken (explicit ones included), so two nodes never share an id. A second node
explicitly given an id already in use gets an automatic id instead, with a warning.

## Patches — how the writer edits an existing tree

The writer is shown the current tree as an outline with every id (`serialize(root)`), and answers
with blocks. Each block is a header line at indent 0, then (for the first four) an indented subtree:

```
in <id>:          append the subtree's top-level nodes as children of <id>
before <id>:      insert them as siblings before <id>
after <id>:       … after <id>
replace <id>:     replace <id> with them
remove <id>
set <id> key=value …        change props; `text="…"` changes the text; `key=` with no value deletes the prop
```

A patch that starts with an `app` line instead replaces the whole tree. Ids may be written with or
without `#`. A block that names a missing id is skipped with a warning; the rest still apply.

## Module API

### `trial/tree.mjs` — parse, serialize, index, patch, edit (no dependencies)

```js
export const TYPES                       // { [type]: { container: boolean, parents?: string[] } }
export function parse(text, { startId = 1 } = {})   // → { root, warnings: string[] }
export class Stream {                    // incremental: a line at a time, for live building
  constructor({ startId = 1 } = {})
  push(line)                              // → { node: Node|null, warning: string|null }
  get root()                              // the tree so far (the same object, growing)
  get warnings()
}
export function nextId(root)              // → integer
export function serialize(root, { ids = true } = {})   // → outline text that parse() reads back
export function index(root)               // → [{ id, type, text, screen, depth, parentId, node }] in document order
export function find(root, id)            // → { node, parent, index } | null
export function describe(node)            // → one short human line: 'text "Runs" · l bold', 'col #nav · w=200 fill=light · "Relay · Runs · Agents"'
export function shapeOf(node)             // → "a list of 5 rows", "holds text, row" — what a container is made of
export function positionOf(root, id)      // → "item 2 of a list of 4 texts", "at the left, narrow", "at the top of the screen"
// where a new piece goes, top down — only inside a padded container (a screen has no padding of its own)
export function padded(root, id)          // → whether a container, or one around it below the screen, has pad
export function sectionsOf(root, screenId) // → the parts of a screen: its children, through a lone wrapper, a full-height row of columns split
export function partsOf(root, screenId, skip)   // → [{ into, text }] — the first choice: which part, where it is and how big
export function spotsIn(root, id, skip)   // → [{ anchor, position, text } | { into, text }] — a container's own gaps, and the ways into it
export function edgesOf(root, screenId, id, skip) // → just below / above a stacked part, landing in the padded part next to it
export function neighboursIn(root, id, skip) // → [{ id, text }] — what a piece can follow when the sentence leaves the spot open
// shared elements
export function shares(root)              // → Map name → [copy roots]
export function copiesOf(root, id)        // → [{ id, copy }] — the same node in the other copies
export function firstCopy(root, id)       // → the copy that stands for all of them
export function sharedView(root)          // → { hidden, screens } — each shared element once, on all its screens
export function mirrorsOf(root, anchor, position) // → the same place in the other copies, when the place is inside a shared element
export function applyPatch(root, patchText)          // → { root, notes: string[], warnings: string[] }  (new object; input untouched)
export function apply(root, op, id, arg)  // → { ok, root, note, changed }  (new object; input untouched)
```

`apply` ops — the direct edits Jev chooses between. Each is one visible property change:

| op | on | effect |
|---|---|---|
| `bigger` / `smaller` | text, button, node, tr, input | one step along `size` (xs…xxl); on a container, every text inside it |
| `bold` / `regular` | text, node, tr | set / clear `bold`; on a container, every text inside it |
| `darker` / `lighter` | text, node, tr, shape; containers: `fill` | one step along `shade` (light↔mid↔dark); a container's `fill` steps light→mid→dark |
| `wider` / `narrower` | anything with `w` set in px (a circle with either side set) | `w` × 1.25 / ÷ 1.25, rounded; `w=fill` or no `w` → note, unchanged — the canvas hands it to the writer, which can set one |
| `taller` / `shorter` | anything with `h` set in px (a circle with either side set) | `h` × 1.25 / ÷ 1.25; unsized → note, unchanged. Nothing unsized is guessed at: a copy of the renderer's default sizes here drifted from the renderer until `wider` could shrink a stretched image |
| `move_earlier` / `move_later` | any node except the root (a screen moves among screens) | swap with the previous / next sibling (up in a col, left in a row) |
| `remove` | any node except the root | delete it (and its subtree); a node removed from a graph also removes its edges |
| `rename` | any node with text | `arg` is the new text |
| `clear` | — | the root keeps its name and frame, loses every screen |

An op that does not apply to the target returns `{ ok: true, changed: false, note: "<why>" }`.

### `trial/render.mjs` — tree → one greyscale HTML document (no dependencies)

```js
export function render(root, { title } = {})   // → "<!doctype html>…" string
```

- Every node's element carries `data-id="<id>"`; each screen's element also carries
  `data-screen="<screen text>"`.
- Screens are artboards stacked top to bottom, each with its name in faint small text above it.
  Frame sizes: `web` 1200 px wide, min-height 720; `phone` 375 × min 760 with a status bar;
  `panel` 360 wide inside a faint host strip. Phone screens may sit side by side.
- A screen is a column that fills its artboard; `h=fill` / `grow` children take the remaining height.
- Rows stretch their children vertically by default (so a side nav fills the screen height); cols
  stretch their children horizontally.
- Graph layout: layered, sources first, layer = longest path from a source (cycles broken in
  document order); nodes in a layer keep document order; edges are SVG curves with small
  arrowheads; edge labels sit at the curve's midpoint. `dir=down` stacks layers vertically.
- Must render a *partial* tree without error — the writer streams, and the canvas redraws after every
  line. Empty containers render as empty space, edges to missing nodes are skipped.
- Greyscale only: text #111 / #666 / #aaa; fills #f4f4f4 / #e6e6e6 / #222; borders #ddd. On a
  `fill=dark` the text shades turn over — #fff / #ccc / #999 — so `shade=light` there is still
  readable (writers put it on header bars meaning "light text").
  One sans font stack, no shadows, no gradients, radius ≤ 4px except `pill` and `circle`.
- Lint marks, as in `render/`: `data-lint="data"` on text with the `data` flag, on `tr data` rows'
  cells, on graph node labels and on `chart`/`progress`; `data-lint="ignore"` on artboard chrome.

## Tests

`node --test trial/test/*.test.mjs` from the repo root (Node 25 does not accept a bare directory).
