// oauth — signing in to mockspeed from inside the person's AI. The person adds mockspeed to Claude,
// ChatGPT or Claude Code by its link alone (<site>/mcp); the first call gets a 401 that points at
// this server's OAuth metadata, the AI's app opens /oauth/authorize in a browser, the person signs
// in there with the same email link as the site's and says yes, and the app gets a token for their
// account. Every mock it makes is theirs, in their list of projects, and every `say` is one of their
// day's changes (web/app.mjs change()), exactly as with the key /connect shows.
//
// OAuth 2.1 as MCP's authorization spec asks (2025-06-18, 2025-11-25): protected resource metadata
// (RFC 9728) at /.well-known/oauth-protected-resource[/mcp], authorization server metadata (RFC 8414)
// at /.well-known/oauth-authorization-server, the authorization code grant with PKCE (S256 only), and
// refresh tokens. A client says who it is either by registering (RFC 7591, /oauth/register) or by
// its client_id being the https address of its metadata document (CIMD), which is read from there.
//
// Nothing is kept on the server: a registration, a code and each token are sealed with
// SESSION_SECRET (auth.mjs seal), like the AI key. A code lasts 5 minutes and is bound to its client,
// its redirect_uri and its PKCE challenge; an access token lasts an hour, a refresh token 90 days,
// renewed each time it is used. A new SESSION_SECRET ends all of them.

import { createHash, createHmac, randomBytes } from "node:crypto";
import * as A from "./auth.mjs";

const SCOPE = "mocks";
const CODE_S = 5 * 60;
const ACCESS_S = 60 * 60;
const REFRESH_S = 90 * 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);
const tag = (s) => createHash("sha256").update(String(s)).digest("base64url").slice(0, 22);
const s256 = (verifier) => createHash("sha256").update(String(verifier)).digest("base64url");
// Schemes a redirect may never use; anything else is an app's own (cursor://…, RFC 8252).
const NEVER = new Set(["javascript", "data", "vbscript", "file", "about", "blob", "filesystem", "ws", "wss"]);
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Where a client may be sent back to: https anywhere, http only to this machine, or an app's own
// scheme.
export function redirectOk(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return false; }
  const scheme = u.protocol.slice(0, -1);
  if (u.hash) return false;
  if (scheme === "https") return true;
  if (scheme === "http") return LOCAL.has(u.hostname);
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !NEVER.has(scheme);
}
// A loopback redirect matches whatever port the app listens on this time (RFC 8252 7.3).
function sameRedirect(given, registered) {
  if (given === registered) return true;
  try {
    const a = new URL(given), b = new URL(registered);
    return a.protocol === "http:" && LOCAL.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

// `deps`: the page to show (sign in, or say yes), and what to note when an AI is let in.
// `live` (web/live.mjs) hands a sign-in back to the tab the AI's app opened (below).
export function oauth({ secret, page, noted = async () => {}, live = null, fetch: get = fetch }) {
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", ...headers } });
  const bad = (error, description, status = 400) => json({ error, error_description: description }, status);
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version" };

  const resource = (origin) => ({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "mockspeed",
    resource_documentation: `${origin}/connect`,
  });
  const server = (origin) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    client_id_metadata_document_supported: true,
    service_documentation: `${origin}/connect`,
    op_policy_uri: `${origin}/privacy`,
    op_tos_uri: `${origin}/terms`,
  });

  // A client registered here (its registration sealed into its client_id), or one whose client_id
  // is its metadata document's address: { name, redirects, secret }, or null.
  const documents = new Map();
  async function client(id) {
    const reg = A.unseal("client", id, secret);
    if (reg) return { name: String(reg.n || "Your AI"), redirects: reg.r ?? [], secret: reg.m === "s" };
    if (!/^https:\/\/[^/]+\/./.test(String(id ?? ""))) return null;
    const had = documents.get(id);
    if (had && had.until > Date.now()) return had.client;
    let found = null;
    try {
      const u = new URL(id);
      if (LOCAL.has(u.hostname) || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(":")) return null;
      const res = await get(id, { headers: { accept: "application/json", "user-agent": "mockspeed/0.3 (+https://mockspeed.vercel.app)" }, redirect: "error", signal: AbortSignal.timeout(4000) });
      const text = res.ok ? await res.text() : "";
      if (!res.ok) console.error(`oauth: client document ${id} answered ${res.status}`);
      if (text && text.length < 20000) {
        const doc = JSON.parse(text);
        const redirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(redirectOk).map(String) : [];
        if (doc.client_id === id && redirects.length) found = { name: String(doc.client_name || u.hostname).slice(0, 80), redirects, secret: false };
      }
    } catch (e) {
      console.error(`oauth: client document ${id}: ${e.message}`);
    }
    // A host's own documents that its front door may refuse a server's fetch (ChatGPT's, behind
    // Cloudflare): what they say, as published, so a refused fetch doesn't stop the person connecting.
    found ??= knownClient(id);
    documents.set(id, { client: found, until: Date.now() + 5 * 60 * 1000 });
    return found;
  }
  // The client's secret, when it registered for one: derived from its client_id, so nothing is kept.
  const secretOf = (id) => A.hmac(`client-secret:${id}`, secret);

  async function register(req) {
    let m;
    try { m = await req.json(); } catch { return bad("invalid_client_metadata", "not JSON"); }
    const redirects = Array.isArray(m?.redirect_uris) ? m.redirect_uris.map(String) : [];
    if (!redirects.length || redirects.length > 10) return bad("invalid_redirect_uri", "one to ten redirect_uris");
    if (!redirects.every(redirectOk)) return bad("invalid_redirect_uri", "each redirect_uri must be https, http to localhost, or an app's own scheme, with no #");
    const method = ["client_secret_post", "client_secret_basic"].includes(m.token_endpoint_auth_method) ? m.token_endpoint_auth_method : "none";
    const name = String(m.client_name ?? "").slice(0, 80);
    const id = A.seal("client", { r: redirects, n: name, ...(method === "none" ? {} : { m: "s" }) }, secret);
    return json({
      client_id: id,
      client_id_issued_at: now(),
      ...(method === "none" ? {} : { client_secret: secretOf(id), client_secret_expires_at: 0 }),
      client_name: name || undefined,
      redirect_uris: redirects,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    }, 201);
  }

  // The request to sign in, checked: what is wrong with it before a redirect can be trusted (shown on
  // the page), after (sent back to the client), or what it asks for.
  async function asked(q, origin) {
    const c = await client(q.client_id);
    if (!c) return { page: "unknownClient" };
    const redirect = q.redirect_uri ? String(q.redirect_uri) : c.redirects.length === 1 ? c.redirects[0] : "";
    if (!redirect || !c.redirects.some((r) => sameRedirect(redirect, r))) return { page: "badRedirect" };
    const back = (error, description) => ({ error: withQuery(redirect, { error, error_description: description, state: q.state, iss: origin }) });
    if (q.response_type !== "code") return back("unsupported_response_type", "only code");
    if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") return back("invalid_request", "PKCE with S256 is required");
    if (q.resource && !forUs(q.resource, origin)) return back("invalid_target", `the resource is ${origin}/mcp`);
    return { ok: { client: c, client_id: String(q.client_id), redirect, challenge: String(q.code_challenge), state: q.state ?? null, scope: SCOPE } };
  }
  const forUs = (r, origin) => [`${origin}/mcp`, `${origin}/mcp/`, origin, `${origin}/`].includes(String(r));
  const csrf = (user, a) => A.hmac(`authorize:${user.id}:${tag(a.client_id)}:${a.redirect}:${a.challenge}`, secret);
  const params = (q) => Object.fromEntries(["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"].filter((k) => q[k] != null).map((k) => [k, String(q[k])]));

  // GET: sign in first if need be, then say yes or no. POST: the answer.
  async function authorize(req, url, user) {
    const q = req.method === "POST" ? Object.fromEntries(new URLSearchParams(await req.text())) : Object.fromEntries(url.searchParams);
    const a = await asked(q, url.origin);
    if (a.page) return page({ state: a.page }, 400);
    if (a.error) return go(a.error);
    const it = a.ok;
    if (req.method === "GET") {
      // The email's link may open in another tab, another browser or the mail app's own: the app (Claude,
      // ChatGPT) only takes the answer back in the tab it opened, so the sign-in is handed back there. The
      // page here listens on a channel named for a random `hand`, which rides along in the link; the tab
      // the link opens, once signed in, says so on that channel with a sealed two-minute grant, which this
      // tab trades for its own session (/oauth/hand), and it carries on to the yes-or-no itself.
      if (!user) {
        const hand = randomBytes(16).toString("hex");
        const rest = new URLSearchParams(params(q));
        rest.set("hand", hand);
        return page({ state: "signIn", client: it.client.name, back: `${url.pathname}?${rest}`, live: live?.config({ hand: handTopic(secret, hand) }) ?? null });
      }
      if (/^[a-f0-9]{32}$/.test(q.hand ?? "") && live) {
        await live.send(handTopic(secret, q.hand), "signed", { grant: A.seal("hand", { u: user.id, e: user.email, x: now() + 120 }, secret) });
        return page({ state: "handed", client: it.client.name, back: `${url.pathname}?${new URLSearchParams(params(q))}` });
      }
      return page({ state: "consent", client: it.client.name, account: user.email, host: hostOf(it.redirect), fields: { ...params(q), csrf: csrf(user, it) } });
    }
    if (!user || q.csrf !== csrf(user, it)) return page({ state: "expired", back: `${url.pathname}?${new URLSearchParams(params(q))}` }, 400);
    if (q.answer !== "yes") return go(withQuery(it.redirect, { error: "access_denied", error_description: "the person said no", state: it.state, iss: url.origin }));
    const code = A.seal("code", { u: user.id, e: user.email, c: tag(it.client_id), r: it.redirect, k: it.challenge, a: `${url.origin}/mcp`, x: now() + CODE_S }, secret);
    await noted(user, it.client.name).catch(() => {});
    return go(withQuery(it.redirect, { code, state: it.state, iss: url.origin }));
  }

  async function token(req) {
    const text = await req.text();
    let q;
    if ((req.headers.get("content-type") ?? "").includes("json")) { try { q = JSON.parse(text); } catch { q = {}; } }
    else q = Object.fromEntries(new URLSearchParams(text));
    // The client: from the body, or HTTP Basic.
    let id = q.client_id ? String(q.client_id) : "", given = q.client_secret ? String(q.client_secret) : "";
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    if (basic) {
      const [u, p = ""] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      id = decodeURIComponent(u); given = decodeURIComponent(p);
    }
    const c = id ? await client(id) : null;
    if (!c) return bad("invalid_client", "unknown client", 401);
    if ((c.secret || given) && given !== secretOf(id)) return bad("invalid_client", "wrong client secret", 401);

    let who;
    if (q.grant_type === "authorization_code") {
      const code = A.unseal("code", q.code, secret);
      if (!code || code.c !== tag(id)) return bad("invalid_grant", "the code is wrong or has expired");
      if (q.redirect_uri && !sameRedirect(String(q.redirect_uri), code.r)) return bad("invalid_grant", "redirect_uri differs from the one signed in with");
      if (!q.code_verifier || s256(q.code_verifier) !== code.k) return bad("invalid_grant", "code_verifier doesn't match");
      who = code;
    } else if (q.grant_type === "refresh_token") {
      const r = A.unseal("refresh", q.refresh_token, secret);
      if (!r || r.c !== tag(id)) return bad("invalid_grant", "the refresh token is wrong or has expired");
      who = r;
    } else {
      return bad("unsupported_grant_type", "authorization_code or refresh_token");
    }
    // The token is for /mcp here (its audience), whatever the resource was asked for as.
    const body = { u: who.u, e: who.e, c: tag(id), a: who.a };
    return json({
      access_token: A.seal("token", { ...body, x: now() + ACCESS_S }, secret),
      token_type: "Bearer",
      expires_in: ACCESS_S,
      refresh_token: A.seal("refresh", { ...body, x: now() + REFRESH_S }, secret),
      scope: SCOPE,
    });
  }

  // The routes, or null when the path isn't one of these.
  return async function handle(req, url, user) {
    const path = url.pathname;
    const meta = path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/") ? resource(url.origin)
      : path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp" ? server(url.origin) : null;
    const ours = meta || ["/oauth/register", "/oauth/token", "/oauth/authorize", "/oauth/hand"].includes(path);
    if (!ours) return null;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (meta) return req.method === "GET" ? json(meta, 200, { "cache-control": "public, max-age=3600" }) : json({ error: "GET" }, 405);
    if (path === "/oauth/hand") {
      let g = {};
      try { g = await req.json(); } catch {}
      const who = req.method === "POST" ? A.unseal("hand", g.grant, secret) : null;
      if (!who?.u) return json({ ok: false }, 401);
      return json({ ok: true }, 200, { "set-cookie": A.sessionCookie({ id: who.u, email: who.e }, secret, url.protocol === "https:") });
    }
    if (path === "/oauth/register") return req.method === "POST" ? register(req) : json({ error: "POST" }, 405);
    if (path === "/oauth/token") return req.method === "POST" ? token(req) : json({ error: "POST" }, 405);
    return req.method === "GET" || req.method === "POST" ? authorize(req, url, user) : json({ error: "GET or POST" }, 405);
  };
}

// The account an access token from here is for, { id, email }, or null: one handed out for /mcp on
// this site (`origin`).
export const tokenFor = (token, secret, origin) => {
  const s = A.unseal("token", token, secret);
  return s?.u && (!s.a || s.a === `${origin}/mcp`) ? { id: s.u, email: s.e ?? null } : null;
};
const hostOf = (uri) => { try { return new URL(uri).host || new URL(uri).protocol.slice(0, -1); } catch { return ""; } };

// What a 401 from /mcp says, so the person's AI knows where to sign in.
export const challenge = (origin, error = null) =>
  `Bearer ${error ? `error="${error}", ` : ""}resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPE}"`;

// ChatGPT's client documents (developers.openai.com/plugins/build/auth): the one for every connector,
// whose redirect is connector_platform_oauth_redirect, and one per connector, whose redirect carries
// the same callback id.
export function knownClient(id) {
  if (id === "https://chatgpt.com/oauth/client.json") return { name: "ChatGPT", redirects: ["https://chatgpt.com/connector_platform_oauth_redirect"], secret: false };
  const m = /^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,100})\/client\.json$/.exec(String(id));
  return m ? { name: "ChatGPT", redirects: [`https://chatgpt.com/connector/oauth/${m[1]}`, "https://chatgpt.com/connector_platform_oauth_redirect"], secret: false } : null;
}
const handTopic = (secret, hand) => `ms-h-${createHmac("sha256", secret).update(`hand:${hand}`).digest("base64url").slice(0, 32)}`;
const go = (location) => new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
function withQuery(uri, q) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(q)) if (v != null && v !== "") u.searchParams.set(k, v);
  return u.toString();
}
