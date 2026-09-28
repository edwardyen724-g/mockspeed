// app.test — the web app's rules, through its own handler, against the real store.
//
//   node --test web/test/*.test.mjs        (reads web/.env.local; skipped without it)
//
// Who may open and change which mock; what a browser with no account may do (its first mock) and
// what asks it to sign in (the next change, an export); that a mock is kept across requests and
// saved only over the state it was opened from; that signing in claims a browser's mocks; the
// admin page's door. No model is called: a mock here is the bakery fixture put straight into the
// store, and the changes made to it are the toolbar's. A signed-in person is a session cookie this
// test signs for a made-up account, and every project made here is deleted at the end.

import { describe as group, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "../app.mjs";
import { store } from "../store.mjs";
import * as A from "../auth.mjs";
import { project } from "../../trial/engine.mjs";
import { find } from "../../trial/tree.mjs";
import * as W from "../../trial/words.mjs";
import { bakery } from "../../trial/test/fixture-bakery.mjs";

const env = {};
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {}
const ready = Boolean(env.SUPABASE_URL && env.MS_SERVER_KEY && env.SESSION_SECRET);
const person = { id: randomUUID(), email: `test-${Date.now()}@example.invalid` };
const other = { id: randomUUID(), email: `other-${Date.now()}@example.invalid` };
// No model keys: nothing here may reach a model.
const handle = ready ? app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", ADMIN_EMAILS: person.email }) : null;
const db = ready ? store(env) : null;
const made = new Set();

const BASE = "http://localhost:8790";
const as = (who) => {
  const c = [];
  if (who?.anon) c.push(`ms_anon=${who.anon}`);
  if (who?.user) c.push(A.sessionCookie(who.user, env.SESSION_SECRET, false).split(";")[0]);
  return c.length ? { cookie: c.join("; ") } : {};
};
const get = (path, who) => handle(new Request(BASE + path, { headers: as(who) }));
const post = (path, body, who) => handle(new Request(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...as(who) }, body: JSON.stringify(body ?? {}) }));
// A streamed change: its frames, and its reply.
async function change(path, body, who) {
  const res = await post(path, body, who);
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) return { status: res.status, result: await res.json(), frames: [] };
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, frames: lines.filter((l) => l.frame).map((l) => l.frame), result: lines.find((l) => l.result)?.result };
}
// A browser with no account that has made the bakery (put straight into the store, built).
async function anonBakery() {
  const res = await post("/api/start", {});
  const anon = /ms_anon=([a-f0-9]{32})/.exec(res.headers.get("set-cookie"))[1];
  const { id } = await res.json();
  made.add(id);
  const row = await db.get(id);
  assert.equal(await db.save(id, row.rev, project({ root: bakery }).save(), "Crumb Bakery", 3), row.rev + 1);
  return { id, anon };
}

after(async () => {
  if (!ready) return;
  for (const id of made) {
    const row = await db.get(id);
    if (!row) continue;
    const owner = row.owner ?? person.id;
    if (!row.owner) await db.claim(owner, row.anon, null);
    await db.remove(id, owner);
  }
});

group("the web app", { skip: !ready && "no web/.env.local" }, () => {
  test("the landing page says what to do, with the first suggestion in the box", async () => {
    const html = await (await get("/")).text();
    assert.ok(html.includes(W.web.headline));
    assert.ok(html.includes(W.web.wordsOnly));
    assert.ok(!/\{\{\w+\}\}/.test(html), "every word filled in");
  });

  test("a new mock with no account: the browser gets its cookie and the mock is its own", async () => {
    const res = await post("/api/start", {});
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /ms_anon=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/);
    const { id, url } = await res.json();
    made.add(id);
    assert.equal(url, `/p/${id}/`);
    const anon = /ms_anon=([a-f0-9]{32})/.exec(cookie)[1];
    assert.equal((await get(url, { anon })).status, 200);
    const state = await (await get(`${url}state`, { anon })).json();
    assert.equal(state.screens, 0);
    assert.deepEqual(state.account, { signedIn: false, email: null });
    // Another browser, and a browser with no cookie, see nothing there.
    assert.equal((await get(url, { anon: "0".repeat(32) })).status, 404);
    assert.equal((await get(`${url}state`)).status, 404);
  });

  test("with no account, the change after the first mock asks to sign in, and so does an export", async () => {
    const { id, anon } = await anonBakery();
    const r = await change(`/p/${id}/edit`, { op: "bigger", target: "tag" }, { anon });
    assert.equal(r.status, 401);
    assert.deepEqual(r.result, { signin: true, note: W.web.keepGoing, changed: false });
    const ask = await change(`/p/${id}/ask`, { utterance: "make the prices bigger" }, { anon });
    assert.equal(ask.status, 401);
    for (const path of ["export.html", "export.md", "prompt"]) assert.equal((await get(`/p/${id}/${path}`, { anon })).status, 401, path);
    // …and nothing changed.
    const state = await (await get(`/p/${id}/state`, { anon })).json();
    assert.equal(state.log.length, 0);
  });

  test("signing in claims the browser's mocks: the change goes through and the mock is kept", async () => {
    const { id, anon } = await anonBakery();
    assert.equal(await db.claim(person.id, anon, person.email), 1);
    const who = { user: person, anon };
    const r = await change(`/p/${id}/edit`, { op: "rename", target: "hero", text: "Rye on Sundays" }, who);
    assert.equal(r.status, 200);
    assert.equal(r.result.changed, true);
    assert.equal(r.frames.length, 1, "one frame for one change");
    assert.ok(r.frames[0].html.includes("Rye on Sundays"));
    assert.equal(r.frames[0].state.account.email, person.email);
    // Opened again, in a new request: the same mock, with the change, and Undo.
    const state = await (await get(`/p/${id}/state`, who)).json();
    assert.equal(state.screens, 3);
    assert.equal(state.canUndo, true);
    const spec = await (await get(`/p/${id}/spec`, who)).text();
    assert.ok(spec.includes('"Rye on Sundays"'));
    // The browser without the account no longer opens it; the account does from anywhere.
    assert.equal((await get(`/p/${id}/`, { anon })).status, 404);
    assert.equal((await get(`/p/${id}/`, { user: person })).status, 200);
    assert.equal((await get(`/p/${id}/`, { user: other })).status, 404);
  });

  test("signed in, the export downloads, and is kept as a row", async () => {
    const { id, anon } = await anonBakery();
    await db.claim(person.id, anon, null);
    const res = await get(`/p/${id}/export.html`, { user: person });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename=".+\.html"/);
    assert.ok((await res.text()).includes("Bread baked every morning at 5"));
    const rows = await db.usage(new Date(Date.now() - 60000).toISOString());
    assert.ok(rows.some((r) => r.project === id && r.purpose === "export.html" && r.provider === "mockspeed"));
  });

  test("Undo in a later request takes back the change of an earlier one", async () => {
    const { id, anon } = await anonBakery();
    await db.claim(person.id, anon, null);
    const who = { user: person };
    await change(`/p/${id}/edit`, { op: "remove", target: "findus" }, who);
    let spec = await (await get(`/p/${id}/spec`, who)).text();
    assert.ok(!spec.includes("#findus"));
    const r = await change(`/p/${id}/undo`, {}, who);
    assert.equal(r.result.changed, true);
    spec = await (await get(`/p/${id}/spec`, who)).text();
    assert.ok(spec.includes("#findus"));
  });

  test("a save lands only over the state it was opened from", async () => {
    const { id, anon } = await anonBakery();
    const row = await db.get(id);
    const p = project({ saved: row.state });
    p.edit({ op: "bold", target: "tag" });
    assert.equal(await db.save(id, row.rev, p.save(), "Crumb Bakery", 3), row.rev + 1);
    // A second save from the same opened state finds it moved on.
    assert.equal(await db.save(id, row.rev, p.save(), "Crumb Bakery", 3), 0);
    const q = project({ saved: (await db.get(id)).state });
    assert.equal(find(q.root, "tag").node.props.bold, true);
    assert.ok(anon);
  });

  test("a sign-in link from one browser lets the account claim that browser's mocks elsewhere", async () => {
    const { id, anon } = await anonBakery();
    assert.equal(await db.expect(anon, other.email.toUpperCase()), 1);
    // Opened in another browser: no anon cookie there, only the address.
    assert.equal(await db.claim(other.id, null, other.email), 1);
    assert.equal((await db.get(id)).owner, other.id);
    await db.remove(id, other.id);
    made.delete(id);
  });

  test("a sign-in link needs an address", async () => {
    const res = await post("/api/auth/link", { email: "not an address" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).note, W.web.badEmail);
    const bad = await post("/api/auth/session", { access_token: "not-a-token" });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);
  });

  test("a session cookie that was tampered with is nobody's", async () => {
    const good = A.sessionCookie(person, env.SESSION_SECRET, false).split(";")[0];
    const forged = good.replace(/\.[^.]+$/, ".AAAA");
    const req = (c) => new Request(BASE + "/api/me", { headers: { cookie: c } });
    assert.equal((await (await handle(req(good))).json()).signedIn, true);
    assert.equal((await (await handle(req(forged))).json()).signedIn, false);
  });

  test("the projects page lists the account's mocks; the admin page opens only for an admin", async () => {
    const { id, anon } = await anonBakery();
    await db.claim(person.id, anon, null);
    const list = await (await get("/projects", { user: person })).text();
    assert.ok(list.includes(id));
    assert.equal((await get("/admin", { user: other })).status, 404);
    assert.equal((await get("/admin")).status, 404);
    const admin = await get("/admin", { user: person });
    assert.equal(admin.status, 200);
    assert.ok((await admin.text()).includes("Anthropic, as the console counts it"));
  });

  test("a sentence too long for one change is refused before any model", async () => {
    const { id, anon } = await anonBakery();
    await db.claim(person.id, anon, null);
    const r = await change(`/p/${id}/ask`, { utterance: "x".repeat(700) }, { user: person });
    assert.equal(r.result.note, W.web.tooLong);
  });
});
