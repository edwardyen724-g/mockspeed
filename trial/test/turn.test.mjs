// turn.test — act, then offer (trial/turn.mjs, docs/plan-web-2026-09-26.md §3A, phase 1b).
//
//   node --test "trial/test/*.test.mjs"
//
// What a sentence did, and what it was unsure of, kept so that a swap can go back and do the
// runner-up instead: which alternatives are offered, what a swap restores, and that the changes of
// a split sentence's later parts are made again on the swapped canvas. No Jev here: the doubts are
// written in by hand, as the server records them after Jev answers.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { parse, find, serialize } from "../tree.mjs";
import { Turn, replay, redo, relocate, applyEverywhere } from "../turn.mjs";

const BAKERY = parse(`app "Crumb" web
  screen "Home"
    row #bar h=64 pad=3 fill=light justify=between
      text "Crumb" size=l bold
      button #order "Order now" primary
    col #main grow pad=4 gap=3
      text #hero "Fresh bread daily" size=xl bold
      text #tag "Baked every morning"
      col #visit pad=3 gap=2
        text #addr "Address"
        text #street "427 Maple Street"
        text #hours "Hours"`).root;

const alt = (label) => ({ label, body: { kind: "place", label } });
const texts = (root, id) => find(root, id).node.children.map((c) => c.text);

group("offers — the alternatives to what Jev was least sure of", () => {
  test("one part: the least sure decision's alternatives, all of them", () => {
    const t = new Turn(BAKERY, 0);
    t.doubt(0.55, [alt("On the “Visit us” page instead")], { utterance: "add our phone" });
    t.doubt(0.31, [alt("Under “Hours” instead"), alt("Above “Address” instead")], { utterance: "add our phone" });
    t.doubt(0.48, [alt("As a new page instead")], { utterance: "add our phone" });
    assert.deepEqual(t.offers().map((o) => [o.label, o.part, o.doubt, o.alt]), [
      ["Under “Hours” instead", 0, 1, 0],
      ["Above “Address” instead", 0, 1, 1],
    ]);
  });
  test("a split sentence: one decision per part that has one; a sure part offers nothing", () => {
    const t = new Turn(BAKERY, 0);
    t.open(BAKERY, 0);
    t.doubt(0.4, [alt("Under “Hours” instead")], {});
    t.open(BAKERY, 1);
    t.open(BAKERY, 2);
    t.doubt(0.2, [alt("The “Hours” text instead")], {});
    assert.deepEqual(t.offers().map((o) => [o.label, o.part]), [["Under “Hours” instead", 1], ["The “Hours” text instead", 3]]);
  });
  test("a doubt with nothing to offer is not kept", () => {
    const t = new Turn(BAKERY, 0);
    t.doubt(0.1, [], {});
    assert.deepEqual(t.offers(), []);
  });
});

group("rewind — what a swap goes back to", () => {
  test("a swap not on offer is null", () => {
    const t = new Turn(BAKERY, 0);
    t.doubt(0.3, [alt("x")], {});
    assert.equal(t.rewind(0, 0, 1), null);
    assert.equal(t.rewind(0, 1, 0), null);
    assert.equal(t.rewind(2, 0, 0), null);
  });
  test("the part's canvas, its piece and its sentence; the parts after it are made again", () => {
    const t = new Turn(BAKERY, 3);
    const ctx = { utterance: "add our phone number" };
    t.open(BAKERY, 3);
    t.doubt(0.3, [alt("Under “Hours” instead")], ctx);
    t.current.piece = { text: 'text "555-0101"', whole: false };
    t.step(redo.place("street", "after", 'text "555-0101"'), { note: "added" });
    const after1 = redo.place("street", "after", 'text "555-0101"')(BAKERY).root;
    t.open(after1, 4);
    t.step(redo.edit("bigger", "tag"), { note: "bigger" });
    const back = t.rewind(1, 0, 0);
    assert.equal(back.snap.root, BAKERY);
    assert.equal(back.snap.depth, 3);
    assert.equal(back.ctx, ctx);
    assert.equal(back.alt.label, "Under “Hours” instead");
    assert.deepEqual(back.piece, { text: 'text "555-0101"', whole: false });
    assert.deepEqual(back.later.map((s) => s.entry.note), ["bigger"]);
    // The turn keeps the sentence's own record, and the swapped part starts over empty.
    assert.equal(t.parts.length, 2);
    assert.equal(t.at, 1);
    assert.deepEqual([t.parts[1].steps.length, t.parts[1].doubts.length, t.parts[1].piece], [0, 0, null]);
    assert.equal(t.parts[1].snap.root, BAKERY);
  });
  test("a doubt about the whole sentence replaces its parts rather than making them again", () => {
    const t = new Turn(BAKERY, 0);
    t.doubt(0.45, [{ label: "Add it as something new instead", body: { kind: "job", job: "add" } }], {});
    t.open(BAKERY, 0);
    t.step(redo.edit("bigger", "tag"), { note: "bigger" });
    const back = t.rewind(0, 0, 0);
    assert.deepEqual(back.later, []);
    assert.equal(t.parts.length, 1);
  });
});

group("replay — a split sentence's later changes, made again after a swap", () => {
  test("the phone number goes under “Hours” instead, and the tagline is still made bigger", () => {
    // What the sentence did: part 1 put the phone number after the street, part 2 made the tagline bigger.
    const t = new Turn(BAKERY, 0);
    t.open(BAKERY, 0);
    t.doubt(0.3, [{ label: "Under “Hours” instead", body: { kind: "place", anchor: "hours", position: "after" } }], {});
    const place1 = redo.place("street", "after", 'text #phone "555-0101"');
    const r1 = place1(BAKERY).root;
    t.step(place1, { note: "added" });
    t.open(r1, 1);
    const bigger = redo.edit("bigger", "tag");
    const r2 = bigger(r1).root;
    t.step(bigger, { note: "bigger" });
    assert.deepEqual(texts(r2, "visit"), ["Address", "427 Maple Street", "555-0101", "Hours"]);

    // The swap: back to part 1's canvas, the piece put where the swap says, part 2 made again.
    const back = t.rewind(1, 0, 0);
    const swapped = redo.place(back.alt.body.anchor, back.alt.body.position, 'text #phone "555-0101"')(back.snap.root).root;
    const again = replay(swapped, back.later);
    assert.equal(again.length, 1);
    const end = again[0].root;
    assert.deepEqual(texts(end, "visit"), ["Address", "427 Maple Street", "Hours", "555-0101"]);
    assert.equal(find(end, "tag").node.props.size, "l");
    assert.equal(find(BAKERY, "tag").node.props?.size, undefined, "the canvas before is untouched");
  });
  test("a change whose element is gone is reported, and the rest still land", () => {
    const steps = [redo.edit("bold", "street"), redo.edit("bigger", "hours"), redo.move("hours", { anchor: "visit", position: "inside_start" })]
      .map((f, i) => ({ redo: f, entry: { note: `step ${i}` } }));
    const without = parse(serialize(BAKERY).replace(/\n\s*text #street[^\n]*/, "")).root;
    const out = replay(without, steps);
    assert.deepEqual(out.map((o) => o.root != null), [false, true, true]);
    const end = out[2].root;
    assert.deepEqual(texts(end, "visit"), ["Hours", "Address"]);
    assert.equal(find(end, "hours").node.props.size, "l");
  });
});

group("the changes, as functions of the canvas", () => {
  test("a move keeps the element's id, and says null when the place is gone", () => {
    const moved = relocate(BAKERY, "order", { anchor: "main", position: "inside_start" });
    assert.equal(find(moved, "order").parent.id, "main");
    assert.equal(find(moved, "main").node.children[0].id, "order");
    assert.equal(relocate(BAKERY, "order", { anchor: "nope", position: "after" }), null);
    assert.equal(relocate(BAKERY, "nope", { anchor: "main", position: "inside_start" }), null);
  });
  test("an edit to a shared element is made to every copy", () => {
    const app = parse(`app "Runs" web
  screen "Runs"
    row fill=white
      col #nav1 share=nav w=200 fill=light pad=3
        text #home1 "Home"
      col pad=3
        text "Runs"
  screen "Settings"
    row fill=white
      col #nav2 share=nav w=200 fill=light pad=3
        text #home2 "Home"
      col pad=3
        text "Settings"`).root;
    const r = applyEverywhere(app, "bigger", "home1");
    assert.equal(r.copies, 1);
    assert.equal(find(r.root, "home1").node.props.size, "l");
    assert.equal(find(r.root, "home2").node.props.size, "l");
    // The same edit made again (a replay) reaches both copies too.
    const again = redo.edit("bigger", "home1")(app);
    assert.equal(find(again.root, "home2").node.props.size, "l");
  });
  test("clearing, made again, empties whatever canvas it is made on", () => {
    const r = redo.clear()(BAKERY);
    assert.equal(r.changed, true);
    assert.deepEqual(r.root.children, []);
  });
});
