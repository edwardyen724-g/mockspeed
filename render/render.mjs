#!/usr/bin/env node
// render — turns a mockspeed spec into one self-contained greyscale HTML file.
//
//   render <spec.json> [-o mock.html]        (stdout when -o is omitted)
//   import { render, validate } from "./render.mjs"
//
// The spec is the running spec, made literal. Elements are in screen order; `tier` carries the
// hierarchy (heavy = the one thing that matters, mid = supporting, faint = chrome and metadata).
// Data is marked structurally — rows, values, items declared data — so mocklint reads the output
// without any hand-placed marks, and every element carries a data-id the canvas can point at.
//
// {
//   "title": "forecast",
//   "frame": "phone" | "web" | "panel",         default web; a screen may override
//   "layout": "row" | "stack",                  default: row for phone/panel, stack for web
//   "screens": [{ "name", "primary", "frame"?, "elements": [ ...elements ] }],
//   "data": { ... }, "decisions": [ ... ]       carried, never rendered
// }
//
// Every element: { "kind", "id"?, "tier"?: "heavy"|"mid"|"faint", "label"?: caption above (judged) }
//
//   stat     value·  unit  sub·  note·                the number that is the screen
//   text     text  sub  lead   data?  caps?  link?    a line; judged unless data: true
//   field    label  value·  multiline?  count·        an input with what is typed in it
//   button   label  wide?  align?                     heavy = filled, mid = outlined, faint = link
//   chips    items  off?  style?: "plain"  data?      judged unless data: true; off = rejected
//   tabs     items  on                                 phone: bottom bar · web/panel: top row
//   list     rows·[{ n text sub meta avatar on off flag }]  ranked?
//   table    columns  rows·[ [cell…] | { cells fade flag on } ]  more·  flags?  clip?  widths?    cell = "s" | [main, sub] | { text sub fade }
//   row      items[ element… ]  align?  justify?      children side by side; child grow?
//   strip    values·  scale?  bands?  marker·  width?  1-D dots on a line with bands
//   scatter  points·  highlight·  axes  diagonal?  size?
//
// · = data (marked, not judged).  Anything else the designer wrote is judged by mocklint.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ---- vocabulary --------------------------------------------------------------------------

const TIERS = ["heavy", "mid", "faint"];
const FRAMES = ["web", "phone", "panel"];
const KINDS = {
  stat:    { need: ["value"] },
  text:    { need: ["text"] },
  field:   { need: ["label"] },
  button:  { need: ["label"] },
  chips:   { need: ["items"] },
  tabs:    { need: ["items"] },
  list:    { need: ["rows"] },
  table:   { need: ["columns", "rows"] },
  row:     { need: ["items"] },
  strip:   { need: ["values"] },
  scatter: { need: ["points"] },
};

export function validate(spec) {
  const errors = [];
  const at = (path, msg) => errors.push(`${path}: ${msg}`);
  if (!spec || typeof spec !== "object") return ["spec: not an object"];
  if (spec.frame && !FRAMES.includes(spec.frame)) at("frame", `unknown frame '${spec.frame}' (${FRAMES.join(" | ")})`);
  if (spec.layout && !["row", "stack"].includes(spec.layout)) at("layout", `unknown layout '${spec.layout}' (row | stack)`);
  if (!Array.isArray(spec.screens) || !spec.screens.length) { at("screens", "at least one screen"); return errors; }
  spec.screens.forEach((s, i) => {
    const p = `screens[${i}]`;
    if (!s || typeof s !== "object") return at(p, "not an object");
    if (!s.name) at(p, "missing name");
    if (s.frame && !FRAMES.includes(s.frame)) at(p, `unknown frame '${s.frame}'`);
    if (!Array.isArray(s.elements)) return at(p, "missing elements[]");
    s.elements.forEach((e, j) => checkEl(e, `${p}.elements[${j}]`, at));
  });
  return errors;
}

function checkEl(e, p, at) {
  if (!e || typeof e !== "object") return at(p, "not an object");
  const k = KINDS[e.kind];
  if (!k) return at(p, `unknown kind '${e.kind}' (${Object.keys(KINDS).join(" | ")})`);
  for (const f of k.need) if (e[f] === undefined) at(p, `${e.kind} needs '${f}'`);
  if (e.tier && !TIERS.includes(e.tier)) at(p, `unknown tier '${e.tier}' (${TIERS.join(" | ")})`);
  if (e.kind === "row" && Array.isArray(e.items)) e.items.forEach((c, j) => checkEl(c, `${p}.items[${j}]`, at));
  if (e.kind === "table" && Array.isArray(e.rows)) e.rows.forEach((r, j) => {
    const cells = Array.isArray(r) ? r : r?.cells;
    if (!Array.isArray(cells)) at(`${p}.rows[${j}]`, "a row is [cell…] or { cells: [cell…] }");
  });
}

// ---- html --------------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = (...xs) => xs.filter(Boolean).join(" ");
const DATA = ' data-lint="data"';
const IGN = ' data-lint="ignore"';

function el(e, ctx) {
  const id = e.id ?? ctx.nextId(e.kind);
  const tier = e.tier ?? "mid";
  const inner = KIND_HTML[e.kind](e, ctx, tier);
  const cap = e.label && e.kind !== "field" && e.kind !== "button" ? `<div class="cap">${esc(e.label)}</div>` : "";
  const grow = e.grow ? " grow" : "";
  return `<div class="${cls("el", "el-" + e.kind, "tier-" + tier, e.align && "al-" + e.align)}${grow}" data-id="${esc(id)}">${cap}${inner}</div>`;
}

const line = (s, c, data = true) => (s ? `<div class="${c}"${data ? DATA : ""}>${esc(s)}</div>` : "");

const KIND_HTML = {
  stat: (e) =>
    `<div class="val"><span${DATA}>${esc(e.value)}</span>${e.unit ? ` <span class="unit">${esc(e.unit)}</span>` : ""}</div>` +
    line(e.sub, "sub") + line(e.note, "note"),

  text: (e) => {
    const d = e.data ? DATA : "";
    const lead = e.lead ? `<b${d}>${esc(e.lead)}</b> ` : "";
    return `<div class="${cls("txt", e.caps && "caps", e.link && "link")}"${d}>${lead}${esc(e.text)}</div>` +
      (e.sub ? `<div class="sub"${d}>${esc(e.sub)}</div>` : "");
  },

  field: (e) =>
    (e.label ? `<div class="cap">${esc(e.label)}</div>` : "") +
    `<div class="${cls("box", e.multiline && "multi")}"${DATA}>${esc(e.value ?? "")}</div>` +
    (e.count ? `<div class="count"${DATA}>${esc(e.count)}</div>` : ""),

  button: (e, ctx) => `<a class="${cls("btn", (e.wide ?? ctx.frame === "phone") && "wide")}">${esc(e.label)}</a>`,

  chips: (e) => {
    const off = new Set(e.off ?? []);
    const d = e.data ? DATA : "";
    return `<div class="${cls("chips", e.style === "plain" && "plain")}"${d}>` +
      e.items.map((it) => `<span class="${off.has(it) ? "off" : ""}">${esc(it)}</span>`).join("") + `</div>`;
  },

  tabs: (e) => `<div class="tabs">` + e.items.map((it) => `<span class="${it === e.on ? "on" : ""}">${esc(it)}</span>`).join("") + `</div>`,

  list: (e) =>
    `<div class="${cls("list", e.ranked && "ranked")}"${DATA}>` +
    e.rows.map((r) =>
      `<div class="${cls("li", r.on && "on", r.off && "off")}">` +
      (r.avatar !== undefined ? `<span class="av">${esc(r.avatar)}</span>` : "") +
      (r.n !== undefined ? `<b>${esc(r.n)}</b>` : "") +
      `<span class="bd"><span class="t">${esc(r.text)}</span>${r.sub ? `<span class="s">${esc(r.sub)}</span>` : ""}` +
      (r.avatar !== undefined && r.meta ? `<span class="m">${esc(r.meta)}</span>` : "") + `</span>` +
      (r.avatar === undefined && r.meta !== undefined ? `<small>${esc(r.meta)}</small>` : "") +
      (r.flag ? `<i>${esc(r.flag)}</i>` : "") +
      `</div>`).join("") + `</div>`,

  table: (e) => {
    const cell = (c) => {
      if (Array.isArray(c)) return `<td>${esc(c[0])}<small>${esc(c[1])}</small></td>`;
      if (c && typeof c === "object") return `<td class="${c.fade ? "fade" : ""}">${esc(c.text)}${c.sub ? `<small>${esc(c.sub)}</small>` : ""}</td>`;
      return `<td>${esc(c)}</td>`;
    };
    const rows = e.rows.map((r) => {
      const o = Array.isArray(r) ? { cells: r } : r;
      return `<tr class="${cls(o.fade && "fade" + o.fade, o.on && "on")}">` + o.cells.map(cell).join("") + (e.flags ? `<td class="flag">${esc(o.flag ?? "")}</td>` : "") + `</tr>`;
    }).join("");
    const th = (c, i) => `<th${e.widths?.[i] ? ` style="width:${esc(e.widths[i])}"` : ""}>${esc(c)}</th>`;
    return `<table class="${e.clip ? "clip" : ""}"><thead><tr>${e.columns.map(th).join("")}${e.flags ? "<th></th>" : ""}</tr></thead>` +
      `<tbody${DATA}>${rows}</tbody></table>` + (e.more ? `<div class="more"${DATA}>${esc(e.more)}</div>` : "");
  },

  row: (e, ctx) => `<div class="${cls("cols", e.justify && "j-" + e.justify, e.align && "a-" + e.align)}">${e.items.map((c) => el(c, ctx)).join("")}</div>`,

  strip: (e) => {
    const w = e.width ?? 300, h = 28, pad = 3;
    const vals = e.values.filter((v) => typeof v === "number");
    const log = e.scale !== "linear";
    const f = (v) => (log ? Math.log10(Math.max(v, 1)) : v);
    const lo = Math.min(...vals.map(f)), hi = Math.max(...vals.map(f));
    const x = (v) => (hi === lo ? w / 2 : pad + ((f(v) - lo) / (hi - lo)) * (w - 2 * pad)).toFixed(1);
    const bands = (e.bands ?? []).map(([a, b], i) =>
      `<line x1="${x(a)}" y1="14" x2="${x(b)}" y2="14" stroke="${i === 0 ? "#999" : "#111"}" stroke-width="${i === 0 ? 2 : 4}"/>`).join("");
    const mark = e.marker !== undefined ? `<line x1="${x(e.marker)}" y1="6" x2="${x(e.marker)}" y2="22" stroke="#111" stroke-width="2"/><circle cx="${x(e.marker)}" cy="14" r="4.5" fill="#fff" stroke="#111" stroke-width="2"/>` : "";
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${IGN}><line x1="0" y1="14" x2="${w}" y2="14" stroke="#ddd"/>` +
      `<g fill="#ccc">${vals.map((v) => `<circle cx="${x(v)}" cy="14" r="2.5"/>`).join("")}</g>${bands}${mark}</svg>`;
  },

  scatter: (e) => {
    const s = e.size ?? 200, pad = 8;
    const pts = e.points.filter((p) => Array.isArray(p));
    const xs = pts.map((p) => p[0]).concat(e.highlight ? [e.highlight[0]] : []);
    const ys = pts.map((p) => p[1]).concat(e.highlight ? [e.highlight[1]] : []);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const sx = (v) => (pad + ((v - x0) / (x1 - x0 || 1)) * (s - 2 * pad)).toFixed(1);
    const sy = (v) => (s - pad - ((v - y0) / (y1 - y0 || 1)) * (s - 2 * pad)).toFixed(1);
    const axes = e.axes ? `<div class="ax" style="width:${s}px"><span>${esc(e.axes[0])}</span><span>${esc(e.axes[1])}</span></div>` : "";
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"${IGN}><rect x="0.5" y="0.5" width="${s - 1}" height="${s - 1}" fill="none" stroke="#ddd"/>` +
      (e.diagonal ? `<line x1="${pad}" y1="${s - pad}" x2="${s - pad}" y2="${pad}" stroke="#ddd"/>` : "") +
      `<g fill="#bbb">${pts.map(([x, y]) => `<circle cx="${sx(x)}" cy="${sy(y)}" r="2.5"/>`).join("")}</g>` +
      (e.highlight ? `<circle cx="${sx(e.highlight[0])}" cy="${sy(e.highlight[1])}" r="3.5" fill="#111"/>` : "") + `</svg>` + axes;
  },
};

// ---- frames ------------------------------------------------------------------------------

function screen(s, spec) {
  const frame = s.frame ?? spec.frame ?? "web";
  const counts = {};
  const ctx = { frame, nextId: (k) => `${k}${(counts[k] = (counts[k] ?? 0) + 1)}` };
  const tabs = frame === "phone" ? s.elements.find((e) => e.kind === "tabs") : null;
  const body = s.elements.filter((e) => e !== tabs).map((e) => el(e, ctx)).join("\n");
  const attrs = `data-screen="${esc(s.name)}"${s.primary ? ` data-primary="${esc(s.primary)}"` : ""}`;
  if (frame === "phone") {
    return `<section class="screen phone" ${attrs}>
<div class="status"${IGN}><span>9:41</span><span><i></i><i></i></span></div>
<div class="body">
${body}
</div>
${tabs ? el(tabs, ctx) : ""}
</section>`;
  }
  if (frame === "panel") {
    return `<section class="screen panel-host" ${attrs}>
<div class="host"${IGN}><div class="host-bar"><i></i><i></i><i></i></div><div class="host-side"></div><div class="host-main"></div></div>
<div class="panel">
${body}
</div>
</section>`;
  }
  return `<section class="screen web" ${attrs}>
${body}
</section>`;
}

const CSS = `
body{margin:0;background:#fff;color:#111;font:14px/1.4 system-ui,-apple-system,sans-serif}
.mock{display:flex;gap:40px;justify-content:center;align-items:flex-start;flex-wrap:wrap;padding:40px 24px}
.mock.stack{flex-direction:column;align-items:stretch;gap:0;max-width:1080px;margin:0 auto}
.mock.stack>.screen+.screen{border-top:1px dashed #ccc;margin-top:56px;padding-top:40px}
.screen.web{width:100%;box-sizing:border-box}
.el{margin:0 0 14px}.el:last-child{margin-bottom:0}
.cap{font-size:11px;color:#aaa;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
.grow{flex:1}
.al-center{text-align:center}
/* stat */
.el-stat .val{font-weight:600;line-height:1.05;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
.tier-heavy.el-stat .val{font-size:56px;letter-spacing:-1px}
.tier-mid.el-stat .val{font-size:28px;font-weight:700}
.tier-faint.el-stat .val{font-size:20px;color:#999}
.el-stat .unit{font-size:.5em;font-weight:400;color:#999;letter-spacing:0}
.tier-heavy.el-stat .unit{font-size:.35em}
.el-stat .sub{color:#888;font-size:13px;margin-top:6px}
.el-stat .note{color:#bbb;font-size:12px;margin-top:4px}
/* text */
.el-text .txt{font-variant-numeric:tabular-nums}
.tier-heavy.el-text .txt{font-size:20px;font-weight:600;color:#111;border-bottom:1px solid #111;padding-bottom:6px}
.tier-mid.el-text .txt{color:#666}
.tier-faint.el-text .txt{color:#bbb;font-size:12px}
.el-text .txt b{color:#111;font-weight:500}
.el-text .caps{font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.el-text .link{text-decoration:underline;text-decoration-color:#ddd}
.el-text .sub{color:#bbb;font-size:13px;margin-top:6px}
/* field */
.el-field .box{border:1px solid #bbb;padding:10px 12px;font-size:15px;line-height:1.35;min-height:20px;white-space:pre-wrap}
.el-field .multi{min-height:118px}
.tier-heavy.el-field .box{font-size:17px}
.tier-faint.el-field .box{border-color:#ddd;color:#999}
.el-field .count{text-align:right;font-size:12px;color:#bbb;margin-top:4px;font-variant-numeric:tabular-nums}
/* button */
.el-button{margin-top:16px}
.btn{display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;text-align:center;box-sizing:border-box;white-space:nowrap}
.btn.wide{display:block;padding:14px;font-size:15px}
.tier-heavy .btn{background:#111;color:#fff;border:1px solid #111}
.tier-mid .btn{background:#fff;color:#555;border:1px solid #bbb;font-weight:400}
.tier-faint .btn{color:#999;font-weight:400;text-decoration:underline;padding:0;font-size:13px}
/* chips */
.chips span{display:inline-block;border:1px solid #111;padding:4px 10px;margin:0 6px 6px 0;font-size:13px}
.tier-mid .chips span{border-color:#999;color:#333}
.tier-faint .chips span{border-color:#ddd;color:#999}
.chips span.off{border-color:#ddd;color:#bbb}
.chips.plain span{border:0;padding:0;margin:0 14px 6px 0;color:#333}
.chips.plain span.off{color:#ccc;text-decoration:line-through}
/* tabs */
.el-tabs .tabs{display:flex;gap:18px;font-size:13px;color:#bbb}
.el-tabs .tabs .on{color:#111;font-weight:600}
/* list */
.list .li{display:flex;gap:10px;align-items:baseline;padding:5px 0;font-size:13px;color:#777;position:relative}
.list .li b{color:#111;font-weight:700;min-width:38px;flex:none;font-variant-numeric:tabular-nums}
.list .li .bd{flex:1;min-width:0}
.list .li .t{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list .li .s{display:block;color:#aaa;font-size:12px;margin-top:2px}
.list .li small{color:#bbb;flex:none}
.list .li i{color:#777;font-style:normal;flex:none}
.list .li.on{color:#111}.list .li.on .t{font-weight:500}
.list .li.off{opacity:.45}
.list .av{width:44px;height:44px;border-radius:50%;background:#eee;color:#999;font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;align-self:center}
.list .li:has(.av){align-items:center}
.list .li:has(.av) .t{font-size:18px;font-weight:700;color:#111;white-space:normal}
.list .li .m{display:block;color:#999;font-size:13px;margin-top:2px;font-variant-numeric:tabular-nums}
.list .li:has(.av) .s{font-size:13px;color:#777}
.tier-heavy .list .li{color:#111;font-size:15px}
.tier-faint .list .li{color:#bbb}
.list.ranked{border-left:1px solid #ddd;padding-left:14px;margin-left:5px}
.list.ranked .li:before{content:"";position:absolute;left:-18px;top:11px;width:6px;height:6px;border-radius:50%;background:#ddd}
.list.ranked .li.on:before{background:#111}
/* table */
table{border-collapse:collapse;width:100%}
th{text-align:left;font-weight:400;color:#aaa;font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:8px 8px 6px 0;border-bottom:1px solid #ddd}
td{padding:8px 8px 8px 0;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;font-variant-numeric:tabular-nums;color:#333}
td small{display:block;color:#aaa;font-size:12px;font-weight:400;margin-top:2px}
td.fade{color:#999}
table.clip td{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px}
td.flag{width:14px;text-align:right;color:#777}
tr.fade1 td{opacity:.55}tr.fade2 td{opacity:.35}
tr.on td{color:#111;font-weight:500}
.tier-heavy td{color:#111}
.tier-faint td{color:#999}
.more{color:#bbb;text-align:center;padding:14px 0 0}
/* row */
.cols{display:flex;gap:12px;align-items:flex-start}
.screen.web .cols{gap:24px}
.cols>.el{margin:0}
.cols.j-between{justify-content:space-between}
.cols.a-end{align-items:flex-end}.cols.a-center{align-items:center}
/* charts */
.el-strip svg,.el-scatter svg{display:block}
.ax{display:flex;justify-content:space-between;color:#aaa;font-size:11px;margin-top:4px}
/* phone */
.phone{width:360px;height:740px;border:2px solid #999;display:flex;flex-direction:column;flex:none;box-sizing:border-box}
.phone .status{display:flex;justify-content:space-between;padding:10px 18px 0;font-size:12px;color:#999}
.phone .status i{display:inline-block;width:10px;height:6px;border:1px solid #bbb;margin-left:4px;vertical-align:middle}
.phone .body{flex:1;padding:22px 20px 0;overflow:hidden}
.phone .el-tabs{margin:0}
.phone .el-tabs .tabs{border-top:1px solid #ddd;padding:12px 0 22px;gap:0}
.phone .el-tabs .tabs span{flex:1;text-align:center;font-size:11px}
.phone .tier-heavy.el-stat .val{font-size:28px;font-weight:700}
.phone .tier-mid.el-stat .val{font-size:22px}
.phone .tier-heavy.el-text .txt{font-size:17px;border:0;padding:0}
.phone .el{margin-bottom:12px}
.phone td{padding:5px 6px 5px 0}.phone th{padding:4px 6px 4px 0}
.phone .el-strip,.phone .el-scatter{margin-bottom:8px}
/* panel in a faint host */
.panel-host{position:relative;width:900px;min-height:560px;flex:none;box-sizing:border-box;padding:52px 16px 16px 0;display:flex;justify-content:flex-end;align-items:flex-start}
.host{position:absolute;inset:0;border:1px solid #ddd;background:#fafafa}
.host-bar{height:36px;border-bottom:1px solid #e5e5e5;background:#f4f4f4;padding:12px}
.host-bar i{display:inline-block;width:10px;height:10px;border-radius:50%;background:#ddd;margin-right:6px}
.host-side{position:absolute;left:0;top:37px;bottom:0;width:48px;background:#f4f4f4;border-right:1px solid #e5e5e5}
.panel{position:relative;width:320px;min-height:492px;background:#fff;border:1px solid #bbb;padding:18px;box-sizing:border-box}
`;

export function render(spec) {
  const errors = validate(spec);
  if (errors.length) throw new Error("invalid spec:\n  " + errors.join("\n  "));
  const frame = spec.frame ?? "web";
  const layout = spec.layout ?? (frame === "web" ? "stack" : "row");
  const json = JSON.stringify(spec).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(spec.title ?? "mock")}</title>
<style>${CSS}</style></head>
<body><div class="mock ${layout}">
${spec.screens.map((s) => screen(s, spec)).join("\n\n")}
</div>
<script type="application/json" id="mockspeed-spec">${json}</script>
</body></html>
`;
}

// ---- cli ---------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const o = args.indexOf("-o");
  const out = o >= 0 ? args[o + 1] : null;
  const file = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-o");
  if (!file || args.includes("--help")) {
    console.error("usage: render <spec.json> [-o mock.html]");
    process.exit(2);
  }
  let spec;
  try { spec = JSON.parse(readFileSync(resolve(file), "utf8")); }
  catch (e) { console.error(`render: ${file}: ${e.message}`); process.exit(2); }
  const errors = validate(spec);
  if (errors.length) { console.error("render: invalid spec\n  " + errors.join("\n  ")); process.exit(2); }
  const html = render(spec);
  if (out) { writeFileSync(resolve(out), html); console.error(`render: ${out} · ${spec.screens.length} screen${spec.screens.length > 1 ? "s" : ""} · ${(html.length / 1024).toFixed(0)} KB`); }
  else process.stdout.write(html);
}
