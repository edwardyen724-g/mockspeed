// save.test — a project saved and opened again carries on as if it had never stopped
// (trial/engine.mjs save, `saved`; tree.mjs pack/unpack; turn.mjs redoOf).
//
//   node --test "trial/test/*.test.mjs"
//
// The web app opens a project, acts on it and saves it again on every request, each in whichever
// process serves it. So what a person sees and can do next — the mock, Undo, the Undo beside a
// reply, "Bring back", the log, the next steps — has to be the same after a save and an open as
// before. No Jev and no writer: the edits here call no model.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { find, serialize, pack, unpack, apply } from "../tree.mjs";
import { project } from "../engine.mjs";
import { redo, redoOf } from "../turn.mjs";
import * as W from "../words.mjs";
import { bakery } from "./fixture-bakery.mjs";

// Through JSON, as a store keeps it.
const reopen = (p) => project({ saved: JSON.parse(JSON.stringify(p.save())) });
const textOf = (p, id) => find(p.root, id)?.node.text;

group("pack and unpack", () => {
  test("every tree comes back exactly, ids, props and the root's next number too", () => {
    const a = bakery;
    const b = apply(a, "bold", "tag").root;
    const c = apply(b, "rename", "hero", "Rye on Sundays").root;
    const back = unpack(JSON.parse(JSON.stringify(pack([a, b, c]))));
    assert.deepEqual(back, [a, b, c]);
    assert.equal(back[2].next, c.next);
    assert.equal(serialize(back[1]), serialize(b));
  });

  test("what is the same in several trees is written once", () => {
    const trees = [bakery];
    for (const id of ["tag", "hero", "menuh", "tag"]) trees.push(apply(trees.at(-1), "bigger", id).root);
    const { nodes } = pack(trees);
    const one = pack([bakery]).nodes.length;
    // Five mocks that differ in one node each: a little more than one mock's nodes, not five.
    assert.ok(nodes.length < one * 1.5, `${nodes.length} nodes for 5 mocks of ${one}`);
  });

  test("the trees handed back are new objects; the ones packed are not touched", () => {
    const before = serialize(bakery);
    const [back] = unpack(pack([bakery]));
    assert.notEqual(back, bakery);
    back.children[0].text = "changed";
    assert.equal(serialize(bakery), before);
  });
});

group("a change made again, from its spec", () => {
  test("each kind of change comes back as the same change", () => {
    const cases = [
      redo.edit("bigger", "tag"),
      redo.edits("bold", ["pr1", "pr2", "pr3"]),
      redo.place("tag", "after", 'text "Open 7 days"'),
      redo.move("findus", { anchor: "hero", position: "before" }),
      redo.clear(),
    ];
    for (const r of cases) {
      const again = redoOf(JSON.parse(JSON.stringify(r.spec)));
      assert.equal(serialize(again(bakery).root), serialize(r(bakery).root), r.spec[0]);
    }
  });
});

group("a project saved and opened again", () => {
  test("shows the same mock, state and log", () => {
    const p = project({ root: bakery });
    p.edit({ op: "rename", target: "hero", text: "Rye on Sundays" });
    p.edit({ op: "bold", target: "pr1", all: true });
    const q = reopen(p);
    assert.equal(serialize(q.root), serialize(p.root));
    assert.deepEqual(q.state(), p.state());
    assert.deepEqual(q.version, p.version);
    // …and saving it again writes the same thing.
    assert.deepEqual(q.save(), p.save());
  });

  test("Undo takes back the same change, one step at a time, as far back as it went", () => {
    const p = project({ root: bakery });
    p.edit({ op: "rename", target: "tag", text: "Open daily" });
    p.edit({ op: "bigger", target: "tag" });
    let q = reopen(p);
    assert.equal(q.undo().changed, true);
    q = reopen(q);
    assert.equal(textOf(q, "tag"), "Open daily");
    assert.equal(q.undo().changed, true);
    q = reopen(q);
    assert.equal(serialize(q.root), serialize(bakery));
    assert.equal(q.state().canUndo, false);
    assert.equal(q.undo().note, W.reply.nothingToUndo);
  });

  test("the Undo beside a reply still works after the project is opened again", () => {
    const p = project({ root: bakery });
    const r = p.edit({ op: "remove", target: "findus" });
    const undo = r.offer.find((o) => o.post.path === "/undo");
    const q = reopen(p);
    assert.deepEqual(q.state().offer, p.state().offer);
    assert.equal(q.undo(undo.post.body).changed, true);
    assert.ok(find(q.root, "findus"));
  });

  test("…and one from before the last change says it is gone, as it did before the save", () => {
    const p = project({ root: bakery });
    const r = p.edit({ op: "remove", target: "findus" });
    p.edit({ op: "bigger", target: "tag" });
    const q = reopen(p);
    const stale = q.undo(r.offer.find((o) => o.post.path === "/undo").post.body);
    assert.equal(stale.note, W.reply.offerGone);
    assert.equal(find(q.root, "findus"), null);
  });

  test("“Bring back” after starting again brings the mock back", () => {
    const p = project({ root: bakery });
    const r = p.startAgain();
    const q = reopen(p);
    assert.equal(q.state().screens, 0);
    assert.equal(q.undo(r.offer[0].post.body).changed, true);
    assert.equal(serialize(q.root), serialize(bakery));
  });

  test("an empty canvas saves and opens as one, with the starters offered", () => {
    const q = reopen(project());
    assert.equal(q.state().screens, 0);
    assert.deepEqual(q.state().next, W.starters);
  });

  test("undo is kept to the last 40 steps", () => {
    const p = project({ root: bakery });
    for (let i = 0; i < 50; i++) p.edit({ op: "rename", target: "tag", text: `Open ${i}` });
    const q = reopen(p);
    for (let i = 0; i < 40; i++) assert.equal(q.undo().changed, true, `undo ${i + 1}`);
    assert.equal(textOf(q, "tag"), "Open 9");
    assert.equal(q.undo().note, W.reply.nothingToUndo);
  });

  test("a mock with forty steps of undo saves small: what the steps share is written once", () => {
    const p = project({ root: bakery });
    for (let i = 0; i < 40; i++) p.edit({ op: i % 2 ? "smaller" : "bigger", target: i % 3 ? "tag" : "menuh" });
    assert.equal(p.state().canUndo, true);
    const size = JSON.stringify(p.save()).length;
    const one = JSON.stringify(pack([bakery])).length;
    assert.ok(size < one * 8, `${size} bytes saved; one mock is ${one}`);
  });

  test("a project opened again is its own: changing it leaves the one it was saved from", () => {
    const p = project({ root: bakery });
    const q = reopen(p);
    q.edit({ op: "rename", target: "hero", text: "Closed today" });
    assert.equal(textOf(p, "hero"), "Bread baked every morning at 5");
  });

  test("a project saved in another shape is not opened as this one", () => {
    const saved = project().save();
    assert.throws(() => project({ saved: { ...saved, v: 99 } }), /version 99/);
  });
});
