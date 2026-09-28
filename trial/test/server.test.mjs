// server.test — the http shell routes each request to its own project (trial/server.mjs).
//
//   node --test "trial/test/*.test.mjs"
//
// The real server, started on a free port with the bakery opened and no keys: / is the project it
// opened (the one trial/eval drives, at the paths it always used), /p/new makes another, and what is
// done at one project's paths — an edit, Undo, save, export, its event stream — is that project's.

import { describe as group, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BAKERY } from "./fixture-bakery.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let dir, child, base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "trial-server-"));
  writeFileSync(join(dir, "bakery.outline"), BAKERY);
  // No keys: nothing here calls a model.
  const env = { ...process.env, TYPESAFE_API_KEY: "", ANTHROPIC_API_KEY: "", TYPESAFE_ENV_FILE: "" };
  child = spawn(process.execPath, [join(HERE, "../server.mjs"), join(dir, "bakery.outline"), "--port", "0", "--out", join(dir, "trial.outline")], { env, stdio: ["ignore", "ignore", "pipe"] });
  base = await new Promise((ok, no) => {
    let err = "";
    child.stderr.on("data", (c) => { err += c; const m = err.match(/http:\/\/localhost:(\d+)/); if (m) ok(`http://localhost:${m[1]}`); });
    child.on("exit", (code) => no(new Error(`server exited ${code}: ${err}`)));
  });
});
after(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }); });

const get = (path) => fetch(base + path, { redirect: "manual" });
const state = (path) => get(path + "state").then((r) => r.json());
const spec = (path) => get(path + "spec").then((r) => r.text());
const post = (path, body = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// A project's event stream, collected until stopped.
function listen(path) {
  const ctl = new AbortController();
  const got = [];
  const done = fetch(base + path + "events", { signal: ctl.signal }).then(async (r) => {
    const dec = new TextDecoder();
    for await (const c of r.body) for (const m of dec.decode(c).matchAll(/data: (.*)\n\n/g)) got.push(JSON.parse(m[1]));
  }).catch(() => {});
  return { got, stop: () => { ctl.abort(); return done; } };
}
const settle = () => new Promise((ok) => setTimeout(ok, 150));
// An empty canvas, as an outline: the app line and nothing under it.
const EMPTY = /^app( #\w+)? "new" web\n$/;

group("one server, a project per path", () => {
  test("/p/new makes a project and sends the page there; a path with no slash gets one", async () => {
    const r = await get("/p/new");
    assert.equal(r.status, 302);
    assert.match(r.headers.get("location"), /^\/p\/[0-9a-f]{8}\/$/);
    const again = await get("/p/new");
    assert.notEqual(again.headers.get("location"), r.headers.get("location"));
    const bare = await get("/p/abc?debug=1");
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), "/p/abc/?debug=1");
    assert.equal((await get("/p/not%20an%20id/state")).status, 404);
  });

  test("the page is the same page under a project's path", async () => {
    const [root, other] = await Promise.all([get("/").then((r) => r.text()), get("/p/abc/").then((r) => r.text())]);
    assert.equal(root, other);
    assert.ok(root.includes('src="mock"'), "the page asks with relative paths");
  });

  test("/ is the mock opened on the command line; a new project is an empty canvas", async () => {
    assert.equal((await state("/")).title, "Crumb Bakery");
    const s = await state("/p/fresh1/");
    assert.equal(s.screens, 0);
    assert.match(await spec("/p/fresh1/"), EMPTY);
  });

  test("an edit at / is /'s; the other project's mock, undo and events are untouched", async () => {
    const other = listen("/p/quiet1/");
    await settle();
    const heardAtStart = other.got.length;
    const r = await post("/edit", { op: "rename", target: "hero", text: "Rye on Sundays" });
    assert.equal(r.changed, true);
    assert.match(await spec("/"), /Rye on Sundays/);
    assert.match(await spec("/p/quiet1/"), EMPTY);
    assert.equal((await state("/p/quiet1/")).canUndo, false);
    await settle();
    assert.equal(other.got.length, heardAtStart, "no event on the other project");
    await other.stop();
    assert.equal((await post("/p/quiet1/undo")).changed, false);
    assert.equal((await post("/undo")).changed, true);
    assert.doesNotMatch(await spec("/"), /Rye on Sundays/);
  });

  test("a project's event stream hears its own changes", async () => {
    const mine = listen("/");
    await settle();
    const n = mine.got.length;
    await post("/edit", { op: "bigger", target: "tag" });
    await settle();
    assert.ok(mine.got.length > n);
    await mine.stop();
    await post("/undo");
  });

  test("starting again at one project leaves /", async () => {
    await post("/p/other2/new");
    assert.equal((await state("/")).screens, 3);
  });

  test("save writes each project to its own file", async () => {
    await post("/save");
    await post("/p/abc123/save");
    assert.match(readFileSync(join(dir, "trial.outline"), "utf8"), /Crumb Bakery/);
    assert.ok(existsSync(join(dir, "trial-abc123.outline")));
    assert.match(readFileSync(join(dir, "trial-abc123.outline"), "utf8"), EMPTY);
    assert.equal((await state("/p/abc123/")).out, join(dir, "trial-abc123.outline"));
  });

  test("export is the project's own mock", async () => {
    const mine = await get("/export.html");
    assert.match(mine.headers.get("content-disposition"), /crumb-bakery\.html/);
    assert.match(await mine.text(), /Bread baked every morning/);
    const prompt = await get("/p/abc123/prompt").then((r) => r.text());
    assert.doesNotMatch(prompt, /Crumb/);
  });
});
