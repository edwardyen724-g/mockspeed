#!/usr/bin/env node
// gallery — a page for looking through through-the-app runs (trial/eval/run.mjs): each app's
// render after the build and after the follow-ups, every Jev decision with its confidence, every
// question put to the person, and — when trial/eval/judge.workflow.js has been run — the judges'
// verdict on each step and each build's substance score.
//
//   node trial/eval/gallery.mjs <out-dir> <run-dir>[=Label] [<run-dir>[=Label] ...]
//
// The first run is the one the scoreboard is about; the others are there to compare. Renders and
// screenshots are written to <out-dir> (headless Chrome, one profile per capture: it saves the
// PNG and then does not always exit, so each capture is killed once its file appears). Serve the
// folder with any static server and open index.html.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, index } from "../tree.mjs";
import { render } from "../render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const [outArg, ...runArgs] = process.argv.slice(2);
if (!outArg || !runArgs.length) { console.error("usage: node trial/eval/gallery.mjs <out-dir> <run-dir>[=Label] ..."); process.exit(2); }
const OUT = resolve(outArg);
for (const d of ["renders", "shots", "measure", "profiles"]) mkdirSync(join(OUT, d), { recursive: true });

const num = (re, s) => { const m = String(s ?? "").match(re); return m ? Number(m[1].replace(/,/g, "")) : null; };

// One app's steps, in the page's terms: Jev's decisions, the questions, what changed, the verdict.
function stepsOf(r, verdict) {
  return r.steps.map((st, si) => {
    const jev = st.log.filter((e) => (e.op === "route" && /^jev/.test(e.source ?? "")) || e.op === "place" || (e.op === "target" && /^jev/.test(e.source ?? "")))
      .map((e) => ({ kind: e.op === "place" ? "where" : e.op === "target" ? "which" : "route", route: e.route ?? null, said: e.said ?? "", text: e.note ?? "", detail: e.source ?? "" }));
    const split = st.log.find((e) => e.op === "split");
    const writes = st.log.filter((e) => e.op === "piece" || e.op === "move" || (e.op === "done" && /^built/.test(e.note ?? ""))).map((e) => e.note);
    const edits = st.log.filter((e) => e.target && !e.refused && !["route", "place", "choice", "human", "ask", "said", "split", "piece", "move"].includes(e.op)).map((e) => e.note);
    const answered = st.human.length > 0;
    const error = /^error:/.test(st.reply ?? "");
    let outcome;
    if (error) outcome = "error";
    else if (st.kind === "build") outcome = st.changed ? "built" : "not built";
    else if (st.asked.length && !answered) outcome = "asked you";
    else if (answered) outcome = st.changed ? "applied after your answer" : "no change";
    else outcome = st.changed ? "changed" : "no change";
    const v = verdict?.steps?.find((x) => x.step === si + 1) ?? null;
    return {
      sentence: st.sentence, kind: st.kind, marked: st.marked, jev, asked: st.asked, human: st.human, outcome,
      result: [...(split ? [`split into: ${split.note}`] : []), ...writes, ...edits].join(" · ") || st.reply, ms: st.ms,
      verdict: v ? { call: v.verdict, why: v.why } : null,
    };
  });
}

const runs = [];
const items = [];
for (const arg of runArgs) {
  const [dirArg, label] = arg.split("=");
  const dir = resolve(dirArg);
  const name = basename(dir);
  const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
  const verdicts = existsSync(join(dir, "verdicts.json")) ? JSON.parse(readFileSync(join(dir, "verdicts.json"), "utf8")) : {};
  runs.push({ group: name, label: label ?? name });
  for (const r of results) {
    const b = r.steps[0];
    const done = b.log.find((e) => e.op === "done")?.note ?? "";
    const v = verdicts[r.key];
    items.push({
      key: `${name}-${r.key}`, group: name, prompt: r.prompt, built: b.changed,
      renders: [
        { name: "build", label: "After the build", outline: join(dir, `${r.key}.build.outline`) },
        { name: "final", label: `After the ${r.steps.length - 1} follow-ups`, outline: join(dir, `${r.key}.final.outline`) },
      ],
      builder: "Claude Haiku 4.5",
      time: { ms: r.buildMs, first: num(/first at (\d+) ms/, done), lines: num(/from (\d+) lines/, done), tokens: num(/([\d,]+) tokens/, done) },
      jev: r.jevCalls, humans: r.humans, steps: stepsOf(r, v),
      judge: v ? { substance: v.substance, substanceWhy: v.substanceWhy, composedWell: v.composedWell ?? [], issues: v.issues ?? [] } : null,
      error: /billing_error|402/.test(b.reply ?? "") ? "Jev's API had no credits for this app — nothing ran" : null,
    });
  }
}

// ---- render, measure, screenshot ------------------------------------------------------------
const chrome = (argv, done, ms = 30000) => new Promise((ok) => {
  const p = spawn(CH, argv, { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (c) => { out += c; });
  const t0 = Date.now();
  const poll = setInterval(() => {
    if ((done && done(out)) || Date.now() - t0 > ms) { clearInterval(poll); setTimeout(() => { p.kill("SIGKILL"); ok(out); }, 400); }
  }, 200);
  p.on("exit", () => { clearInterval(poll); ok(out); });
});
const flags = (k) => ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--force-device-scale-factor=1", `--user-data-dir=${join(OUT, "profiles", k)}`];

async function shoot(it, rd) {
  const k = `${it.key}-${rd.name}`;
  const text = readFileSync(rd.outline, "utf8");
  const { root } = parse(text);
  Object.assign(rd, { file: k, outlineText: text, appName: root.text, frame: root.props.phone ? "phone" : root.props.panel ? "panel" : "web",
    screens: root.children.map((s) => s.text), nodes: index(root).length });
  delete rd.outline;
  const html = render(root);
  writeFileSync(join(OUT, "renders", `${k}.html`), html);
  const probe = `<script>addEventListener("load",()=>{const d=document.documentElement;document.title="M:"+d.scrollWidth+"x"+d.scrollHeight})</script>`;
  writeFileSync(join(OUT, "measure", `${k}.html`), html.replace("</body>", probe + "</body>"));
  const dom = await chrome([...flags(k + "-m"), "--window-size=1300,900", "--virtual-time-budget=2000", "--dump-dom", `file://${join(OUT, "measure", `${k}.html`)}`], (o) => /<title>M:\d+x\d+<\/title>/.test(o));
  const m = dom.match(/<title>M:(\d+)x(\d+)<\/title>/);
  const png = join(OUT, "shots", `${k}.png`);
  if (existsSync(png)) rmSync(png);
  await chrome([...flags(k + "-s"), `--window-size=${Math.max(1300, m ? +m[1] : 1300)},${Math.min(8000, m ? +m[2] : 2600)}`, `--screenshot=${png}`, `file://${join(OUT, "renders", `${k}.html`)}`],
    () => existsSync(png) && statSync(png).size > 0);
  rd.shot = existsSync(png);
}
const queue = items.flatMap((it) => it.renders.map((rd) => [it, rd]));
await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) { const [it, rd] = queue.shift(); await shoot(it, rd); } }));
for (const it of items) Object.assign(it, { appName: it.renders.at(-1).appName, frame: it.renders[0].frame, screens: it.renders[0].screens, nodes: it.renders[0].nodes });
rmSync(join(OUT, "profiles"), { recursive: true, force: true });
rmSync(join(OUT, "measure"), { recursive: true, force: true });

const page = readFileSync(join(HERE, "gallery.html"), "utf8").replace("__DATA__", JSON.stringify({ runs, items }).replace(/</g, "\\u003c"));
writeFileSync(join(OUT, "index.html"), page);
console.log(`wrote ${join(OUT, "index.html")} · ${runs.length} runs · ${items.length} apps · ${items.flatMap((i) => i.renders).filter((r) => r.shot).length} screenshots`);
