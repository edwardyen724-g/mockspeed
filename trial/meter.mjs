// meter — what each model call used and cost, told to whoever is listening for the request it was
// made in.
//
//   await metered((use) => rows.push(use), () => p.ask({ utterance }));
//
// The writer (trial/writer.mjs) and Jev (trial/jev.mjs) call `meter()` once per request to their
// API, with the tokens the API reported. `metered()` runs a piece of work with a listener for
// every call made inside it — however deep, and only those: two requests running at once in one
// process each hear their own (AsyncLocalStorage). With nobody listening, a call is not recorded.
// The engine knows nothing of it; the web app listens around each request and keeps a row per call.

import { AsyncLocalStorage } from "node:async_hooks";

const listening = new AsyncLocalStorage();

export const metered = (listener, work) => listening.run(listener, work);

// One call: { provider, model, purpose, input, output, cacheRead, cacheWrite, ms, status, questions,
// cost? }. `input` is the input the API billed at the full rate — for Anthropic, not counting what
// was read from or written to the cache, which it reports apart. `cost` is set only when the
// provider says what it charged (OpenRouter); otherwise it is worked out from PRICES.
export function meter(use) {
  const listener = listening.getStore();
  if (!listener) return;
  try { listener({ ...use, cost: use.cost ?? costOf(use) }); } catch {}
}

// US dollars per million tokens, at list price. Cache writes are the 5-minute kind, at 1.25 times
// the input price; cache reads at 0.1 times. A model missing here costs null, not 0, so a gap in
// this table shows as a gap rather than as free.
export const PRICES = {
  "anthropic/claude-sonnet-5": { input: 2, output: 10 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
  "anthropic/claude-opus-5": { input: 5, output: 25 },
  "typesafe/jev-latest": { input: 0.042, output: 0 },
};

export function costOf({ provider, model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const p = PRICES[`${provider}/${model}`];
  if (!p) return null;
  const usd = (input * p.input + cacheWrite * p.input * 1.25 + cacheRead * p.input * 0.1 + output * p.output) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}
