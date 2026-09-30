// engine.test — one project's canvas is its own (trial/engine.mjs).
//
//   node --test "trial/test/*.test.mjs"
//
// Two projects made from the same mock, side by side in one process: what one does — a toolbar edit,
// a rename, Undo, starting again — changes its mock, its undo, its log and its listeners, and nothing
// of the other's, nor the mock they both opened. No Jev and no writer: these are the edits that call
// no model, and a sentence with no keys set up.

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { find, serialize } from "../tree.mjs";
import { project } from "../engine.mjs";
import * as W from "../words.mjs";
import { bakery } from "./fixture-bakery.mjs";

const textOf = (p, id) => find(p.root, id)?.node.text;
const pair = () => [project({ root: bakery }), project({ root: bakery })];

group("two projects from one mock", () => {
  test("a rename in one leaves the other, and the mock they opened, as they were", () => {
    const before = serialize(bakery);
    const [a, b] = pair();
    const r = a.edit({ op: "rename", target: "hero", text: "Rye on Sundays" });
    assert.equal(r.changed, true);
    assert.equal(textOf(a, "hero"), "Rye on Sundays");
    assert.equal(textOf(b, "hero"), "Bread baked every morning at 5");
    assert.equal(serialize(bakery), before);
  });

  test("every one like it, in one project only", () => {
    const [a, b] = pair();
    a.edit({ op: "bold", target: "pr1", all: true });
    for (const id of ["pr1", "pr2", "pr3"]) {
      assert.equal(find(a.root, id).node.props.bold, true, `${id} in a`);
      assert.notEqual(find(b.root, id).node.props?.bold, true, `${id} in b`);
    }
  });

  test("Undo takes back its own project's change, and only there", () => {
    const [a, b] = pair();
    a.edit({ op: "rename", target: "tag", text: "Open daily" });
    b.edit({ op: "rename", target: "tag", text: "Closed Mondays" });
    assert.equal(a.undo().changed, true);
    assert.equal(textOf(a, "tag"), "Sourdough, pastries and coffee on Elm Street since 2009");
    assert.equal(textOf(b, "tag"), "Closed Mondays");
    assert.equal(a.state().canUndo, false);
    assert.equal(b.state().canUndo, true);
    assert.equal(a.undo().note, W.reply.nothingToUndo);
  });

  test("the Undo beside a reply is numbered per project: one's offer does not work on the other", () => {
    const [a, b] = pair();
    const r = a.edit({ op: "remove", target: "findus" });
    const on = r.offer.find((o) => o.post.path === "/undo").post.body.on;
    b.edit({ op: "remove", target: "seemenu" });
    // b has an Undo numbered the same; a's still takes back a's removal, not b's.
    assert.equal(a.undo({ on }).changed, true);
    assert.ok(find(a.root, "findus"));
    assert.equal(find(b.root, "seemenu"), null);
  });

  test("starting again empties one project; the other keeps its mock", () => {
    const [a, b] = pair();
    const r = a.startAgain();
    assert.equal(r.changed, true);
    assert.equal(a.state().screens, 0);
    assert.equal(b.state().screens, 3);
    assert.equal(b.state().title, "Crumb Bakery");
    // …and "Bring back" is a's.
    a.undo();
    assert.equal(a.state().screens, 3);
  });

  test("each project's log is its own", () => {
    const [a, b] = pair();
    a.edit({ op: "bigger", target: "tag" });
    assert.ok(a.state().log.some((e) => e.op === "bigger"));
    assert.equal(b.state().log.length, 0);
  });

  test("a listener hears its own project's changes, not the other's", () => {
    const [a, b] = pair();
    const heard = { a: [], b: [] };
    a.subscribe((v) => heard.a.push(v));
    const stop = b.subscribe((v) => heard.b.push(v));
    a.edit({ op: "bigger", target: "tag" });
    assert.ok(heard.a.length > 0);
    assert.equal(heard.b.length, 0);
    assert.deepEqual(heard.a.at(-1), a.version);
    stop();
    b.edit({ op: "bigger", target: "tag" });
    assert.equal(heard.b.length, 0, "stopped");
  });

  test("the toolbar reads its own project's mock", () => {
    const [a, b] = pair();
    a.edit({ op: "remove", target: "tag" });
    assert.equal(a.tools("tag").tools.length, 0);
    assert.ok(b.tools("tag").tools.length > 0);
  });

  test("a sentence with no keys says so, and changes neither", () => {
    const [a, b] = pair();
    return a.ask({ utterance: "make the title bigger" }).then((r) => {
      assert.equal(r.note, W.reply.notSetUp);
      assert.equal(r.blocked, true);
      assert.equal(serialize(a.root), serialize(bakery));
      assert.equal(b.state().log.length, 0);
    });
  });

  test("a project with no mock opens on an empty canvas", () => {
    const p = project();
    assert.equal(p.state().screens, 0);
    assert.deepEqual(p.state().next, W.starters);
    assert.equal(p.state().jev, false);
    assert.equal(p.state().llm, null);
  });
});

group("what the person talked over with their own AI", () => {
  test("the brief is the project's: kept when saved and opened again, added to, and only the newest kept when long", () => {
    const p = project({ root: bakery, brief: "Crumb, a bakery on Elm Street." });
    const q = project();
    p.inform("Rye on Sundays, $9.");
    p.inform("   ");
    assert.equal(p.brief, "Crumb, a bakery on Elm Street.\nRye on Sundays, $9.");
    assert.equal(q.brief, "");
    const again = project({ saved: p.save() });
    assert.equal(again.brief, p.brief);
    // A project saved before there was a brief opens with none.
    const old = p.save();
    delete old.brief;
    assert.equal(project({ saved: old }).brief, "");
    again.inform("x".repeat(7000));
    assert.equal(again.brief.length, 6000);
    assert.ok(again.brief.endsWith("xxx"));
  });
});
