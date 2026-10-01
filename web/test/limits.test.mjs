// limits.test — a day's changes, paying for more, and the kill switch, through the web app's own
// handler, against the real store and a stand-in for Stripe's API on a local port.
//
//   node --test web/test/*.test.mjs        (reads web/.env.local; skipped without it)
//
// No model is called. An account's changes for the day are put straight into the store as the rows
// a change leaves, so the limit is reached without saying anything; every sentence here is then
// refused before the engine sees it. That a sentence said in the editor, the panel or by the AI is
// counted as one is checked through the running app with its models (web/README.md). The
// allowance is 2 a day here, so a test account leaves few rows behind. Every project made here is
// deleted.

import { describe as group, test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { app } from "../app.mjs";
import { store } from "../store.mjs";
import { signed } from "../billing.mjs";
import * as A from "../auth.mjs";
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
const BASE = "http://localhost:8790";
const HOOK = "whsec_test_limits";
const db = ready ? store(env) : null;
const made = new Set();

// Stripe's API as far as the app uses it: a Checkout made, then looked up once paid.
const stripe = { made: [], sessions: new Map() };
const fake = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const send = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== "Bearer sk_test_fake") return send({ error: { message: "bad key" } }, 401);
  if (req.method === "POST" && req.url === "/v1/checkout/sessions") {
    const f = Object.fromEntries(new URLSearchParams(body));
    const id = `cs_test_${stripe.made.length + 1}`;
    stripe.made.push(f);
    stripe.sessions.set(id, { id, status: "open", client_reference_id: f.client_reference_id, customer: "cus_fake", subscription: { id: `sub_${id}`, status: "active" } });
    return send({ id, url: `https://checkout.stripe.test/${id}` });
  }
  const m = req.url.match(/^\/v1\/checkout\/sessions\/([^?]+)/);
  if (req.method === "GET" && m && stripe.sessions.has(m[1])) return send(stripe.sessions.get(m[1]));
  send({ error: { message: "no such thing" } }, 404);
});

let handle, off, capped;
before(async () => {
  if (!ready) return;
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  const cfg = { ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", FREE_CHANGES_PER_DAY: "2", PAID_CHANGES_PER_DAY: "4",
    STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API: `http://127.0.0.1:${fake.address().port}`, STRIPE_WEBHOOK_SECRET: HOOK, PRICE_USD_MONTH: "12" };
  handle = app(cfg);
  off = app({ ...cfg, MODELS_OFF: "1" });
  capped = app({ ...cfg, SPEND_CAP_USD: "0" });
});
after(async () => {
  fake.close();
  if (!ready) return;
  for (const id of made) { const row = await db.get(id); if (row) await db.remove(id, row.owner); }
});

const newPerson = () => { const id = randomUUID(); return { id, email: `limits-${id.slice(0, 8)}@example.invalid` }; };
const cookieOf = (who) => A.sessionCookie(who, env.SESSION_SECRET, false).split(";")[0];
const get = (path, who, h = handle) => h(new Request(BASE + path, { headers: who ? { cookie: cookieOf(who) } : {} }));
async function ask(id, who, utterance = "make the title bigger", h = handle) {
  const res = await h(new Request(`${BASE}/p/${id}/ask`, { method: "POST", headers: { "content-type": "application/json", cookie: cookieOf(who) }, body: JSON.stringify({ utterance }) }));
  const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return lines.find((l) => l.result)?.result;
}
let n = 0;
async function tool(name, args, who, h = handle) {
  const res = await h(new Request(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${A.key("ai", who, env.SESSION_SECRET)}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }),
  }));
  const r = (await res.json()).result;
  return { ...r, text: r.content?.[0]?.text ?? "" };
}
async function bakeryOf(who) {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  await db.create({ id, owner: who.id, state: project({ root: bakery }).save() });
  made.add(id);
  const row = await db.get(id);
  await db.save(id, row.rev, project({ root: bakery }).save(), "Crumb Bakery", 3);
  return id;
}
// The rows `k` changes leave, said today, from `via`.
const used = (who, id, k, via = "editor") => db.use(Array.from({ length: k }, () => ({
  user_id: who.id, project: id, sentence: randomUUID(), provider: "mockspeed", model: "change", purpose: "change", status: "ok", cost_usd: 0, origin: "test", via,
})));

group("a day's changes, paying for more, the kill switch", { skip: !ready && "no web/.env.local" }, () => {
  test("changes count the same wherever they were said: at the limit the editor, the panel and the AI are all refused, with the way to pay (in the chat, the plans)", async () => {
    const who = newPerson();
    const id = await bakeryOf(who);
    assert.equal((await db.gate(who.id)).changes, 0);
    await used(who, id, 1, "ai");
    await used(who, id, 1, "panel");
    assert.deepEqual(await db.gate(who.id).then((g) => [g.plan, g.changes]), ["free", 2]);

    const r = await ask(id, who);
    assert.equal(r.limit, true);
    assert.equal(r.note, W.web.limitFree.replace("{n}", "2"));
    assert.match(r.upgrade, new RegExp(`^${BASE}/upgrade/mspay_[\\w-]+\\.[\\w-]+\\?back=%2Fp%2F${id}%2F$`));
    assert.equal(r.upgradeLabel, "Upgrade — $12 a month");

    const said = await tool("say", { mock: id, sentence: "make the title bigger" }, who);
    // In the chat, the plans page and never a checkout: the directories ask that a plugin sells nothing.
    const chatNote = W.web.limitFreeChat.replace("{n}", "2");
    assert.equal(said.isError, true);
    assert.ok(said.text.includes(chatNote), said.text);
    assert.ok(said.text.includes(`${BASE}/plans`), "the AI gets the plans to pass on");
    assert.ok(!said.text.includes("/upgrade"), said.text);
    assert.equal(said._meta.mockspeed.reply.limit, true, "the panel shows it too");

    const panel = await tool("panel_change", { mock: id, route: "/ask", body: { utterance: "make the title bigger" } }, who);
    assert.equal(panel.structuredContent.mockspeed.reply.limit, true);
    assert.equal(panel.structuredContent.mockspeed.reply.upgrade, `${BASE}/plans`);
    assert.equal(panel.structuredContent.mockspeed.reply.upgradeLabel, W.web.seePlans);
    const plans = await (await get("/plans", who)).text();
    assert.ok(plans.includes(W.web.plansYoursFree.replace("{account}", who.email)));
    assert.ok(plans.includes("/upgrade?back=/projects"), "signed in, the plans page is where paying starts");
    // What carries on a change already counted is not refused: undo, a toolbar edit, look.
    assert.equal((await tool("look", { mock: id }, who)).isError, undefined);
    assert.equal((await db.gate(who.id)).changes, 2, "a refused change is not counted");
  });

  test("the pay link starts a Stripe Checkout for that account from any browser; paid, the account carries on", async () => {
    const who = newPerson();
    const id = await bakeryOf(who);
    await used(who, id, 2);
    const { upgrade } = await ask(id, who);
    // Opened where nobody is signed in: the link alone says whose it is.
    const res = await handle(new Request(upgrade));
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /^https:\/\/checkout\.stripe\.test\/cs_test_\d+$/);
    const f = stripe.made.at(-1);
    assert.equal(f.mode, "subscription");
    assert.equal(f.client_reference_id, who.id);
    assert.equal(f.customer_email, who.email);
    assert.equal(f["line_items[0][price_data][unit_amount]"], "1200");
    assert.equal(f["line_items[0][price_data][recurring][interval]"], "month");
    assert.equal(f.success_url, `${BASE}/upgrade/done?s={CHECKOUT_SESSION_ID}&back=%2Fp%2F${id}%2F`);
    const cs = res.headers.get("location").split("/").pop();

    // Back before paying: nothing changes.
    const early = await handle(new Request(`${BASE}/upgrade/done?s=${cs}&back=/p/${id}/`));
    assert.equal(early.status, 200);
    assert.ok((await early.text()).includes(W.web.payFailed));
    assert.equal((await db.gate(who.id)).plan, "free");

    stripe.sessions.get(cs).status = "complete";
    // Paid in a browser that isn't the account's (the link came from the AI): a page that says so.
    const done = await handle(new Request(`${BASE}/upgrade/done?s=${cs}&back=/p/${id}/`));
    assert.equal(done.status, 200);
    assert.ok((await done.text()).includes(W.web.paidElsewhere.replace(/'/g, "'")));
    const acct = await db.account(who.id);
    assert.deepEqual([acct.plan, acct.stripe_customer, acct.stripe_subscription, acct.stripe_status], ["paid", "cus_fake", `sub_${cs}`, "active"]);

    // Carries on: past the free 2, refused only at the paid 4, with no link to pay again.
    const r = await ask(id, who);
    assert.notEqual(r.limit, true, JSON.stringify(r));
    await used(who, id, 2);
    const full = await ask(id, who);
    assert.equal(full.limit, true);
    assert.equal(full.note, W.web.limitPaid.replace("{n}", "4"));
    assert.equal(full.upgrade, undefined);
    // Paid already: in the account's own browser the pay link, and coming back from Stripe, go back
    // to the mock, which says so.
    assert.equal((await get(new URL(upgrade).pathname + new URL(upgrade).search, who)).headers.get("location"), `/p/${id}/?note=paid`);
    assert.equal((await get(`/upgrade/done?s=${cs}&back=/p/${id}/`, who)).headers.get("location"), `/p/${id}/?note=paid`);
  });

  test("Stripe's webhook keeps the plan in step with the subscription, and only Stripe's is heard", async () => {
    const who = newPerson();
    await db.setPlan(who.id, { customer: "cus_x", subscription: `sub_${who.id}`, status: "active" });
    const hook = (event, sig) => handle(new Request(`${BASE}/api/stripe`, { method: "POST", headers: { "stripe-signature": sig ?? signed(event, HOOK) }, body: event }));
    const cancelled = JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: `sub_${who.id}`, customer: "cus_x", status: "canceled", metadata: {} } } });
    assert.equal((await hook(cancelled, signed(cancelled, "whsec_someone_else"))).status, 400);
    assert.equal((await hook(cancelled, signed(cancelled, HOOK, Math.floor(Date.now() / 1000) - 3600))).status, 400, "too old");
    assert.equal((await db.account(who.id)).plan, "paid");
    assert.equal((await hook(cancelled)).status, 200);
    assert.equal((await db.account(who.id)).plan, "free");
    const back = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: `sub_${who.id}`, customer: "cus_x", status: "active", metadata: { user: who.id } } } });
    await hook(back);
    assert.equal((await db.account(who.id)).plan, "paid");
  });

  test("the kill switch stops every sentence, the AI's too, before any model; undo still works", async () => {
    const who = newPerson();
    const id = await bakeryOf(who);
    for (const h of [off, capped]) {
      const r = await ask(id, who, "make the title bigger", h);
      assert.equal(r.paused, true);
      assert.equal(r.note, W.web.paused);
      const said = await tool("say", { mock: id, sentence: "make the title bigger" }, who, h);
      assert.equal(said.isError, true);
      assert.ok(said.text.includes(W.web.paused));
      const panel = await tool("panel_change", { mock: id, route: "/ask", body: { utterance: "hi" } }, who, h);
      assert.equal(panel.structuredContent.mockspeed.reply.paused, true);
    }
    assert.equal((await db.gate(who.id)).changes, 0);
    const u = await tool("undo", { mock: id }, who, off);
    assert.equal(u.isError, undefined);
    // Without the switch, the same sentence gets past the gate (and stops at the missing model keys).
    assert.notEqual((await ask(id, who)).paused, true);
  });

  test("with no Stripe key, paying says it isn't open, and the limit offers no link", async () => {
    const who = newPerson();
    const id = await bakeryOf(who);
    const h = app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", FREE_CHANGES_PER_DAY: "0", STRIPE_SECRET_KEY: "" });
    const r = await ask(id, who, "hi", h);
    assert.equal(r.limit, true);
    assert.equal(r.upgrade, undefined);
    const page = await h(new Request(`${BASE}/upgrade`, { headers: { cookie: cookieOf(who) } }));
    assert.ok((await page.text()).includes("Paying isn"));
  });

  test("the admin page shows the switches and today's changes by where they were said", async () => {
    const admin = newPerson();
    const h = app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", ADMIN_EMAILS: admin.email, SPEND_CAP_USD: "25", STRIPE_SECRET_KEY: "" });
    const html = await (await get("/admin", admin, h)).text();
    assert.match(html, /Changes a day: 20 free, 300 paid · spend cap \$25\.0000 a day · models on · paying: off/);
    assert.match(html, /changes today: editor \d+ · panel \d+ · ai \d+/);
  });
});
