#!/usr/bin/env node
// probe-export — does the prompt for an AI site builder build the site? Pasted once into an AI
// builder, the prompt should yield a site with semantic tags.
//
//   node trial/eval/probe-export.mjs --env <env file> --outline <mock.outline> [--model claude-sonnet-5] [--out <dir>]
//
// The export's prompt (trial/export.mjs builderPrompt) is sent once, as the person would paste it,
// to a model standing in for a builder such as Lovable or v0. The one line of system prompt is the
// builder's, not ours: answer with a single HTML file. What comes back is saved and checked for
// what the prompt's header asks for — header, nav, main, one h1 per page, forms with labels,
// input types that fit, buttons, links, images with alt text — and for the mock's words, which
// the prompt asks to keep as written.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse, index } from "../tree.mjs";
import { builderPrompt } from "../export.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const envFile = flag("--env", null);
const outline = flag("--outline", null);
const MODEL = flag("--model", "claude-sonnet-5");
const OUT = resolve(flag("--out", "."));
const readKey = (name) => {
  if (process.env[name]) return process.env[name];
  if (!envFile) return null;
  const line = readFileSync(resolve(envFile), "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : null;
};
const apiKey = readKey("ANTHROPIC_API_KEY");
if (!apiKey) { console.error("no ANTHROPIC_API_KEY — pass --env"); process.exit(2); }
if (!outline) { console.error("pass --outline <file>"); process.exit(2); }

const root = parse(readFileSync(resolve(outline), "utf8")).root;
const prompt = builderPrompt(root);
const BUILDER = "You build websites. Answer with one complete, self-contained HTML file (inline CSS, and inline JS only if it is needed) and nothing else.";

// One streamed request (long output); thinking left at the model's default.
async function build() {
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 64000, stream: true, system: BUILDER, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`${MODEL} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let text = "", buffer = "", usage = {}, stop = null;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = event.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const e = JSON.parse(data.slice(6));
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") text += e.delta.text;
      else if (e.type === "message_start") usage = { ...e.message?.usage };
      else if (e.type === "message_delta") { usage = { ...usage, ...e.usage }; stop = e.delta?.stop_reason ?? stop; }
      else if (e.type === "error") throw new Error(`${MODEL} stream: ${e.error?.message ?? "error"}`);
    }
  }
  return { text, usage, stop, ms: Date.now() - started };
}

// The mock's words, as the prompt quotes them.
function wordsOn(root) {
  const out = [];
  const has = (s) => s != null && s !== true && s !== false && String(s).trim() !== "";
  for (const { node: n } of index(root)) {
    if (n.type === "app" || n.type === "screen") continue;
    if (n.type === "tr") { out.push(...String(n.text ?? "").split("|").map((c) => c.trim()).filter(Boolean)); continue; }
    if (has(n.text)) out.push(String(n.text).trim());
    if (has(n.props?.value)) out.push(String(n.props.value).trim());
    if (has(n.props?.sub)) out.push(String(n.props.sub).trim());
  }
  return [...new Set(out)];
}

const count = (html, re) => (html.match(re) ?? []).length;
function check(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&[lr]dquo;|&quot;/g, '"').replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/\s+/g, " ");
  const inputs = [...html.matchAll(/<(input|textarea|select)\b[^>]*>/gi)].map((m) => m[0]).filter((t) => !/type=["']?(hidden|submit|button)/i.test(t));
  const ids = new Set([...html.matchAll(/<label\b[^>]*\bfor=["']([^"']+)/gi)].map((m) => m[1]));
  const labelled = inputs.filter((t) => { const id = t.match(/\bid=["']([^"']+)/i)?.[1]; return (id && ids.has(id)) || /aria-label=/i.test(t); }).length;
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const words = wordsOn(root);
  const missing = words.filter((w) => !text.includes(w.replace(/\s+/g, " ")));
  return {
    header: count(html, /<header\b/gi), nav: count(html, /<nav\b/gi), main: count(html, /<main\b/gi), footer: count(html, /<footer\b/gi),
    section: count(html, /<section\b/gi), h1: count(html, /<h1\b/gi), button: count(html, /<button\b/gi), a: count(html, /<a\b[^>]*href=/gi),
    form: count(html, /<form\b/gi), label: count(html, /<label\b/gi), inputs: inputs.length, labelled,
    inputTypes: [...new Set(inputs.map((t) => t.match(/type=["']?([a-z]+)/i)?.[1] ?? (t.startsWith("<textarea") ? "textarea" : t.startsWith("<select") ? "select" : "text")))],
    img: imgs.length, imgAlt: imgs.filter((t) => /\balt=/i.test(t)).length,
    divs: count(html, /<div\b/gi),
    words: `${words.length - missing.length}/${words.length}`, missing,
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "prompt.md"), prompt);
const r = await build();
const html = r.text.replace(/^[\s\S]*?```(?:html)?\s*\n/, "").replace(/\n```[\s\S]*$/, "").trim();
writeFileSync(join(OUT, "built.html"), html);
const result = { model: MODEL, ms: r.ms, stop: r.stop, usage: r.usage, promptChars: prompt.length, htmlChars: html.length, checks: check(html) };
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
