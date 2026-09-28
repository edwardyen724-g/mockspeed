// page — what the canvas's page is made of, for the local trial server (trial/server.mjs) and the
// web app (web/app.mjs) alike: the mock drawn with the layer that lets a person point at it, and the
// page around it with its words filled in.

import { readFileSync } from "node:fs";
import { render } from "./render.mjs";
import * as W from "./words.mjs";

// The marking layer, injected into the render (the renderer only draws). Ids are unique across the
// whole tree here, so a node's key is its id.
export const MARKER = `
<style>
  [data-id]{cursor:pointer}
  [data-id]:hover{outline:1px dashed #bbb;outline-offset:2px}
  [data-id].marked{outline:2px solid #111;outline-offset:2px}
  [data-id].twin{outline:2px dashed #111;outline-offset:2px}
  .pick{position:relative}
  .pick::after{content:attr(data-pick);position:absolute;top:-10px;left:-10px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center;z-index:9;zoom:var(--unzoom,1)}
  /* The toolbar and the word editor are the canvas's, not the mock's: drawn over it, at true size
     however far the page zooms the mock out (see pos()). */
  #ms-bar{position:absolute;z-index:50;height:0}
  #ms-bar .in{display:flex;gap:2px;padding:3px;background:#111;border-radius:6px;white-space:nowrap;
    box-shadow:0 2px 8px rgba(0,0,0,.25);font:12px/1 system-ui,-apple-system,sans-serif;width:max-content}
  #ms-bar button{font:inherit;color:#fff;background:transparent;border:0;border-radius:4px;padding:6px 8px;cursor:pointer}
  #ms-bar button:hover{background:#333}
  #ms-bar button.on{background:#fff;color:#111}
  #ms-bar .sep{width:1px;background:#444;margin:3px 2px}
  #ms-edit{position:absolute;z-index:60;margin:0;padding:0 2px;border:0;outline:2px solid #111;background:#fff;color:#111;box-sizing:border-box}
  .ms-drop{position:absolute;z-index:40;background:#111;border-radius:2px;cursor:pointer}
  .ms-drop::after{content:attr(data-pick);position:absolute;left:-22px;top:50%;margin-top:-9px;background:#111;color:#fff;
    font:11px/18px system-ui;width:18px;height:18px;border-radius:9px;text-align:center;zoom:var(--unzoom,1)}
</style>
<script>
  const byId = (k) => document.querySelector('[data-id="' + CSS.escape(k) + '"]');
  const CHROME = "#ms-bar, #ms-edit, .ms-drop";
  // The page zooms the whole mock out to fit (shell.html fitMock); positions here are in the mock's
  // own pixels, which is what an absolutely placed element inside it is measured in.
  const zoom = () => parseFloat(document.documentElement.style.zoom) || 1;
  function pos(el) {
    if (el.offsetParent === undefined) {
      const r = el.getBoundingClientRect(), z = zoom();
      return { left: r.left / z + scrollX, top: r.top / z + scrollY, width: r.width / z, height: r.height / z };
    }
    let left = 0, top = 0;
    for (let n = el; n; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
    return { left, top, width: el.offsetWidth, height: el.offsetHeight };
  }
  const tell = (m) => parent.postMessage(m, "*");
  function mark(key) {
    document.querySelectorAll(".marked").forEach((m) => m.classList.remove("marked"));
    if (key) byId(key)?.classList.add("marked");
  }

  addEventListener("click", (e) => {
    if (e.target.closest(CHROME)) return;
    // An edge's label is drawn apart from its edge (so no line crosses it) and points back at it.
    const f = e.target.closest("[data-for]");
    const n = f ? byId(f.dataset.for) : e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    // A numbered thing is an offer: clicking it takes it, as its button beside the text box would.
    if (n.classList.contains("pick")) return tell({ type: "take", n: Number(n.dataset.pick) });
    mark(n.dataset.id);
    tell({ type: "mark", key: n.dataset.id });
  }, true);

  // ---- the toolbar -------------------------------------------------------------------------
  // What the page sends once an element is marked: the edits that would change it, and — when it
  // has twins — those that would change them, shown with "All 5 like this" on.
  let bar = null, allOn = false, wantWords = null;
  function drawBar() {
    document.getElementById("ms-bar")?.remove();
    document.querySelectorAll(".twin").forEach((n) => n.classList.remove("twin"));
    const el = bar && byId(bar.id);
    if (!el || !el.classList.contains("marked")) return;
    if (allOn) for (const k of bar.twins) if (k !== bar.id) byId(k)?.classList.add("twin");
    const list = allOn ? bar.allTools : bar.tools;
    if (!list.length && !bar.allLabel) return;
    const wrap = document.createElement("div");
    wrap.id = "ms-bar";
    const inner = document.createElement("div");
    inner.className = "in";
    // True size at any zoom: the wrapper sits in the mock's pixels, the buttons undo the zoom.
    inner.style.zoom = String(1 / zoom());
    const button = (label, on, act, title) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (on) b.className = "on";
      if (title) b.title = title;
      b.addEventListener("click", (e) => { e.preventDefault(); act(); });
      inner.appendChild(b);
    };
    if (bar.allLabel) {
      button(bar.allLabel, allOn, () => { allOn = !allOn; tell({ type: "all", key: bar.id, on: allOn }); drawBar(); });
      if (list.length) inner.appendChild(Object.assign(document.createElement("span"), { className: "sep" }));
    }
    for (const t of list) button(t.label, false, () => tell({ type: "tool", key: bar.id, op: t.op, all: allOn }), bar.renameHint);
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    const p = pos(el), h = inner.offsetHeight / zoom(), w = inner.offsetWidth / zoom();
    // Inside what is in view, clear of the scrollbar.
    const room = document.documentElement.clientWidth / zoom() + scrollX;
    wrap.style.left = Math.max(4, Math.min(p.left, room - w - 4)) + "px";
    // Above it, or under it where there is no room above.
    wrap.style.top = (p.top - h - 8 >= 0 ? p.top - h - 8 : p.top + p.height + 8) + "px";
  }

  // ---- words, edited where they are ----------------------------------------------------------
  function editWords(el) {
    document.getElementById("ms-edit")?.remove();
    const p = pos(el), cs = getComputedStyle(el);
    const inp = document.createElement("input");
    inp.id = "ms-edit";
    inp.value = bar.text;
    Object.assign(inp.style, { left: p.left + "px", top: p.top + "px", width: Math.max(p.width, 140) + "px", height: p.height + "px",
      font: cs.font, letterSpacing: cs.letterSpacing, textAlign: cs.textAlign === "center" ? "center" : "left" });
    document.body.appendChild(inp);
    inp.focus();
    inp.select();
    const key = el.dataset.id, was = bar.text;
    // Once: taking the editor out blurs it, and a blur is also a way to finish.
    let closed = false;
    const done = (keep) => {
      if (closed) return;
      closed = true;
      const v = inp.value.trim();
      inp.remove();
      if (keep && v && v !== was) tell({ type: "rename", key, text: v });
    };
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    inp.addEventListener("blur", () => done(true));
  }
  addEventListener("dblclick", (e) => {
    if (e.target.closest(CHROME)) return;
    const n = e.target.closest("[data-id]");
    if (!n) return;
    e.preventDefault();
    e.stopPropagation();
    // The toolbar's word for it may still be on its way from the page; edit once it lands.
    if (bar && bar.id === n.dataset.id) { if (bar.text != null) editWords(n); }
    else wantWords = n.dataset.id;
  }, true);

  // ---- offers, where they are ----------------------------------------------------------------
  // Each offer about an element numbers it; each about a place draws a numbered line there.
  function drops(list) {
    document.querySelectorAll(".ms-drop").forEach((n) => n.remove());
    for (const d of list || []) {
      const el = byId(d.anchor);
      if (!el) continue;
      const p = pos(el), z = zoom(), t = 3 / z;
      const inside = d.position === "inside_start" || d.position === "inside_end";
      const box = inside ? el : el.parentElement;
      const across = box && getComputedStyle(box).flexDirection.startsWith("row");
      const start = d.position === "before" || d.position === "inside_start";
      const line = document.createElement("div");
      line.className = "ms-drop";
      line.dataset.pick = d.n;
      if (across) {
        const x = inside ? (start ? p.left + t : p.left + p.width - 2 * t) : (start ? p.left - 2 * t : p.left + p.width + t);
        Object.assign(line.style, { left: x + "px", top: p.top + "px", width: t + "px", height: p.height + "px" });
      } else {
        const y = inside ? (start ? p.top + t : p.top + p.height - 2 * t) : (start ? p.top - 2 * t : p.top + p.height + t);
        Object.assign(line.style, { left: p.left + "px", top: y + "px", width: p.width + "px", height: t + "px" });
      }
      line.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); tell({ type: "take", n: d.n }); });
      document.body.appendChild(line);
    }
  }

  addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "mark") {
      mark(m.key);
      // A reply about something already there brings it into view, on whichever page it is.
      if (m.reveal && m.key) byId(m.key)?.scrollIntoView({ block: "center", inline: "center" });
      if (!m.key || m.key !== bar?.id) { bar = null; allOn = false; }
      drawBar();
    }
    if (m.type === "tools") {
      allOn = Boolean(m.allOn) && m.tools.twins.length >= 2;
      bar = m.tools;
      drawBar();
      if (wantWords === bar.id) { wantWords = null; if (bar.text != null) editWords(byId(bar.id)); }
    }
    if (m.type === "pick") {
      // Numbers at true size, like the toolbar, however far the mock is zoomed out.
      document.documentElement.style.setProperty("--unzoom", String(1 / zoom()));
      document.querySelectorAll(".pick").forEach((n) => { n.classList.remove("pick"); n.removeAttribute("data-pick"); });
      // keys[i] is the element offer i + 1 is about, or null.
      (m.keys || []).forEach((k, i) => { const n = k && byId(k); if (n) { n.classList.add("pick"); n.dataset.pick = i + 1; } });
      drops(m.drops);
    }
  });
</script>`;

// The mock as the page's frame shows it: drawn, with the marking layer. A tree that will not draw
// says so in the frame rather than breaking the page.
export function mockPage(root) {
  let html;
  try { html = render(root); } catch (e) { html = `<!doctype html><body><pre style="color:#666">render failed: ${String(e.message).replace(/</g, "&lt;")}</pre></body>`; }
  return html.includes("</body>") ? html.replace("</body>", MARKER + "\n</body>") : html + MARKER;
}

// A page's own words ({{placeholder}} and the rest) are words.mjs's, like everything else; `more`
// adds or overrides some for one page. An unknown {{name}} is left as it is.
const escHtml = (t) => String(t).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
export function fill(html, more = {}) {
  const words = { ...W.ui, ...more };
  return html.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(words, k) ? escHtml(words[k]) : m));
}

// The canvas's page, as trial/server.mjs serves it; the web app adds its own words and mode.
export const shell = (more = {}) => fill(readFileSync(new URL("./shell.html", import.meta.url), "utf8"), { mode: "trial", ...W.web, title: W.ui.title, ...more });
