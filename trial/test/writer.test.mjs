// writer.test — the next steps a writer's answer ends with (trial/writer.mjs `nextSteps`).
//
//   node --test "trial/test/*.test.mjs"
//
// No model here: the answers are written by hand, as the writer returns them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSteps } from "../writer.mjs";

test("the next line comes off the outline, split at | and trimmed", () => {
  const r = nextSteps('row gap=2\n  text "Phone"\n  text "(503) 555-0142"\n// next: Add customer reviews | "Add a catering page" | Make the prices bigger. | Add customer reviews');
  assert.equal(r.text, 'row gap=2\n  text "Phone"\n  text "(503) 555-0142"');
  assert.deepEqual(r.next, ["Add customer reviews", "Add a catering page", "Make the prices bigger"]);
});

test("however the writer spells the line", () => {
  assert.deepEqual(nextSteps("text \"a\"\n  //Next:A|B").next, ["A", "B"]);
});

test("an answer with no next line is left as it is", () => {
  const text = 'button "Call us" primary';
  assert.deepEqual(nextSteps(text), { text, next: [] });
});

test("a refusal keeps its own words, less the next line", () => {
  const r = nextSteps("// I can't add a real map.\n// next: Add a photo of the shop");
  assert.equal(r.text, "// I can't add a real map.");
  assert.deepEqual(r.next, ["Add a photo of the shop"]);
});
