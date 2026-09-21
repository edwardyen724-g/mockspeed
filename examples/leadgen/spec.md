# leadgen — running spec (as it stood when the mock was rendered, 2026-09-20)

This is the artifact that carries forward from a mockspeed session. The HTML next to it does not.

```
Screens:      Find → Confirm → Results (one page; the landing page is the tool)

Primary action per screen:
  Find      paste a product URL
  Confirm   Deploy agent (three pre-filled, editable confirmations)
  Results   Export CSV

Elements (hierarchy order):
  Confirm
    1. URL bar + "Find leads"; one-line product reading beneath it
    2. Who is this for?  — inferred ICP, heaviest; alternates faint
    3. What are they saying? — pain phrases as chips; rejected phrases outlined faint
    4. Where? — sources; rejected sources struck through
    5. "Deploy agent" (the one dark button); fine print faint
  Results
    1. reachable count (hero) · email valid / DM open / time · faint: catch-all, hopping, dropped
    2. per-source counts, faint
    3. table — Fit · Who · Signal · Contact
         contact column: email bold; DM channel faint; "via <path>" small under hop-recovered emails
         fit: Jev probability against the ICP, sorted desc, raw not bucketed; rows under .7 fade, no hard cut
         signal: source + age faint, verbatim quote mid
    4. "Export CSV"
    5. "1,061 more ↓"

Data shape:
  lead { fit: 0..1, name, handle?,
         source: { site, thread|repo|post, age },
         signal: string,
         contact: { kind: email|dm, value, channel?, via?: string[] }
                | { kind: hopping, path: string[] } }
  run  { url, productSummary, icp, painPhrases[], sources[],
         counts: { reachable, email, dm, hopping, dropped, bySource }, status }

Decisions:
  - no outreach, no creatives, no marketing — the output is the list
  - unit of volume = reachable (email or DM); unreachable rows are dropped but counted
  - go one hop further (profile → site → /team) before dropping a row
  - the agent infers the ICP; the user confirms, never picks from a menu
  - fit shown raw, not bucketed; every lead is attributable to a source and a quote
  - catch-all emails are free in the CSV and never counted
  - one screen, not a dashboard: nothing on it that is not a lead or the button that gets them
```
