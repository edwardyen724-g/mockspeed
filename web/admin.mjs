// admin — the page only the addresses in ADMIN_EMAILS see: what the models cost, today and over the
// last seven days, by person, by what each call was for and by model, and per sentence. The
// Anthropic rows are laid out as the Anthropic console's usage page counts them (input, cache
// write, cache read, output, per model and per UTC day), so the two can be set side by side.

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
const usd = (n) => (n == null ? "—" : n < 0.01 && n > 0 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`);
const int = (n) => Number(n ?? 0).toLocaleString("en-US");
const day = (t) => new Date(t).toISOString().slice(0, 10);

// Calls to a model: the app's own rows (sign-ins, exports) are counted apart.
const MODELS = (r) => r.provider !== "mockspeed";

function sum(rows) {
  const out = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sentences: new Set(), errors: 0 };
  for (const r of rows) {
    out.calls += 1;
    out.input += r.input_tokens ?? 0;
    out.output += r.output_tokens ?? 0;
    out.cacheRead += r.cache_read_tokens ?? 0;
    out.cacheWrite += r.cache_write_tokens ?? 0;
    out.cost += Number(r.cost_usd ?? 0);
    if (r.sentence) out.sentences.add(r.sentence);
    if (r.status !== "ok") out.errors += 1;
  }
  return out;
}
const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m].map(([k, rs]) => [k, sum(rs)]).sort((a, b) => b[1].cost - a[1].cost);
};

function table(head, rows) {
  return `<table><thead><tr>${head.map((h, i) => `<th${i ? ' class="n"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${head.length}" class="none">nothing yet</td></tr>`
  }</tbody></table>`;
}

export function adminPage(all, { since, now, keys }) {
  const rows = all.filter(MODELS);
  const today = day(now);
  const todays = rows.filter((r) => day(r.created_at) === today);
  const t = sum(todays), w = sum(rows);
  const perSentence = (s) => (s.sentences.size ? usd(s.cost / s.sentences.size) : "—");
  const days = [];
  for (let d = new Date(since); d <= now; d = new Date(d.getTime() + 86400000)) days.push(day(d));
  const anthropic = rows.filter((r) => r.provider === "anthropic");
  const jev = rows.filter((r) => r.provider === "typesafe");
  const who = (r) => r.email ?? (r.anon ? "no account yet" : "—");
  const events = all.filter((r) => r.provider === "mockspeed");

  const byDay = days.map((d) => {
    const rs = rows.filter((r) => day(r.created_at) === d);
    const s = sum(rs);
    const cost = (p) => sum(rs.filter((r) => r.provider === p)).cost;
    return [d, int(s.sentences.size), int(s.calls), usd(cost("anthropic")), usd(cost("typesafe")), usd(cost("openrouter")), `<b>${usd(s.cost)}</b>`, perSentence(s)];
  }).reverse();
  const counted = days.flatMap((d) => group(anthropic.filter((r) => day(r.created_at) === d), (r) => r.model)
    .map(([m, s]) => [d, esc(m), int(s.input), int(s.cacheWrite), int(s.cacheRead), int(s.output), usd(s.cost), int(s.calls)])).reverse();
  const people = (rs) => group(rs, who).map(([k, s]) => [esc(k), int(s.sentences.size), int(s.calls), usd(s.cost), perSentence(s)]);
  const purposes = (rs) => group(rs, (r) => `${r.provider} · ${r.purpose}`).map(([k, s]) => [esc(k), int(s.calls), int(s.input), int(s.output), usd(s.cost), s.errors ? `<b>${int(s.errors)}</b>` : "0"]);

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · usage</title>
<style>
  :root{--line:#e3e3e3;--faint:#8a8a8a}
  body{margin:0;padding:24px 16px 64px;font:13px/1.45 system-ui,-apple-system,sans-serif;color:#111;background:#fff;max-width:1100px;margin:0 auto}
  h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:28px 0 8px} .sub{color:var(--faint)}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:16px}
  .tile{border:1px solid var(--line);border-radius:6px;padding:10px 12px} .tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
  .tile span{color:var(--faint);font-size:12px}
  .wrap{overflow-x:auto} table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap} th{font-weight:600;color:#333}
  .n{text-align:right} .none{color:var(--faint);text-align:left}
</style></head><body>
<h1>Usage and cost</h1>
<div class="sub">Every model call the app made, from ${esc(day(since))} to now (UTC). Writer: ${esc(keys.provider)} · ${esc(keys.buildModel)} builds, ${esc(keys.model)} pieces.</div>
<div class="tiles">
  <div class="tile"><b>${usd(t.cost)}</b><span>today</span></div>
  <div class="tile"><b>${usd(w.cost)}</b><span>last 7 days</span></div>
  <div class="tile"><b>${int(t.sentences.size)}</b><span>sentences today</span></div>
  <div class="tile"><b>${perSentence(w)}</b><span>per sentence, 7 days</span></div>
  <div class="tile"><b>${int(jev.filter((r) => /429/.test(r.status)).length)}</b><span>Jev 429s, 7 days</span></div>
  <div class="tile"><b>${int(events.filter((r) => r.purpose === "signin").length)} · ${int(events.filter((r) => r.purpose.startsWith("export")).length)}</b><span>sign-ins · exports, 7 days</span></div>
</div>
<h2>By day</h2><div class="wrap">${table(["day (UTC)", "sentences", "calls", "Anthropic", "Jev", "OpenRouter", "total", "per sentence"], byDay)}</div>
<h2>Anthropic, as the console counts it</h2><div class="wrap">${table(["day (UTC)", "model", "input", "cache write", "cache read", "output", "cost", "calls"], counted)}</div>
<h2>By person, today</h2><div class="wrap">${table(["who", "sentences", "calls", "cost", "per sentence"], people(todays))}</div>
<h2>By person, 7 days</h2><div class="wrap">${table(["who", "sentences", "calls", "cost", "per sentence"], people(rows))}</div>
<h2>By what it was for, 7 days</h2><div class="wrap">${table(["provider · purpose", "calls", "input", "output", "cost", "not ok"], purposes(rows))}</div>
</body></html>`;
}
