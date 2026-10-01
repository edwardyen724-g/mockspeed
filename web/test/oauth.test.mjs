// oauth.test — signing in to mockspeed from inside the person's AI (web/oauth.mjs), the way Claude,
// ChatGPT and Claude Code do it: find the metadata from /mcp's 401, register, send the person to
// /oauth/authorize, get a code for the account they signed in as, trade it for tokens, call /mcp with
// the token, refresh. Through the web app's own handler, against the real store.
//
//   node --test web/test/*.test.mjs        (reads web/.env.local; skipped without it)

import { describe as group, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { app } from "../app.mjs";
import { oauth, redirectOk } from "../oauth.mjs";
import * as A from "../auth.mjs";

const env = {};
try {
  for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch {}
const ready = Boolean(env.SUPABASE_URL && env.MS_SERVER_KEY && env.SESSION_SECRET);
const handle = ready ? app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "" }) : null;
const BASE = "http://localhost:8790";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const person = { id: randomUUID(), email: `oauth-${Date.now()}@example.invalid` };
const cookie = ready ? A.sessionCookie(person, env.SESSION_SECRET, false).split(";")[0] : "";

const get = (path, headers = {}) => handle(new Request(BASE + path, { headers, redirect: "manual" }));
const post = (path, body, headers = {}) => handle(new Request(BASE + path, {
  method: "POST",
  headers: { "content-type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const form = (o) => new URLSearchParams(o).toString();
const pkce = () => { const verifier = randomBytes(32).toString("base64url"); return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }; };
const mcp = (token, method = "tools/list") => post("/mcp", { jsonrpc: "2.0", id: 1, method, params: {} }, { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" });
// The consent page's hidden fields, as its script puts them in the form.
const fieldsOf = (html) => JSON.parse(html.match(/data-fields="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

// Everything up to the code: register, ask, say yes. Returns the code and what went with it.
async function signIn({ redirect = CLAUDE, register = { client_name: "Claude", redirect_uris: [CLAUDE] } } = {}) {
  const reg = await (await post("/oauth/register", register)).json();
  const { verifier, challenge } = pkce();
  const ask = { response_type: "code", client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "st-1", scope: "mocks", resource: `${BASE}/mcp` };
  const html = await (await get(`/oauth/authorize?${form(ask)}`, { cookie })).text();
  const yes = await post("/oauth/authorize", form({ ...fieldsOf(html), answer: "yes" }), { cookie });
  assert.equal(yes.status, 302);
  const back = new URL(yes.headers.get("location"));
  return { reg, verifier, back, code: back.searchParams.get("code") };
}

group("signing in from inside the AI", { skip: !ready && "no web/.env.local" }, () => {
  test("the 401 leads to the metadata: the resource, its authorization server, PKCE, registration", async () => {
    const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r.status, 401);
    const at = /resource_metadata="([^"]+)"/.exec(r.headers.get("www-authenticate"))[1];
    const res = await (await get(new URL(at).pathname)).json();
    assert.equal(res.resource, `${BASE}/mcp`);
    assert.deepEqual(res.authorization_servers, [BASE]);
    assert.equal((await (await get("/.well-known/oauth-protected-resource")).json()).resource, `${BASE}/mcp`);
    const as = await (await get("/.well-known/oauth-authorization-server")).json();
    assert.equal(as.issuer, BASE);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
    assert.equal(as.registration_endpoint, `${BASE}/oauth/register`);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal((await handle(new Request(`${BASE}/oauth/token`, { method: "OPTIONS" }))).status, 204);
  });

  test("register, sign in, say yes, trade the code, call /mcp, refresh", async () => {
    const reg = await post("/oauth/register", { client_name: "Claude", redirect_uris: [CLAUDE], token_endpoint_auth_method: "none" });
    assert.equal(reg.status, 201);
    const client = await reg.json();
    assert.match(client.client_id, /^msclient_/);
    assert.equal(client.token_endpoint_auth_method, "none");
    const { verifier, challenge } = pkce();
    const ask = { response_type: "code", client_id: client.client_id, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256", state: "abc", resource: `${BASE}/mcp` };

    // Not signed in: the page asks for the email, and the link brings the person back here.
    const out = await (await get(`/oauth/authorize?${form(ask)}`)).text();
    assert.match(out, /data-state="signIn"/);
    assert.ok(out.includes("Claude wants to draw mocks"));
    const link = new URL(BASE + out.match(/data-back="([^"]+)"/)[1].replace(/&amp;/g, "&"));
    assert.equal(link.pathname, "/oauth/authorize");
    for (const [k, v] of Object.entries(ask)) assert.equal(link.searchParams.get(k), v, k);
    assert.match(link.searchParams.get("hand"), /^[a-f0-9]{32}$/, "the link hands the sign-in back to this tab");
    assert.ok(!/\{\{\w+\}\}/.test(out), "every word filled in");

    // Signed in: yes or no, for this account.
    const res = await get(`/oauth/authorize?${form(ask)}`, { cookie });
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    const html = await res.text();
    assert.match(html, /data-state="consent"/);
    assert.ok(html.includes(person.email));
    const fields = fieldsOf(html);
    assert.equal(fields.client_id, client.client_id);

    // A forged answer, or one from another account's browser, connects nothing.
    const other = A.sessionCookie({ id: randomUUID(), email: "x@example.invalid" }, env.SESSION_SECRET, false).split(";")[0];
    assert.match(await (await post("/oauth/authorize", form({ ...fields, answer: "yes" }), { cookie: other })).text(), /data-state="expired"/);

    const yes = await post("/oauth/authorize", form({ ...fields, answer: "yes" }), { cookie });
    assert.equal(yes.status, 302);
    const back = new URL(yes.headers.get("location"));
    assert.equal(back.origin + back.pathname, CLAUDE);
    assert.equal(back.searchParams.get("state"), "abc");
    assert.equal(back.searchParams.get("iss"), BASE);
    const code = back.searchParams.get("code");

    // The code: only with its verifier.
    assert.equal((await post("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CLAUDE, code_verifier: "wrong" }))).status, 400);
    const tok = await post("/oauth/token", form({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: CLAUDE, code_verifier: verifier }));
    assert.equal(tok.status, 200);
    const t = await tok.json();
    assert.equal(t.token_type, "Bearer");
    assert.equal(t.expires_in, 3600);

    // The token is the account: /mcp answers, and open_mock's mock is this person's.
    const list = await mcp(t.access_token);
    assert.equal(list.status, 200);
    assert.ok((await list.json()).result.tools.some((x) => x.name === "say"));
    assert.equal((await mcp(t.refresh_token)).status, 401, "a refresh token is not an access token");

    const again = await (await post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id }))).json();
    assert.match(again.access_token, /^mstoken_/);
    assert.equal((await mcp(again.access_token)).status, 200);
    // Another client can't use this one's refresh token.
    const stranger = await (await post("/oauth/register", { redirect_uris: ["https://evil.example/cb"] })).json();
    assert.equal((await post("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: stranger.client_id }))).status, 400);
  });

  test("no: the app is told so, and nothing is handed out", async () => {
    const reg = await (await post("/oauth/register", { client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] })).json();
    const { challenge } = pkce();
    const html = await (await get(`/oauth/authorize?${form({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", code_challenge: challenge, code_challenge_method: "S256", state: "s" })}`, { cookie })).text();
    const no = await post("/oauth/authorize", form({ ...fieldsOf(html), answer: "no" }), { cookie });
    const back = new URL(no.headers.get("location"));
    assert.equal(back.searchParams.get("error"), "access_denied");
    assert.equal(back.searchParams.get("code"), null);
  });

  test("a request that can't be trusted is refused on the page; one that can, back at the app", async () => {
    const reg = await (await post("/oauth/register", { redirect_uris: [CLAUDE] })).json();
    const { challenge } = pkce();
    const base = { response_type: "code", client_id: reg.client_id, redirect_uri: CLAUDE, code_challenge: challenge, code_challenge_method: "S256" };
    // Somewhere the client didn't register: never sent there.
    const elsewhere = await get(`/oauth/authorize?${form({ ...base, redirect_uri: "https://evil.example/cb" })}`, { cookie });
    assert.equal(elsewhere.status, 400);
    assert.match(await elsewhere.text(), /data-state="badRedirect"/);
    assert.match(await (await get(`/oauth/authorize?${form({ ...base, client_id: "made-up" })}`, { cookie })).text(), /data-state="unknownClient"/);
    // No PKCE, or plain: back to the app with the error.
    const plain = await get(`/oauth/authorize?${form({ ...base, code_challenge_method: "plain" })}`, { cookie });
    assert.equal(new URL(plain.headers.get("location")).searchParams.get("error"), "invalid_request");
    // Registering somewhere a browser could be tricked into running code: refused.
    for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "https://x.example/cb#frag"]) {
      assert.equal((await post("/oauth/register", { redirect_uris: [uri] })).status, 400, uri);
    }
  });

  test("a client that registered for a secret must send it; Claude Code's loopback port may change", async () => {
    const reg = await (await post("/oauth/register", { client_name: "Claude Code", redirect_uris: ["http://localhost:4312/callback"], token_endpoint_auth_method: "client_secret_basic" })).json();
    assert.ok(reg.client_secret);
    const { reg: r2, verifier, code, back } = await signIn({ redirect: "http://localhost:5555/callback", register: { client_name: "Claude Code", redirect_uris: ["http://localhost:4312/callback"], token_endpoint_auth_method: "client_secret_post" } });
    assert.equal(back.port, "5555");
    const trade = { grant_type: "authorization_code", code, redirect_uri: "http://localhost:5555/callback", code_verifier: verifier, client_id: r2.client_id };
    assert.equal((await post("/oauth/token", form(trade))).status, 401, "no secret");
    const basic = "Basic " + Buffer.from(`${encodeURIComponent(r2.client_id)}:${encodeURIComponent(r2.client_secret)}`).toString("base64");
    const { client_id, ...rest } = trade;
    assert.equal((await post("/oauth/token", form(rest), { authorization: basic })).status, 200);
  });

  test("the old ways still work: the key in the header and in the address", async () => {
    const key = A.key("ai", person, env.SESSION_SECRET);
    assert.equal((await mcp(key)).status, 200);
    const r = await handle(new Request(`${BASE}/mcp/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    assert.equal(r.status, 200);
  });

  test("the reviewers' password account signs in on the page an email link can't reach; ChatGPT's challenge", async () => {
    const h = app({ ...env, ANTHROPIC_API_KEY: "", TYPESAFE_API_KEY: "", REVIEW_EMAIL: "Review@example.invalid", REVIEW_PASSWORD: "correct horse battery staple", OPENAI_APPS_CHALLENGE: "tok-123\n" });
    const reg = await (await post("/oauth/register", { redirect_uris: [CLAUDE] })).json();
    const ask = form({ response_type: "code", client_id: reg.client_id, redirect_uri: CLAUDE, code_challenge: pkce().challenge, code_challenge_method: "S256" });
    assert.match(await (await h(new Request(`${BASE}/oauth/authorize?${ask}`))).text(), /data-reviewing="yes"/);
    assert.match(await (await get(`/oauth/authorize?${ask}`)).text(), /data-reviewing=""/, "not offered unless set");
    const pw = (o, hh = h) => hh(new Request(`${BASE}/api/auth/password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) }));
    assert.equal((await pw({ email: "review@example.invalid", password: "wrong" })).status, 401);
    assert.equal((await pw({ email: "review@example.invalid", password: "correct horse battery staple" }, handle)).status, 401, "off without the settings");
    const ok = await pw({ email: "review@example.invalid", password: "correct horse battery staple", back: `/oauth/authorize?${ask}` });
    assert.equal(ok.status, 200);
    const c = ok.headers.get("set-cookie").split(";")[0];
    assert.match(await (await h(new Request(`${BASE}/oauth/authorize?${ask}`, { headers: { cookie: c } }))).text(), /data-state="consent"[\s\S]*review@example.invalid/);
    assert.equal(await (await h(new Request(`${BASE}/.well-known/openai-apps-challenge`))).text(), "tok-123");
    assert.equal((await get("/.well-known/openai-apps-challenge")).status, 404);
  });

  test("the panel's resource names its own origin and the links it may open, for ChatGPT", async () => {
    const key = A.key("ai", person, env.SESSION_SECRET);
    const r = await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://mockspeed/mock" } }, { authorization: `Bearer ${key}` })).json();
    const meta = r.result.contents[0]._meta;
    assert.equal(meta["openai/widgetDomain"], BASE);
    assert.deepEqual(meta["openai/widgetCSP"].redirect_domains, [BASE]);
    assert.equal(meta.ui.domain, undefined, "Claude derives its own");
    const list = await (await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { authorization: `Bearer ${key}` })).json();
    for (const t of list.result.tools) for (const k of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof t.annotations[k], "boolean", `${t.name} ${k}`);
  });

  test("privacy and terms are there, with the support address", async () => {
    for (const p of ["/privacy", "/terms"]) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.ok(!/\{\{\w+\}\}/.test(html), p);
      assert.ok(html.includes("mailto:"), p);
    }
  });
});

group("oauth on its own", () => {
  test("a client whose id is its metadata document's address (CIMD)", async () => {
    const DOC = "https://app.example/oauth/client.json";
    let asked = 0;
    const fake = async (u) => { asked++; return new Response(JSON.stringify({ client_id: DOC, client_name: "Example", redirect_uris: ["https://app.example/cb"] })); };
    const shown = [];
    const h = oauth({ secret: "s", page: (o, status = 200) => { shown.push(o); return new Response(o.state, { status }); }, fetch: fake });
    const who = { id: "u1", email: "a@b.c" };
    const { challenge } = pkce();
    const q = form({ response_type: "code", client_id: DOC, redirect_uri: "https://app.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
    await h(new Request(`https://ms.example/oauth/authorize?${q}`), new URL(`https://ms.example/oauth/authorize?${q}`), who);
    assert.equal(shown.at(-1).state, "consent");
    assert.equal(shown.at(-1).client, "Example");
    await h(new Request(`https://ms.example/oauth/authorize?${q}`), new URL(`https://ms.example/oauth/authorize?${q}`), who);
    assert.equal(asked, 1, "read once, then remembered");
    // A document on this machine's own addresses is never fetched.
    const local = form({ response_type: "code", client_id: "https://127.0.0.1/x.json", code_challenge: challenge, code_challenge_method: "S256" });
    await h(new Request(`https://ms.example/oauth/authorize?${local}`), new URL(`https://ms.example/oauth/authorize?${local}`), who);
    assert.equal(shown.at(-1).state, "unknownClient");
    assert.equal(asked, 1);
  });

  test("the email's link, opened in another tab, hands the sign-in back to the tab the app opened", async () => {
    const sent = [];
    const live = { config: (t) => ({ url: "https://x.supabase.co", key: "k", ...t }), send: async (topic, event, payload) => sent.push({ topic, event, payload }) };
    const shown = [];
    const h = oauth({ secret: "s", live, page: (o, status = 200) => { shown.push(o); return new Response(o.state, { status }); } });
    const reg = await (await h(new Request("https://ms.example/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) }), new URL("https://ms.example/oauth/register"), null)).json();
    const q = form({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: pkce().challenge, code_challenge_method: "S256", state: "z" });
    const at = (query, who) => h(new Request(`https://ms.example/oauth/authorize?${query}`), new URL(`https://ms.example/oauth/authorize?${query}`), who);
    // The tab the app opened: signed out, listening on its hand's channel; the link carries the hand.
    await at(q, null);
    const start = shown.at(-1);
    assert.equal(start.state, "signIn");
    const hand = new URL(`https://ms.example${start.back}`).searchParams.get("hand");
    assert.match(hand, /^[a-f0-9]{32}$/);
    assert.match(start.live.hand, /^ms-h-/);
    // The tab the link opened, signed in: it says so on that channel and doesn't ask yes or no itself.
    const who = { id: "u1", email: "a@b.c" };
    await at(start.back.split("?")[1], who);
    assert.equal(shown.at(-1).state, "handed");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].topic, start.live.hand);
    // The first tab trades the grant for its own session, then asks yes or no where the app can hear it.
    const traded = await h(new Request("https://ms.example/oauth/hand", { method: "POST", body: JSON.stringify(sent[0].payload) }), new URL("https://ms.example/oauth/hand"), null);
    assert.equal(traded.status, 200);
    assert.equal(A.person(new Request("https://ms.example/", { headers: { cookie: traded.headers.get("set-cookie").split(";")[0] } }), "s").id, "u1");
    assert.equal((await h(new Request("https://ms.example/oauth/hand", { method: "POST", body: JSON.stringify({ grant: "mshand_x.y" }) }), new URL("https://ms.example/oauth/hand"), null)).status, 401);
    await at(q, who);
    assert.equal(shown.at(-1).state, "consent");
  });

  test("ChatGPT connects even when its client document can't be fetched from the server", async () => {
    const refused = async () => new Response("Just a moment...", { status: 403 });
    const shown = [];
    const h = oauth({ secret: "s", page: (o, status = 200) => { shown.push(o); return new Response(o.state, { status }); }, fetch: refused });
    const who = { id: "u1", email: "a@b.c" };
    for (const [id, redirect] of [["https://chatgpt.com/oauth/client.json", "https://chatgpt.com/connector_platform_oauth_redirect"], ["https://chatgpt.com/oauth/cb_123/client.json", "https://chatgpt.com/connector/oauth/cb_123"]]) {
      const q = form({ response_type: "code", client_id: id, redirect_uri: redirect, code_challenge: pkce().challenge, code_challenge_method: "S256" });
      await h(new Request(`https://ms.example/oauth/authorize?${q}`), new URL(`https://ms.example/oauth/authorize?${q}`), who);
      assert.equal(shown.at(-1).state, "consent", id);
      assert.equal(shown.at(-1).client, "ChatGPT");
    }
    // …but only to ChatGPT's own redirects.
    const q = form({ response_type: "code", client_id: "https://chatgpt.com/oauth/client.json", redirect_uri: "https://evil.example/cb", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    await h(new Request(`https://ms.example/oauth/authorize?${q}`), new URL(`https://ms.example/oauth/authorize?${q}`), who);
    assert.equal(shown.at(-1).state, "badRedirect");
  });

  test("where a client may be sent back to", () => {
    for (const ok of ["https://claude.ai/api/mcp/auth_callback", "http://localhost:3000/cb", "http://127.0.0.1:9/cb", "cursor://anysphere.cursor-retrieval/oauth/callback"]) assert.ok(redirectOk(ok), ok);
    for (const no of ["http://example.com/cb", "javascript:alert(1)", "data:text/html,x", "https://a.example/#x", "not a url"]) assert.ok(!redirectOk(no), no);
  });
});
