// auth — who is asking: a signed-in person, or a browser that has not signed in yet.
//
// A browser gets an `ms_anon` cookie when it makes its first mock; the mocks it makes are held under
// it. Signing in is an email link, sent and checked by Supabase Auth: the link comes back to
// /auth/callback with an access token, the server asks Supabase whose it is once, and from then on
// the person is an `ms_session` cookie this server signs itself (HMAC with SESSION_SECRET), so no
// request after that waits on Supabase to know who is asking.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

const DAY = 24 * 60 * 60;
const SESSION_DAYS = 30;

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (body, secret) => createHmac("sha256", secret).update(body).digest("base64url");

// The signed-in person, { id, email }, or null.
export function person(req, secret) {
  const raw = cookies(req).ms_session;
  if (!raw || !secret) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return s.x > Date.now() / 1000 ? { id: s.u, email: s.e } : null;
  } catch { return null; }
}

const cookie = (name, value, maxAge, secure) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

export function sessionCookie({ id, email }, secret, secure) {
  const body = b64(JSON.stringify({ u: id, e: email, x: Math.floor(Date.now() / 1000) + SESSION_DAYS * DAY }));
  return cookie("ms_session", `${body}.${sign(body, secret)}`, SESSION_DAYS * DAY, secure);
}
export const signedOut = (secure) => cookie("ms_session", "", 0, secure);

// Two keys for one account, signed like the session: `ai`, which the person's own AI sends with each
// call to web/mcp.mjs (Authorization: Bearer …) and which may change their mocks; and `watch`, the
// link that shows their mocks as the AI draws them, which may only look. Neither expires; a new
// SESSION_SECRET ends every one.
export function key(kind, { id, email }, secret) {
  const body = b64(JSON.stringify({ u: id, e: email }));
  return `ms${kind}_${body}.${sign(`${kind}:${body}`, secret)}`;
}
// The account a key is for, { id, email }, or null.
export function keyed(kind, token, secret) {
  const m = /^ms([a-z]+)_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(token ?? "").trim());
  if (!m || m[1] !== kind || !secret) return null;
  const want = Buffer.from(sign(`${kind}:${m[2]}`, secret));
  const got = Buffer.from(m[3]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const s = JSON.parse(Buffer.from(m[2], "base64url").toString("utf8"));
    return s.u ? { id: s.u, email: s.e ?? null } : null;
  } catch { return null; }
}
export const bearer = (req) => (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
// A browser that opened a watch link: whose mocks it may look at.
export const watcher = (req, secret) => keyed("watch", cookies(req).ms_watch, secret);
export const watchCookie = (token, secure) => cookie("ms_watch", token, 365 * DAY, secure);

export const anonOf = (req) => (/^[a-f0-9]{32}$/.test(cookies(req).ms_anon ?? "") ? cookies(req).ms_anon : null);
export const newAnon = () => randomBytes(16).toString("hex");
export const anonCookie = (id, secure) => cookie("ms_anon", id, 365 * DAY, secure);

// The address a request came from, as a keyed hash: enough to count builds per address, not to
// know it.
export function ipHash(req, secret) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  return createHmac("sha256", secret).update(`ip:${ip}`).digest("hex").slice(0, 32);
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Supabase Auth sends the email; its link comes back to `redirect` with the tokens after a #.
export async function sendLink({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY }, email, redirect) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
    method: "POST",
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error(`sign-in link ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Whose an access token is, as Supabase says: { id, email }, or null.
export async function whose({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY }, token) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.id && u?.email ? { id: u.id, email: u.email } : null;
}
