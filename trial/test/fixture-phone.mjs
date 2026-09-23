// fixture-phone — a three-screen phone app, built by hand, that leans on composition: a task list
// with checkboxes and status tags, a stats screen with charts and a grid of number cards, and a
// chat thread whose bubbles are nothing but cols with a fill, pushed left or right by a row.

import { build } from "./fixture-relay.mjs";

export const phone = build(
  ["app", "Tide", { phone: true }, [
    ["screen", "Today", {}, [
      ["col", null, { h: "fill", pad: 4, gap: 3 }, [
        ["row", null, { justify: "between", align: "center" }, [
          ["col", null, { gap: 0 }, [
            ["text", "Tuesday 22", { size: "s", shade: "mid", data: true }],
            ["text", "Today", { size: "xl", bold: true }],
          ]],
          ["shape#me", "Me", { circle: true, w: 36, fill: "mid" }],
        ]],
        ["input", "Search tasks", { search: true }],
        ["row", null, { gap: 4 }, [
          ["text", "All", { under: true, bold: true }],
          ["text", "Work", { shade: "mid" }],
          ["text", "Home", { shade: "mid" }],
        ]],
        ["col#tasks", null, { divider: true, gap: 3 }, [
          ["row", null, { justify: "between", align: "center" }, [
            ["input", "Book the dentist", { check: true, on: true }],
            ["text", "done", { pill: true, size: "xs", shade: "light" }],
          ]],
          ["row", null, { justify: "between", align: "center" }, [
            ["input", "Reply to Sam", { check: true }],
            ["text", "today", { pill: true, size: "xs" }],
          ]],
          ["row", null, { justify: "between", align: "center" }, [
            ["input", "Pay the water bill", { check: true }],
            ["row", null, { gap: 1, align: "center" }, [
              ["shape", null, { circle: true, w: 8, fill: "dark" }],
              ["text", "overdue", { size: "xs" }],
            ]],
          ]],
        ]],
        ["progress", "3 of 7 done", { value: 43 }],
      ]],
      ["row#tabs", null, { justify: "between", pad: 4, border: true }, [
        ["text", "Today", { size: "xs", bold: true }],
        ["text", "Stats", { size: "xs", shade: "mid" }],
        ["text", "Chat", { size: "xs", shade: "mid" }],
      ]],
    ]],
    ["screen", "Stats", {}, [
      ["col", null, { pad: 4, gap: 4 }, [
        ["text", "This week", { size: "l", bold: true }],
        ["chart", "Tasks done per day", { values: "3,5,2,8,6,4,7", h: 140 }],
        ["grid", null, { cols: 2, gap: 3 }, [
          ["col", null, { border: true, pad: 3, gap: 0 }, [
            ["text", "31", { size: "xl", bold: true, data: true }],
            ["text", "done", { size: "s", shade: "mid" }],
          ]],
          ["col", null, { border: true, pad: 3, gap: 0 }, [
            ["text", "4.4", { size: "xl", bold: true, data: true }],
            ["text", "per day", { size: "s", shade: "mid" }],
          ]],
          ["col", null, { fill: "dark", pad: 3, gap: 0 }, [
            ["text", "12", { size: "xl", bold: true, data: true }],
            ["text", "day streak", { size: "s", shade: "mid" }],
          ]],
          ["col", null, { border: true, pad: 3, gap: 0 }, [
            ["text", "2", { size: "xl", bold: true, data: true }],
            ["text", "overdue", { size: "s", shade: "mid" }],
          ]],
        ]],
        ["chart", "Streak", { line: true, values: [2, 4, 3, 6, 5, 8, 9] }],
        ["button", "Share the week", { primary: true, w: "fill" }],
      ]],
    ]],
    ["screen", "Chat", {}, [
      ["row", null, { pad: 4, gap: 3, align: "center" }, [
        ["shape", "A", { circle: true, w: 32 }],
        ["col", null, { gap: 0 }, [
          ["text", "Ana", { bold: true, data: true }],
          ["text", "online", { size: "xs", shade: "mid" }],
        ]],
      ]],
      ["line"],
      ["col#thread", null, { grow: true, pad: 4, gap: 2 }, [
        ["row", null, { justify: "start" }, [
          ["col", null, { fill: "light", pad: 2, w: 240 }, [["text", "Are we still on for Thursday?", { data: true }]]],
        ]],
        ["row", null, { justify: "end" }, [
          ["col", null, { fill: "dark", pad: 2, w: 220 }, [["text", "Yes, 7pm at the usual place", { data: true }]]],
        ]],
        ["row", null, { justify: "start" }, [
          ["shape", "photo", { w: 180, h: 120 }],
        ]],
        ["text", "Seen 18:02", { size: "xs", shade: "light", data: true }],
      ]],
      ["row", null, { pad: 3, gap: 2, align: "center", border: true }, [
        ["input", "Message", { grow: true }],
        ["button", "Send", { primary: true }],
      ]],
    ]],
  ]],
);
