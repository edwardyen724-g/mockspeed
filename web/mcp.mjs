// mcp — mockspeed for the person's own AI, as an MCP server (Streamable HTTP, one JSON answer per
// request, nothing kept between requests). While a person talks an idea over with their AI in Claude
// Code or any other MCP client, the AI can show the shape it is proposing instead of only
// describing it: it opens a mock, the person watches it draw in a browser tab (web/live.mjs), and
// each follow-up — "what if those were cards" — is drawn there as it is said.
//
// The AI drives with the engine's own actions, never by writing the mock: it says a sentence the
// way the person would type it, points at an element by its id the way a click does, takes an
// offer, undoes. Jev decides what each sentence means and the writer writes, exactly as for a
// sentence typed in the editor (trial/engine.mjs). What the AI brings that the editor has not got is
// the conversation: `brief`, the names, words and numbers the two of them have talked over, which
// the writer uses instead of making its own up. Jev is not shown it.
//
// Each call carries the person's AI key (Authorization: Bearer msai_…, from /connect); the mocks
// it makes are that account's, in its list of projects.

import * as A from "./auth.mjs";
import * as W from "../trial/words.mjs";

const SERVER = { name: "mockspeed", version: "0.1.0" };
const LATEST = "2025-06-18";
const LONGEST = 600;

const INSTRUCTIONS = `mockspeed draws grey mocks of websites and apps, live, in a browser tab the person watches.

Use it while you and the person are talking an idea over. When you propose a shape — the pages of a site, what a screen shows, how something is laid out — and words alone won't make it clear, draw it as well as describing it:
1. open_mock, with a brief of what the two of you have talked over: the product's name, who it is for, its pages, and the real names, words, prices, times and numbers mentioned. mockspeed puts those words on the mock instead of made-up ones.
2. Give the person the link it returns (on a Mac, you can open it for them with: open <link>). One tab follows every mock you draw after that.
3. say what to draw, in plain words, the way the person would say it: "a site for Ferment, a sourdough club: classes, a schedule, sign up".
4. Each follow-up the same way, as soon as it comes up: "what if those were cards", "put the prices under the names", "add a page for the starter swap". One change per call: several calls in a row are fine, and each is drawn as soon as it is said, where one sentence with several changes has to be cut apart first. Point at one element with its id when you mean that one.

mockspeed's own engine decides what each sentence means and draws it; you never write markup, layout or code for the mock. When it offers something instead ("Put it on Classes instead"), take_offer takes it if that is what the person meant.`;

const TOOLS = [
  {
    name: "open_mock",
    title: "Open a mock",
    description: "Start a grey mock of something you are proposing — a website, an app, a screen — that the person watches being drawn live in a browser tab. Returns the mock's id and the link to give the person. Then describe what to draw with say. Nothing is drawn until you do.",
    inputSchema: {
      type: "object",
      properties: {
        brief: { type: "string", description: "What you and the person have talked over that the mock should show, in plain sentences: the product's name, who it is for, its pages, and the real names, words, prices, times and numbers mentioned. Not layout instructions." },
      },
      required: ["brief"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "say",
    title: "Say what to draw or change",
    description: "Tell mockspeed what to draw, or one change to the mock, in plain words the way the person would say it: \"a site for Ferment, a sourdough club: classes, schedule, sign up\" first, then \"what if those were cards\", \"make the prices bigger\", \"add a page for the starter swap\". Its engine decides what that means and draws it live in the person's tab. Returns what changed, anything offered instead, and the mock's elements with their ids.",
    inputSchema: {
      type: "object",
      properties: {
        mock: { type: "string", description: "The mock's id, from open_mock." },
        sentence: { type: "string", description: `One thing to draw or change, in plain words, under ${LONGEST} characters — one change per call. Details, names and data go in brief.` },
        point_at: { type: "string", description: "An element's id from the list, when the sentence means that one element — as if the person clicked it. \"this\" and \"it\" then mean it." },
        brief: { type: "string", description: "More of the conversation for the mock to use from now on: new names, words or numbers that came up." },
      },
      required: ["mock", "sentence"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "take_offer",
    title: "Take an offer",
    description: "Take one of the things mockspeed offered after a change (\"Put it on Classes instead\", \"Just this one\", \"Undo\"), or answer the question it asked, by its number in the last reply.",
    inputSchema: {
      type: "object",
      properties: { mock: { type: "string" }, offer: { type: "integer", minimum: 1, description: "The offer's number, from the last reply." } },
      required: ["mock", "offer"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "undo",
    title: "Undo",
    description: "Take back the last change to the mock.",
    inputSchema: { type: "object", properties: { mock: { type: "string" } }, required: ["mock"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "look",
    title: "Look at the mock",
    description: "The mock as it is now — including changes the person made in their tab: its pages, its elements with their ids, and anything offered.",
    inputSchema: { type: "object", properties: { mock: { type: "string" } }, required: ["mock"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

// `deps` are the web app's own (web/app.mjs): the store, opening a mock, making a change, the link.
export function mcp({ secret, db, open, change, start, link }) {
  const json = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
  const failed = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  // The mock as the AI reads it: what the reply said, what is offered, and the elements to point at.
  function told(r, p, url) {
    const s = p.state();
    const lines = [];
    if (r?.note) lines.push(r.note);
    const offered = s.question?.choices ?? s.offer ?? [];
    if (offered.length) {
      lines.push("", s.question ? `It asks: ${s.question.text} Answer with take_offer:` : "Offered instead (take_offer, if that is what the person meant):");
      offered.forEach((o, i) => lines.push(`  ${i + 1}. ${o.label}`));
    }
    lines.push("", `Mock "${s.heading}" — ${s.status}. The person watches it at ${url}`);
    if (s.elements.length) {
      lines.push("Elements (id · page · what it is), to point at:");
      for (const e of s.elements.slice(0, 300)) lines.push(`  ${e.id} · ${e.screen ?? ""} · ${e.text}`);
      if (s.elements.length > 300) lines.push(`  … and ${s.elements.length - 300} more`);
    }
    return lines.join("\n");
  }

  // A mock of this account's, or a reply saying why not.
  async function mine(user, id) {
    const row = id ? await db.get(String(id)) : null;
    return row && row.owner === user.id ? row : null;
  }
  const noMock = () => text("There's no mock with that id on this account. open_mock starts one.", true);

  async function call(name, args, user, origin) {
    const started = Date.now();
    if (name === "open_mock") {
      const { id } = await start(user, String(args.brief ?? ""));
      const url = link(user, id, origin);
      return text(`Opened mock ${id}. Give the person this link to watch it drawn: ${url}\nThen say what to draw, with mock "${id}".`);
    }
    const row = await mine(user, args.mock);
    if (!row) return noMock();
    const url = link(user, row.id, origin);
    if (name === "look") return text(told(null, open(row.state), url));
    let route, input, extra = {};
    if (name === "say") {
      const sentence = String(args.sentence ?? "").trim();
      if (!sentence) return text("Say what to draw or change, in words.", true);
      if (sentence.length > LONGEST) return text(`${W.web.tooLong} Keep the sentence under ${LONGEST} characters and put details in brief.`, true);
      route = "/ask";
      input = { utterance: sentence, marked: args.point_at ? String(args.point_at) : null, viewing: null };
      extra = { by: "ai", brief: args.brief ? String(args.brief) : "" };
    } else if (name === "undo") {
      route = "/undo";
      input = {};
    } else if (name === "take_offer") {
      const s = open(row.state).state();
      const offered = s.question?.choices ?? s.offer ?? [];
      const o = offered[Number(args.offer) - 1];
      if (!o) return text(`There is no offer ${args.offer} now; look shows what is offered.`, true);
      route = o.post.path;
      input = o.post.body ?? {};
    } else {
      return null;
    }
    const { r, p } = await change(row, route, input, { user, anon: null }, origin, extra);
    console.error(`mcp: ${name} ${JSON.stringify(input.utterance ?? route)} on ${row.id} · at ${new Date(started).toISOString()} · ${Date.now() - started} ms · ${r.changed ? "changed" : "no change"}`);
    return text(told(r, p, url), Boolean(r.error));
  }

  async function answer(msg, user, origin) {
    const { id = null, method, params = {} } = msg ?? {};
    if (method === "initialize") {
      const asked = String(params.protocolVersion ?? "");
      return { jsonrpc: "2.0", id, result: { protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : LATEST, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS } };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      try {
        const result = await call(String(params.name ?? ""), params.arguments ?? {}, user, origin);
        return result ? { jsonrpc: "2.0", id, result } : failed(id, -32602, `no tool ${params.name}`);
      } catch (e) {
        console.error(`mcp: ${params.name}: ${e.stack ?? e.message}`);
        return { jsonrpc: "2.0", id, result: text(`${W.reply.error} (${e.message})`, true) };
      }
    }
    return failed(id, -32601, `no method ${method}`);
  }

  return async function handle(req, url) {
    if (req.method !== "POST") return json(null, 405, { allow: "POST" });
    const user = A.keyed("ai", A.bearer(req), secret);
    if (!user) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `mockspeed needs your AI key: sign in at ${url.origin}/connect and add it as shown there.` } }, 401, { "www-authenticate": "Bearer" });
    let body;
    try { body = await req.json(); } catch { return json(failed(null, -32700, "not JSON"), 400); }
    const one = async (m) => (m && m.id === undefined ? null : answer(m, user, url.origin));
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(one))).filter(Boolean);
      return out.length ? json(out) : json(null, 202);
    }
    const out = await one(body);
    return out ? json(out) : json(null, 202);
  };
}
