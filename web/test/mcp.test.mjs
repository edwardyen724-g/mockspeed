// mcp.test — the person's own AI (web/mcp.mjs), the watch link and the live channel (web/live.mjs),
// through the web app's own handler, against the real store and Supabase Realtime.
//
//   node --test web/test/*.test.mjs        (reads web/.env.local; skipped without it)
//
// No model is called: the mocks here are the bakery fixture put straight into the store, and what
// changes them is the toolbar's or an undo, the only changes with no model behind them. That the
// AI's sentences are drawn — Jev deciding, the writer writing, frames arriving in a watching tab —
// is checked by hand through Claude Code (web/README.md). Every project made here is deleted.

import { describe as group, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { app } from "../app.mjs";
import { store } from "../store.mjs";
import * as A from "../auth.mjs";
import { projectTopic, accountTopic } from "../live.mjs";
import { project } from "../../trial/engine.mjs";
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
const person = { id: randomUUID(), email: `ai-${Date.now()}@example.invalid` };
const other = { id: randomUUID(), email: `ai-other-${Date.now()}@example.invalid` };
const handle = ready ? app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "" }) : null;
const db = ready ? store(env) : null;
const made = new Set();
const BASE = "http://localhost:8790";

const aiKey = (who) => A.key("ai", who, env.SESSION_SECRET);
const watchKey = (who) => A.key("watch", who, env.SESSION_SECRET);
// One JSON-RPC message to /mcp with the account's AI key: its answer, and the status.
let n = 0;
async function rpc(method, params, { who = person, key = aiKey(who) } = {}) {
  const res = await handle(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++n }), method, params }),
  }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const tool = async (name, args, opts) => {
  const r = await rpc("tools/call", { name, arguments: args }, opts);
  return { ...r.body.result, text: r.body.result?.content?.[0]?.text ?? "" };
};
const page = (path, cookie = "") => handle(new Request(BASE + path, { headers: cookie ? { cookie } : {} }));
// The bakery, put straight into the store as the account's.
async function bakeryOf(who) {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  await db.create({ id, owner: who.id, state: project({ root: bakery }).save() });
  made.add(id);
  const row = await db.get(id);
  await db.save(id, row.rev, project({ root: bakery }).save(), "Crumb Bakery", 3);
  return id;
}
// A tab listening on a channel, as trial/shell.html does: what it hears, once it has joined.
async function listen(topic) {
  const heard = [];
  const ws = new WebSocket(`${env.SUPABASE_URL.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(env.SUPABASE_PUBLISHABLE_KEY)}&vsn=1.0.0`);
  await new Promise((ok, fail) => {
    ws.onerror = () => fail(new Error("no websocket"));
    ws.onopen = () => ws.send(JSON.stringify({ topic: `realtime:${topic}`, event: "phx_join", payload: { config: { broadcast: { self: false }, presence: { key: "" }, private: false } }, ref: "1" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.event === "phx_reply" && m.ref === "1") ok();
      if (m.event === "broadcast") heard.push({ event: m.payload.event, ...m.payload.payload });
    };
  });
  const until = async (test, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = heard.find(test); if (h) return h; await new Promise((ok) => setTimeout(ok, 100)); }
    return null;
  };
  return { heard, until, close: () => ws.close() };
}

after(async () => {
  if (!ready) return;
  for (const id of made) {
    const row = await db.get(id);
    if (row) await db.remove(id, row.owner);
  }
});

group("the person's own AI", { skip: !ready && "no web/.env.local" }, () => {
  test("without its key, or with a watch key, the AI is told where to get one", async () => {
    const none = await rpc("initialize", {}, { key: null });
    assert.equal(none.status, 401);
    assert.match(none.body.error.message, /\/connect/);
    // …and its app where to sign in (web/oauth.mjs).
    assert.equal(none.headers.get("www-authenticate"), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mocks"`);
    assert.equal((await rpc("tools/list", {}, { key: watchKey(person) })).status, 401);
    const forged = aiKey(person).replace(/\.[^.]+$/, ".AAAA");
    assert.equal((await rpc("tools/list", {}, { key: forged })).status, 401);
  });

  test("it connects: its protocol version, what mockspeed is for, five tools and the panel's three", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "mockspeed");
    assert.match(init.body.result.instructions, /never write markup/);
    // Where the chat shows the panel, the AI neither opens the link nor works the mock in a browser.
    assert.match(init.body.result.instructions, /panel[^.]*: don't open the link/);
    assert.match(init.body.result.instructions, /Never work the mock through a browser/);
    assert.equal((await rpc("notifications/initialized", {})).status, 202);
    const list = await rpc("tools/list", {});
    assert.deepEqual(list.body.result.tools.map((t) => t.name), ["open_mock", "say", "take_offer", "undo", "look", "panel_open", "panel_change", "panel_tools"]);
    // Nothing in any tool takes the mock's own format: the AI says sentences and points at ids.
    for (const t of list.body.result.tools) assert.ok(!Object.keys(t.inputSchema.properties).some((k) => /outline|spec|markup|html/.test(k)), t.name);
    assert.equal((await rpc("no/such", {})).body.error.code, -32601);
  });

  test("open_mock starts the account's mock with the conversation, and a link that watches it", async () => {
    const brief = "Ferment, a sourdough club in the back room of Hollis Hardware, Providence. Starter Basics, Saturdays 10am, $40.";
    const r = await tool("open_mock", { brief });
    const id = /Opened mock ([a-z0-9]+)/.exec(r.text)[1];
    made.add(id);
    const row = await db.get(id);
    assert.equal(row.owner, person.id);
    assert.equal(project({ saved: row.state }).brief, brief);
    assert.ok(r.text.includes(`/w/${watchKey(person)}?p=${id}`));
    // Nothing drawn on it yet: the next open_mock uses the same one, with its own conversation.
    const again = await tool("open_mock", { brief: "Juniper Tea House" });
    assert.ok(again.text.includes(`Opened mock ${id}`));
    assert.equal(project({ saved: (await db.get(id)).state }).brief, "Juniper Tea House");
  });

  test("look and undo on the account's mock; another account's is not there", async () => {
    const id = await bakeryOf(person);
    const look = await tool("look", { mock: id });
    assert.ok(look.text.includes(`Mock "Crumb Bakery" — 3 pages`));
    assert.match(look.text, /\n  hero · Home · text #hero "Bread baked every morning at 5"/);
    // A change made in the person's tab (the toolbar), then taken back by the AI.
    const cookie = A.sessionCookie(person, env.SESSION_SECRET, false).split(";")[0];
    await handle(new Request(`${BASE}/p/${id}/edit`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ op: "remove", target: "findus" }) })).then((r) => r.text());
    assert.ok(!(await tool("look", { mock: id })).text.includes("findus ·"));
    const undo = await tool("undo", { mock: id });
    // The AI hears first what the person did in their tab, then its own reply.
    assert.match(undo.text, /^The person changed the mock themselves[^\n]*\n  said|^The person changed the mock themselves[^\n]*\n  → /);
    assert.ok(undo.text.includes(`\n${W.reply.undone}`));
    assert.ok((await tool("look", { mock: id })).text.includes("findus ·"));
    const theirs = await tool("look", { mock: id }, { who: other });
    assert.equal(theirs.isError, true);
    assert.match(theirs.text, /no mock with that id on this account/);
  });

  test("say: one change in words, refused before any model when too long; offers are taken by number", async () => {
    const id = await bakeryOf(person);
    const long = await tool("say", { mock: id, sentence: "x".repeat(700) });
    assert.equal(long.isError, true);
    assert.ok(long.text.startsWith(W.web.tooLong));
    const none = await tool("take_offer", { mock: id, offer: 3 });
    assert.match(none.text, /no offer 3/);
    // With no model keys the engine says so, and nothing changes.
    const r = await tool("say", { mock: id, sentence: "make the prices bigger" });
    assert.ok(r.text.startsWith(W.reply.notSetUp));
    // The panel under the call shows the reply once it is done, not the AI's sentence.
    assert.equal(r._meta.mockspeed.reply.note, W.reply.notSetUp);
  });

  test("the watch link: this browser may look at the account's mocks and follow the AI, not change them", async () => {
    const id = await bakeryOf(person);
    const res = await page(`/w/${watchKey(person)}?p=${id}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/p/${id}/?follow=1`);
    const cookie = /ms_watch=[^;]+/.exec(res.headers.get("set-cookie"))[0];
    const html = await (await page(`/p/${id}/`, cookie)).text();
    assert.ok(html.includes(projectTopic(env.SESSION_SECRET, id)), "the page is told its channel");
    assert.ok(html.includes(accountTopic(env.SESSION_SECRET, person.id)));
    assert.equal((await page(`/p/${id}/state`, cookie)).status, 200);
    const edit = await handle(new Request(`${BASE}/p/${id}/edit`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ op: "bold", target: "tag" }) }));
    assert.equal(edit.status, 401);
    assert.equal((await page(`/p/${id}/export.html`, cookie)).status, 401);
    // Another account's mock stays hidden from it, and a made-up link opens nothing.
    const theirs = await bakeryOf(other);
    assert.equal((await page(`/p/${theirs}/`, cookie)).status, 404);
    assert.equal((await page(`/w/${watchKey(person).replace(/\.[^.]+$/, ".AAAA")}`)).status, 404);
  });

  test("a change goes out live to a watching tab, whoever makes it, and open_mock tells the account's tabs", async () => {
    const id = await bakeryOf(person);
    const tab = await listen(projectTopic(env.SESSION_SECRET, id));
    const acct = await listen(accountTopic(env.SESSION_SECRET, person.id));
    try {
      const cookie = A.sessionCookie(person, env.SESSION_SECRET, false).split(";")[0];
      const res = await handle(new Request(`${BASE}/p/${id}/edit`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ op: "rename", target: "hero", text: "Rye on Sundays" }) }));
      const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const sentence = lines[0].sentence;
      assert.ok(sentence, "the tab that asked is told its sentence first");
      const last = await tab.until((h) => h.done);
      assert.ok(last, "the last frame arrived");
      assert.equal(last.state.sentence, sentence);
      assert.ok(last.html.includes("Rye on Sundays"));
      assert.equal(last.reply.changed, true);
      // Undo by the AI: the same channel, another sentence.
      await tool("undo", { mock: id });
      const back = await tab.until((h) => h.done && h.state.sentence !== sentence);
      assert.ok(back && !back.html.includes("Rye on Sundays"));
      // A new mock opened by the AI: tabs following it are told where to go.
      const r = await tool("open_mock", { brief: "a test" });
      const opened = /Opened mock ([a-z0-9]+)/.exec(r.text)[1];
      made.add(opened);
      assert.equal((await acct.until((h) => h.event === "open"))?.id, opened);
    } finally {
      tab.close();
      acct.close();
    }
  });

  test("a host that shows panels gets the panel: its page, its tools hidden from the AI, and say and look drawn in it", async () => {
    const tools = (await rpc("tools/list", {})).body.result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.equal(byName.say._meta.ui.resourceUri, "ui://mockspeed/mock");
    assert.equal(byName.look._meta.ui.resourceUri, "ui://mockspeed/mock");
    assert.equal(byName.say._meta["openai/outputTemplate"], "ui://mockspeed/mock");
    // The panel's own tools: hidden from the AI where panels are shown, and saying so where not.
    for (const n of ["panel_open", "panel_change", "panel_tools"]) {
      assert.deepEqual(byName[n]._meta.ui.visibility, ["app"], n);
      assert.match(byName[n].description, /^Only the mockspeed panel calls this; not for you/);
    }
    // The page: an MCP App, allowed to reach Realtime and nothing else.
    const read = (await rpc("resources/read", { uri: "ui://mockspeed/mock" })).body.result.contents[0];
    assert.equal(read.mimeType, "text/html;profile=mcp-app");
    assert.ok(read.text.includes("ui/initialize") && read.text.includes("panel_change"));
    assert.ok(!/\{\{\w+\}\}/.test(read.text), "every word filled in");
    assert.deepEqual(read._meta.ui.csp.connectDomains, [env.SUPABASE_URL, env.SUPABASE_URL.replace(/^http/, "ws")]);
    const id = await bakeryOf(person);
    const look = await tool("look", { mock: id });
    const d = look._meta.mockspeed;
    assert.equal(d.id, id);
    assert.ok(d.html.includes("Bread baked every morning at 5"));
    assert.equal(d.live.project, projectTopic(env.SESSION_SECRET, id));
    assert.ok(d.at > 0);
  });

  test("a change in the panel goes straight to the engine, out live, and into the AI's next reply", async () => {
    const id = await bakeryOf(person);
    const tab = await listen(projectTopic(env.SESSION_SECRET, id));
    try {
      const open = await tool("panel_open", { mock: id });
      assert.equal(open.structuredContent.mockspeed.id, id);
      const bar = (await tool("panel_tools", { mock: id, id: "hero" })).structuredContent.tools;
      assert.ok(bar.tools.some((t) => t.op === "remove") && bar.text === "Bread baked every morning at 5");
      const r = await tool("panel_change", { mock: id, route: "/edit", body: { op: "rename", target: "hero", text: "Rye on Sundays" } });
      const d = r.structuredContent.mockspeed;
      assert.equal(d.reply.changed, true);
      assert.ok(d.html.includes("Rye on Sundays"));
      assert.ok((await tab.until((h) => h.done && h.html?.includes("Rye on Sundays"))), "a watching tab saw it");
      // Nothing but the editor's own changes.
      assert.equal((await tool("panel_change", { mock: id, route: "/new" })).isError, true);
      // The AI's next call opens with what the person did; after its own change, that is not said again.
      const look = await tool("look", { mock: id });
      assert.match(look.text, /^The person changed the mock themselves since your last change/);
      assert.ok(look.text.includes("Rye on Sundays"));
      const undo = await tool("undo", { mock: id });
      assert.match(undo.text, /^The person changed the mock themselves/);
      const again = await tool("look", { mock: id });
      assert.ok(!again.text.includes("The person changed"), again.text.slice(0, 200));
      assert.ok(!again.text.includes("Rye on Sundays"));
    } finally {
      tab.close();
    }
  });

  test("the key in the address works as the header does, for connectors that take only a link", async () => {
    const res = await handle(new Request(`${BASE}/mcp/${aiKey(person)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));
    assert.equal(res.status, 200);
    assert.ok((await res.json()).result.tools.length >= 5);
    const forged = await handle(new Request(`${BASE}/mcp/${aiKey(person).replace(/\.[^.]+$/, ".AAAA")}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    assert.equal(forged.status, 401);
  });

  test("/connect shows everyone the link to add, and the signed-in person their AI key and watch link", async () => {
    const cookie = A.sessionCookie(person, env.SESSION_SECRET, false).split(";")[0];
    const html = await (await page("/connect", cookie)).text();
    assert.ok(html.includes(`claude mcp add --transport http mockspeed ${BASE}/mcp --header &quot;Authorization: Bearer ${aiKey(person)}&quot;`));
    assert.ok(html.includes(`${BASE}/w/${watchKey(person)}`));
    assert.ok(html.includes(`${BASE}/mcp/${aiKey(person)}`), "the connector link for Claude and ChatGPT");
    assert.ok(!/\{\{\w+\}\}/.test(html), "every word filled in");
    const out = await (await page("/connect")).text();
    assert.ok(!out.includes("msai_"));
    assert.ok(out.includes(W.web.connectSignInKeys));
    // Adding it by its link alone, which signs in from the AI's app, is shown to everyone.
    for (const h of [html, out]) assert.ok(h.includes(`<code id="link">${BASE}/mcp</code>`));
  });
});
