#!/usr/bin/env node
// probe-meter — what one short session costs, call by call, as the meter records it
// (trial/meter.mjs): the bakery built from the empty canvas's first suggestion, then two changes.
//
//   node trial/eval/probe-meter.mjs --env <file> [--build-model <id>] [--model <id>] [--provider anthropic|openrouter]
//
// Prints one line per model call — who, what for, the tokens the API reported, how long, what it
// cost — then the totals, and how soon the build's first line came. With --provider openrouter the
// writer runs through OpenRouter (OPENROUTER_API_KEY) and each call's cost is OpenRouter's own.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { project } from "../engine.mjs";
import { metered } from "../meter.mjs";
import { MODEL, BUILD_MODEL } from "../writer.mjs";
import * as W from "../words.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const envFile = flag("--env", process.env.TYPESAFE_ENV_FILE);
const readKey = (name) => {
  if (process.env[name]) return process.env[name];
  const line = envFile && readFileSync(resolve(envFile), "utf8").split("\n").find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : null;
};
const provider = flag("--provider", "anthropic");
const p = project({
  apiKey: readKey("TYPESAFE_API_KEY"),
  llmKey: readKey(provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY"),
  model: flag("--model", MODEL), buildModel: flag("--build-model", BUILD_MODEL), provider,
});

const rows = [];
const say = async (utterance) => {
  const t = Date.now();
  const r = await metered((u) => rows.push({ ...u, said: utterance }), () => p.ask({ utterance }));
  console.log(`\n“${utterance}” → ${r.note}  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
};
await say(W.starters[0]);
await say("make the prices bigger");
await say("add a page for catering orders");

const pad = (v, n) => String(v).padEnd(n);
console.log("\n" + ["provider", "model", "purpose", "in", "out", "cache r/w", "ms", "status", "usd"].map((h, i) => pad(h, [10, 18, 9, 7, 6, 10, 7, 8, 0][i])).join(""));
for (const u of rows) {
  console.log([pad(u.provider, 10), pad(u.model, 18), pad(u.purpose, 9), pad(u.input, 7), pad(u.output, 6), pad(`${u.cacheRead}/${u.cacheWrite ?? 0}`, 10), pad(u.ms, 7), pad(u.status, 8), u.cost?.toFixed(6) ?? "?"].join(""));
}
const by = (f) => rows.filter(f).reduce((a, u) => ({ calls: a.calls + 1, input: a.input + (u.input ?? 0), output: a.output + (u.output ?? 0), cost: a.cost + (u.cost ?? 0) }), { calls: 0, input: 0, output: 0, cost: 0 });
const writer = by((u) => u.provider !== "typesafe"), jev = by((u) => u.provider === "typesafe");
console.log(`\nwriter: ${writer.calls} calls, ${writer.input} in, ${writer.output} out, $${writer.cost.toFixed(5)}`);
console.log(`jev:    ${jev.calls} calls, ${jev.input} in, $${jev.cost.toFixed(6)}`);
console.log(`total:  $${(writer.cost + jev.cost).toFixed(5)} for 3 sentences · the build's first line at ${rows.find((u) => u.purpose === "build")?.firstLineMs ?? "?"} ms`);
