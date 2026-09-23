// fixture-relay — the FORMAT.md example outline, built by hand as the tree parse() returns.
//
// The renderer is tested without the parser (the two are written side by side), so its input is
// built here the long way. `build` gives ids the way FORMAT.md says the parser does: an explicit
// `#id` is kept, every other node gets the next free `n<k>` in document order, skipping ids
// already taken. RELAY_OUTLINE is kept alongside so a later test can check parse() against it.

export const RELAY_OUTLINE = `app "Relay" web
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
`;

// [type or "type#id", text, props, children] → Node
export function build(spec) {
  const taken = new Set();
  const collect = ([head, , , children = []]) => {
    const id = head.split("#")[1];
    if (id) taken.add(id);
    children.forEach(collect);
  };
  collect(spec);
  let next = 1;
  const auto = () => { while (taken.has(`n${next}`)) next += 1; taken.add(`n${next}`); return `n${next++}`; };
  const walk = ([head, text = null, props = {}, children = []]) => {
    const [type, explicit] = head.split("#");
    const node = { id: explicit ?? auto(), type, text, props: { ...props }, children: [] };
    node.children = children.map(walk);
    return node;
  };
  return walk(spec);
}

export const relay = build(
  ["app", "Relay", { web: true }, [
    ["screen", "Runs", {}, [
      ["row", null, { h: "fill" }, [
        ["col#nav", null, { w: 200, fill: "light", pad: 3, gap: 2 }, [
          ["text", "Relay", { size: "l", bold: true }],
          ["text", "Runs", { bold: true }],
          ["text", "Agents", { shade: "mid" }],
          ["text", "Settings", { shade: "mid" }],
        ]],
        ["col", null, { grow: true, pad: 4, gap: 3 }, [
          ["row", null, { justify: "between", align: "center" }, [
            ["text", "Run 1482", { size: "xl", bold: true }],
            ["button", "Stop run", { primary: true }],
          ]],
          ["graph", null, { dir: "right", h: 260 }, [
            ["node#plan", "Planner", { sub: "done · 12s" }],
            ["node#code", "Coder", { sub: "running", bold: true }],
            ["node#test", "Tester", { sub: "waiting", shade: "light", border: "dashed" }],
            ["edge", null, { from: "plan", to: "code" }],
            ["edge", "on pass", { from: "code", to: "test" }],
          ]],
          ["table", null, {}, [
            ["tr", "Step | Agent | Tokens | Time"],
            ["tr", "Plan tasks | Planner | 1,204 | 12s", { data: true }],
            ["tr", "Write fix | Coder | 8,730 | 41s", { data: true }],
          ]],
        ]],
      ]],
    ]],
  ]],
);
