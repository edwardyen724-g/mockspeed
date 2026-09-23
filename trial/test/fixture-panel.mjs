// fixture-panel — a two-screen side panel (a reading assistant docked in a browser), built by
// hand. It exercises the controls a panel lives on — select, area, toggle, a dense table — and a
// top-to-bottom graph with a loop in it.

import { build } from "./fixture-relay.mjs";

export const panel = build(
  ["app", "Lens", { panel: true }, [
    ["screen", "Assistant", {}, [
      ["col", null, { h: "fill", pad: 4, gap: 3 }, [
        ["row", null, { justify: "between", align: "center" }, [
          ["text", "Lens", { size: "l", bold: true }],
          ["button", "New chat", { ghost: true }],
        ]],
        ["input", "Model", { select: true, value: "Sonnet" }],
        ["col", null, { fill: "light", pad: 3, gap: 1, border: true }, [
          ["text", "Summarize this page", { bold: true, data: true }],
          ["text", "The article argues that small teams ship faster when reviews are short and frequent.", { shade: "mid", data: true }],
        ]],
        ["table#sections", null, { divider: true }, [
          ["tr", "Section | Words | Read"],
          ["tr", "Intro | 412 | 2m", { data: true }],
          ["tr", "Method | 1,204 | 6m", { data: true }],
          ["tr", "Results | 880 | 4m", { data: true }],
        ]],
        ["input", "Ask a follow-up", { area: true, grow: true }],
        ["input", "Include page text", { toggle: true, on: true }],
        ["row", null, { justify: "end", gap: 2 }, [
          ["button", "Cancel"],
          ["button", "Send", { primary: true }],
        ]],
      ]],
    ]],
    ["screen", "Pipeline", {}, [
      ["col", null, { pad: 4, gap: 3 }, [
        ["text", "How a summary is made", { bold: true }],
        ["graph#flow", null, { dir: "down", h: 360, border: true }, [
          ["node#read", "Read page", { sub: "DOM → text" }],
          ["node#split", "Split", { sub: "by heading" }],
          ["node#sum", "Summarize", { bold: true }],
          ["node#check", "Check", { pill: true }],
          ["node#done", "Done", { circle: true }],
          ["edge", null, { from: "read", to: "split" }],
          ["edge", null, { from: "split", to: "sum" }],
          ["edge", "draft", { from: "sum", to: "check" }],
          ["edge", "too long", { from: "check", to: "sum", dashed: true }],
          ["edge", "ok", { from: "check", to: "done" }],
        ]],
        ["progress", "Summarizing", { value: 64 }],
      ]],
    ]],
  ]],
);
