// app — the hosted web app: the landing page, a project per mock, signing in, the list of projects,
// the usage records and the admin page. One function from a Request to a Response, so the same code
// runs on Vercel (web/api/index.mjs) and on a laptop (web/dev.mjs).
//
// Each request opens its project from the store (trial/engine.mjs save/`saved`), acts on it, and
// saves it again over the state it opened, so any instance can serve any request. What changes a
// mock streams back as lines of JSON: a frame of the mock and the page's state as a build draws,
// then the reply. Every model call made on the way is kept as a row of usage (trial/meter.mjs).
//
// A browser that has not signed in gets its first mock with no account. Its next change, or an
// export, asks it to sign in by email link; the mock it made is claimed by the account then.
//
// The person's own AI reaches the same mocks through /mcp (web/mcp.mjs), with the key /connect shows
// them. Every change, whoever makes it, also goes out live (web/live.mjs) to the tabs watching that
// mock — the person's own, or one opened from the watch link (/w/…), which may look but not change.

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { project } from "../trial/engine.mjs";
import { metered } from "../trial/meter.mjs";
import { mockPage, shell, fill } from "../trial/page.mjs";
import { builderPrompt, exportHtml, fileName } from "../trial/export.mjs";
import { serialize } from "../trial/tree.mjs";
import { MODEL, BUILD_MODEL, PROVIDERS } from "../trial/writer.mjs";
import { ENDPOINT as JEV } from "../trial/jev.mjs";
import * as W from "../trial/words.mjs";
import { store } from "./store.mjs";
import * as A from "./auth.mjs";
import { adminPage } from "./admin.mjs";
import { live as liveOf, projectTopic, accountTopic } from "./live.mjs";
import { mcp } from "./mcp.mjs";

// Each read with its own literal path, so the bundler that deploys this finds every page.
const PAGES = {
  landing: readFileSync(new URL("./pages/landing.html", import.meta.url), "utf8"),
  projects: readFileSync(new URL("./pages/projects.html", import.meta.url), "utf8"),
  callback: readFileSync(new URL("./pages/callback.html", import.meta.url), "utf8"),
  missing: readFileSync(new URL("./pages/missing.html", import.meta.url), "utf8"),
  connect: readFileSync(new URL("./pages/connect.html", import.meta.url), "utf8"),
};
const page = (name) => PAGES[name];
const PROJECT = /^\/p\/([a-z0-9]{8,40})(\/.*)?$/;
const WATCH = /^\/w\/(mswatch_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const CHANGES = new Set(["/ask", "/answer", "/swap", "/edit", "/undo", "/new"]);
// What a browser with no account may do: its first mock, and the answers and swaps that come with it.
const FIRST = new Set(["/ask", "/answer", "/swap"]);
const LONGEST = 600;

export function app(env) {
  const db = store(env);
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("the web app needs SESSION_SECRET");
  const provider = env.WRITER_PROVIDER || "anthropic";
  const keys = {
    apiKey: env.TYPESAFE_API_KEY || null,
    llmKey: (provider === "openrouter" ? env.OPENROUTER_API_KEY : env.ANTHROPIC_API_KEY) || null,
    model: env.WRITER_MODEL || MODEL,
    buildModel: env.WRITER_BUILD_MODEL || BUILD_MODEL,
    provider,
  };
  const admins = new Set((env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const anonBuilds = Number(env.ANON_BUILDS_PER_DAY ?? 3);
  const open = (saved) => project({ saved, ...keys });
  const live = liveOf(env);
  // The connections a change needs, opened while its mock is read from the store: once idle for a
  // few seconds each is closed, and Jev's and the writer's handshakes one after the other cost a
  // follow-up 0.2-0.4 s before anything is drawn. A HEAD request costs nothing.
  const warm = () => { for (const u of [JEV, PROVIDERS[provider]?.endpoint]) if (u) fetch(u, { method: "HEAD" }).then((r) => r.body?.cancel()).catch(() => {}); };
  const newId = () => randomBytes(6).toString("hex");

  const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
  const go = (location, headers = {}) => new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
  const body = async (req) => { try { return await req.json(); } catch { return {}; } };

  // The words every page of ours fills in, and who is looking.
  const words = (who) => ({ ...W.web, account: who.user ? who.user.email : "", signedIn: who.user ? "yes" : "" });

  // The page's state, as trial/server.mjs's /state, with its version (a tab that handed a change over
  // to another follows it by that), and who is looking.
  const stateOf = (p, who) => ({ ...p.state(), version: p.version, out: "", account: { signedIn: Boolean(who.user), email: who.user?.email ?? null } });
  // What a page may listen on: its mock's channel, and its account's, where "your AI opened another
  // mock" is said to a tab that follows the AI (opened from the watch link).
  const liveFor = (row) => live.config({ project: projectTopic(secret, row.id), account: row.owner ? accountTopic(secret, row.owner) : null });
  // The link the person's AI gives them: it lets this browser watch the account's mocks and opens
  // this one, and the tab then follows each mock the AI opens after it.
  const watchLink = (user, id, origin) => `${origin}/w/${A.key("watch", user, secret)}?p=${id}`;

  // The person's own AI: a mock for it to draw on — the account's newest when nothing is drawn on it
  // yet, else a new one — with what the two of them have talked over; the tabs following the AI go to
  // it.
  async function startForAi(user, brief) {
    const newest = (await db.list(user.id))[0];
    let id;
    if (newest && newest.screens === 0) {
      id = newest.id;
      const row = await db.get(id);
      await db.save(id, row.rev, project({ brief }).save(), "", 0);
    } else {
      id = newId();
      await db.create({ id, owner: user.id, state: project({ brief }).save() });
    }
    await live.send(accountTopic(secret, user.id), "open", { id });
    return { id };
  }
  const forAi = mcp({ secret, db, open, change, start: startForAi, link: watchLink });

  return async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const secure = url.protocol === "https:";
    const who = { user: A.person(req, secret), anon: A.anonOf(req), watch: A.watcher(req, secret) };
    try {
      // ---- pages ---------------------------------------------------------------------------
      if (path === "/" && req.method === "GET") return html(fill(page("landing"), { ...words(who), starters: JSON.stringify(W.starters) }));
      if (path === "/projects" && req.method === "GET") {
        const list = who.user ? await db.list(who.user.id) : [];
        return html(fill(page("projects"), { ...words(who), list: JSON.stringify(list) }));
      }
      if (path === "/auth/callback" && req.method === "GET") return html(fill(page("callback"), words(who)));
      // What the person adds to their AI, and the link to keep open while it draws.
      if (path === "/connect" && req.method === "GET") {
        const ai = who.user ? A.key("ai", who.user, secret) : "";
        return html(fill(page("connect"), { ...words(who), command: ai ? `claude mcp add --transport http mockspeed ${url.origin}/mcp --header "Authorization: Bearer ${ai}"` : "", watch: ai ? `${url.origin}/w/${A.key("watch", who.user, secret)}` : "" }));
      }
      if (path === "/mcp") {
        if (req.method === "POST") warm();
        return forAi(req, url);
      }
      // The watch link: this browser may look at the account's mocks from now on; it opens the one
      // named, or the newest (an empty one when there is none), and follows the ones the AI opens.
      const w = path.match(WATCH);
      if (w && req.method === "GET") {
        const owner = A.keyed("watch", w[1], secret);
        if (!owner) return html(fill(page("missing"), words(who)), 404);
        const want = url.searchParams.get("p");
        let id = null;
        if (want && PROJECT.test(`/p/${want}`)) { const row = await db.get(want); if (row?.owner === owner.id) id = row.id; }
        if (!id) id = (await db.list(owner.id))[0]?.id ?? null;
        if (!id) { id = newId(); await db.create({ id, owner: owner.id, state: project().save() }); }
        return go(`/p/${id}/?follow=1`, { "set-cookie": A.watchCookie(w[1], secure) });
      }
      if (path === "/admin" && req.method === "GET") {
        if (!who.user || !admins.has(who.user.email.toLowerCase())) return html(fill(page("missing"), words(who)), 404);
        const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        since.setUTCHours(0, 0, 0, 0);
        return html(adminPage(await db.usage(since.toISOString()), { since, now: new Date(), keys }));
      }

      // ---- signing in ----------------------------------------------------------------------
      if (path === "/api/me") return json({ signedIn: Boolean(who.user), email: who.user?.email ?? null });
      if (path === "/api/auth/link" && req.method === "POST") {
        const { email = "", back = "/" } = await body(req);
        const address = String(email).trim();
        if (!A.EMAIL.test(address) || address.length > 200) return json({ ok: false, note: W.web.badEmail }, 400);
        const to = `${url.origin}/auth/callback?back=${encodeURIComponent(safeBack(back))}`;
        try { await A.sendLink(env, address, to); } catch (e) { return json({ ok: false, note: W.web.linkFailed, debug: e.message }, 502); }
        // The link may be opened in another browser: this one's mocks wait for the address too.
        if (who.anon) await db.expect(who.anon, address);
        return json({ ok: true, note: W.web.linkSent });
      }
      if (path === "/api/auth/session" && req.method === "POST") {
        const { access_token: token, back = "/" } = await body(req);
        const user = token ? await A.whose(env, String(token)) : null;
        if (!user) return json({ ok: false, note: W.web.linkBad }, 401);
        const claimed = await db.claim(user.id, who.anon, user.email);
        await db.use([{ user_id: user.id, anon: who.anon, sentence: randomUUID(), provider: "mockspeed", model: "auth", purpose: "signin", status: `claimed ${claimed}`, cost_usd: 0, origin: url.host }]);
        return json({ ok: true, back: safeBack(back), claimed }, 200, { "set-cookie": A.sessionCookie(user, secret, secure) });
      }
      if (path === "/api/auth/out" && req.method === "POST") return json({ ok: true }, 200, { "set-cookie": A.signedOut(secure) });

      // ---- projects ------------------------------------------------------------------------
      if (path === "/api/start" && req.method === "POST") {
        const headers = {};
        let anon = null, ip = null;
        if (!who.user) {
          anon = who.anon ?? A.newAnon();
          if (!who.anon) headers["set-cookie"] = A.anonCookie(anon, secure);
          ip = A.ipHash(req, secret);
        }
        const id = newId();
        await db.create({ id, owner: who.user?.id ?? null, anon, ip, state: project().save() });
        return json({ id, url: `/p/${id}/` }, 200, headers);
      }
      if (path === "/api/projects/delete" && req.method === "POST") {
        if (!who.user) return json({ ok: false, signin: true }, 401);
        const { id } = await body(req);
        return json({ ok: (await db.remove(String(id ?? ""), who.user.id)) > 0 });
      }

      const at = path.match(PROJECT);
      if (!at) return html(fill(page("missing"), words(who)), 404);
      if (req.method === "POST" && CHANGES.has(at[2] ?? "")) warm();
      if (!at[2]) return go(`/p/${at[1]}/`);
      const row = await db.get(at[1]);
      const mine = row && (row.owner ? row.owner === who.user?.id : Boolean(who.anon) && row.anon === who.anon);
      // Opened from the watch link: this account's mocks may be looked at, not changed.
      const sees = mine || Boolean(row?.owner && who.watch?.id === row.owner);
      const route = at[2];
      if (!sees) return route === "/" ? html(fill(page("missing"), words(who)), 404) : json({ note: W.web.notFound, changed: false }, 404);

      if (route === "/" && req.method === "GET") return html(shell({ mode: "web", ...words(who), title: row.title || W.web.product, live: JSON.stringify(liveFor(row)) }));
      if (route === "/mock") return html(mockPage(open(row.state).root));
      if (route === "/state") return json(stateOf(open(row.state), who));
      if (route === "/tools") return json(open(row.state).tools(url.searchParams.get("id")));
      if (route === "/spec") return new Response(serialize(open(row.state).root), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
      // Export: a commitment, like a change — an account keeps what is exported from it.
      if (route === "/export.html" || route === "/export.md" || route === "/prompt") {
        if (!who.user || !mine) return json({ signin: true, note: W.web.keepGoing, changed: false }, 401);
        const root = open(row.state).root;
        const isHtml = route === "/export.html";
        const head = { "content-type": `${isHtml ? "text/html" : route === "/prompt" ? "text/plain" : "text/markdown"}; charset=utf-8`, "cache-control": "no-store" };
        if (route !== "/prompt") head["content-disposition"] = `attachment; filename="${fileName(root, isHtml ? "html" : "md")}"`;
        await db.use([{ user_id: who.user.id, project: row.id, sentence: randomUUID(), provider: "mockspeed", model: "export", purpose: route.slice(1), status: "ok", cost_usd: 0, origin: url.host }]);
        return new Response(isHtml ? exportHtml(root) : builderPrompt(root), { headers: head });
      }
      if (CHANGES.has(route) && req.method === "POST") {
        const input = await body(req);
        if (!mine) return json({ signin: true, note: W.web.keepGoing, changed: false }, 401);
        if (!who.user) {
          const first = !row.built_at && row.screens === 0 && FIRST.has(route);
          if (!first) return json({ signin: true, note: W.web.keepGoing, changed: false }, 401);
          if (route === "/ask" && (await db.anonBuilds(A.ipHash(req, secret))) >= anonBuilds) return json({ signin: true, note: W.web.anonLimit, changed: false }, 401);
        }
        if (route === "/ask" && String(input.utterance ?? "").length > LONGEST) return json({ note: W.web.tooLong, changed: false });
        return act(row, route, input, who, url.host);
      }
      return json({ note: W.web.notFound, changed: false }, 404);
    } catch (e) {
      console.error(`web: ${req.method} ${path}: ${e.stack ?? e.message}`);
      return json({ note: W.reply.error, debug: e.message, changed: false, error: true }, 500);
    }
  };

  // A change to a mock: opened from the store, made, saved over the state it was opened from, its
  // model calls kept as usage rows, each with the site it was made on (`origin`: the deployed app, or
  // a local run against the same store). Each frame — a build draws a page at a time, a piece a few
  // lines at a time — goes out live to the tabs watching this mock, with the sentence's id so the tab
  // that asked knows its own, and to `frame`, for the reply streamed to that tab. `extra` is what
  // only the person's AI brings (web/mcp.mjs): `by: "ai"` and more of the conversation (`brief`).
  // Returns the reply and the project as it is after.
  async function change(row, route, input, who, origin, { sentence = randomUUID(), frame = null, by = null, brief = "" } = {}) {
    const p = open(row.state);
    const uses = [];
    const shared = () => ({ ...p.state(), version: p.version, out: "", sentence });
    const out = live.channel(projectTopic(secret, row.id), (mock) => ({ ...(mock ? { html: mockPage(p.root) } : {}), state: shared() }));
    let rev = p.version.rev;
    const off = p.subscribe((v) => {
      const mock = v.rev !== rev;
      rev = v.rev;
      out.touch(mock);
      if (mock && frame) frame({ html: mockPage(p.root), state: stateOf(p, who) });
    });
    let r;
    try {
      r = await metered((u) => uses.push(u), async () => {
        if (route === "/ask") {
          if (brief) p.inform(brief);
          return p.ask({ utterance: String(input.utterance ?? ""), marked: input.marked ?? null, viewing: input.viewing ?? null, chip: Boolean(input.chip), by });
        }
        if (route === "/answer") return p.answer(input);
        if (route === "/swap") return p.swap(input);
        if (route === "/edit") return p.edit(input);
        if (route === "/undo") return p.undo(input);
        return p.startAgain();
      });
    } catch (e) {
      r = { note: W.reply.error, debug: e.message, changed: false, error: true };
    }
    off();
    try {
      const s = p.state();
      const saved = await db.save(row.id, row.rev, p.save(), String(s.title ?? ""), s.screens);
      if (!saved) r = { note: W.web.conflict, changed: false, error: true };
    } catch (e) {
      r = { note: W.reply.error, debug: e.message, changed: false, error: true };
    }
    try {
      await db.use(uses.map((u) => ({
        user_id: who.user?.id ?? null, anon: who.user ? null : who.anon, project: row.id, sentence,
        provider: u.provider, model: u.model, purpose: u.purpose, input_tokens: u.input ?? 0, output_tokens: u.output ?? 0,
        cache_read_tokens: u.cacheRead ?? 0, cache_write_tokens: u.cacheWrite ?? 0, jev_questions: u.questions ?? null,
        ms: u.ms ?? null, first_line_ms: u.firstLineMs ?? null, status: u.status ?? "ok", cost_usd: u.cost, origin,
      })));
    } catch (e) {
      console.error(`web: usage for ${row.id} not kept: ${e.message}`);
    }
    // The last frame, once saved: the mock, the page's state and the reply, which a watching tab
    // shows as its own.
    await out.end({ html: mockPage(p.root), state: shared(), reply: r, done: true });
    return { r, p };
  }

  // A change asked for by the editor's own tab: its sentence's id first, then a frame each time the
  // mock redraws, then the reply, as lines of JSON.
  function act(row, route, input, who, origin) {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o) => ctrl.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        const sentence = randomUUID();
        send({ sentence });
        const { r } = await change(row, route, input, who, origin, { sentence, frame: (f) => send({ frame: f }) });
        send({ result: r });
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }
}

// Where a sign-in link brings a person back to: a path on this site, never somewhere else.
function safeBack(back) {
  const b = String(back ?? "/");
  return b.startsWith("/") && !b.startsWith("//") && !b.includes("\\") ? b : "/";
}
