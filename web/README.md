# web — mockspeed as a hosted web app

The trial canvas (`../trial/`), served to anyone with a browser: a landing page where the first
mock is made with no account, a project per mock, sign-in by email link at the first change or
export, a list of projects, a row of usage per model call, and an admin page with what it costs.

- `app.mjs` — the whole app as one function from a `Request` to a `Response`.
- `api/index.mjs` — that function on Vercel; `vercel.json` sends every path to it.
- `dev.mjs` — the same function on this machine: `node web/dev.mjs --env <file with the model keys>`.
- `store.mjs` — projects and usage in Supabase, through the `ms_*` functions in `db/*.sql`.
- `auth.mjs` — the browser cookie before sign-in, the email link, the signed session cookie.
- `admin.mjs` — `/admin`, for the addresses in `ADMIN_EMAILS`.
- `mcp.mjs` — `/mcp`: mockspeed for the person's own AI, as an MCP server (below).
- `live.mjs` — each change's frames, sent on a Supabase Realtime channel to the tabs watching it.
- `pages/` — the landing, projects, connect, sign-in and not-found pages. The editor is
  `../trial/shell.html` in its web mode.

Each request opens its project from the store (`trial/engine.mjs` `save()` / `saved`), acts, and
saves it over the state it opened, so any instance serves any request. A change streams back as
lines of JSON: a frame of the mock each time it redraws, then the reply. Every model call inside it
is metered (`trial/meter.mjs`) and kept as a row of `usage_events`.

## Your own AI (MCP)

While a person talks an idea over with their AI in Claude Code (or any MCP client), the AI can draw
the shape it proposes: it opens a mock, the person watches it come together in a browser tab, and
each follow-up — "what if those were cards" — is drawn there as it is said. The AI never writes the
mock: its tools are the engine's own actions, and Jev decides what every sentence means.

| Tool | What it does |
|---|---|
| `open_mock { brief }` | a mock for what the two of them have talked over; returns its id and the watch link |
| `say { mock, sentence, point_at?, brief? }` | one change in plain words, as the person would type it; `point_at` is an element id, as a click |
| `take_offer { mock, offer }` | one of the offers after a change ("Just this one", "Undo"), by number |
| `undo { mock }`, `look { mock }` | take back the last change; the pages, elements and ids as they are now |

- **The key.** `/connect`, signed in, shows the line to add it to Claude Code:
  `claude mcp add --transport http mockspeed <site>/mcp --header "Authorization: Bearer msai_…"`.
  The key is the account, signed with `SESSION_SECRET` (`auth.mjs` `key`); the mocks it makes are the
  account's, in its list of projects. Until sign-in from inside the AI (phase M3), that is the only
  way in.
- **The brief** is kept with the project (`trial/engine.mjs` `brief` / `inform`) and given to the
  writer, which uses its names, words and numbers instead of making its own up. Jev is not shown it.
- **Watching.** Every change, whoever makes it — the AI, the person's tab, another tab — sends its
  frames to the project's channel (`live.mjs`), a keyed hash only the server can make, given to a
  page only when it may see that project. The watch link (`/w/mswatch_…`, also on `/connect`) lets
  a browser look at the account's mocks without signing in; a tab opened from it follows the AI to
  each mock it opens (the account's channel). Looking is all it may do: a change asks to sign in.
- **Speed.** A change warms the connections to Jev and the writer while the mock is read from the
  store. Measured locally 2026-09-29 through Claude Code: the AI's sentence shows in the tab in
  0.2-0.35 s; a removal or a move is drawn in 0.5-0.85 s; "what if those were cards" starts
  drawing in 1.0-1.35 s (the writer's first line is most of it) and is done in about 3 s.

To try it with a local run, add the server to Claude Code with the key from `/connect` on that run
(its own `SESSION_SECRET`), open the watch link in a tab, and talk an idea over.

### The panel in Claude and ChatGPT (MCP Apps)

Where the chat shows MCP Apps (Claude desktop and claude.ai, ChatGPT), `say` and `look` come with a
panel, `ui://mockspeed/mock` (`pages/panel.html`): the mock drawn live right in the chat, and a place
for the person to change it themselves.

- **Connecting.** Their connectors take a link and no header, so `/connect` also shows
  `<site>/mcp/msai_…`: the same key, in the address (a custom connector with no authentication).
  Until sign-in from inside the AI (phase M3), that is how Claude and ChatGPT get in.
- **Drawing live.** The panel learns its mock from the tool call (`tool-input`, then the result's
  `_meta.mockspeed`: the mock, the page's state and its Realtime channel) and then hears every
  change's frames on that channel, as a watching tab does. It paints them into a shadow root, since
  the hosts allow no nested frame, zoomed to the panel's width, and scrolls to what changed. Only
  the newest panel of a mock stays open; the ones above it in the chat fold to a line (they tell each
  other over the same channel).
- **The person's own changes** go straight to the engine through the panel's own tools,
  `panel_open`, `panel_change` and `panel_tools` (`visibility: ["app"]`, hidden from the AI; listed
  to every client with descriptions saying they are not the AI's, because hosts don't reliably
  declare panel support). There is no AI turn in between: a click, the toolbar, a double-click
  rename, a sentence, an offer or Undo, as in the editor.
- **The AI hears what changed**, twice over. The panel sends the host its list of changes
  (`ui/update-model-context`), which the host gives the model with the person's next message. And
  every tool reply to the AI starts with what the person changed since the AI's own last change,
  from the project's history (`mcp.mjs` `sinceAi`; `app.mjs` `change()` marks the AI's entries
  `by: "ai"`). That also covers Claude Code and changes made in a browser tab.
- **Checked** 2026-09-30 in the MCP Apps reference host (`ext-apps` `examples/basic-host`, the
  spec's sandbox proxy and CSP) with a real browser against a local run:
  - a toolbar edit in the panel answered in 290-360 ms;
  - the person's "make the prices bigger" showed its first frame in 160-350 ms and was done in
    about 2 s;
  - the host held both as model context;
  - the AI's `say` "what if the menu items were cards" showed its first frame in a new panel
    340-380 ms after the call and was drawn in 2.5-3.3 s, while the older panel folded;
  - the AI's reply opened with the person's two changes.
- `/mcp` answers CORS, so MCP clients that run in a browser (the reference host, the MCP Inspector)
  can reach it; a call is let in only by its key.

## Settings

Environment variables; locally `web/.env.local` (never committed), in production Vercel's.

| Name | What |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | the Supabase project |
| `MS_SERVER_KEY` | the server's key to the `ms_*` functions; the database keeps only its SHA-256, in `private.keys` |
| `SESSION_SECRET` | signs the session cookie |
| `TYPESAFE_API_KEY` | Jev |
| `ANTHROPIC_API_KEY` | the writer (default provider) |
| `WRITER_PROVIDER` | `anthropic` (default) or `openrouter`, which takes `OPENROUTER_API_KEY` |
| `WRITER_BUILD_MODEL`, `WRITER_MODEL` | the model that writes a new app (Sonnet 5) and the one that writes pieces (Haiku 4.5) |
| `ADMIN_EMAILS` | who sees `/admin`, comma-separated |
| `ANON_BUILDS_PER_DAY` | mocks made without an account per address per day (3) |

Supabase Auth sends the sign-in email. Its URL configuration must allow
`<site>/auth/callback` as a redirect, or the link lands on the Site URL instead.

## The sign-in email

Supabase sends it through Resend (custom SMTP, set up by Resend's Supabase integration), from
`mockspeed <mockspeed@sealed.run>`: sealed.run is a domain already verified in Resend, borrowed until
mockspeed has its own. `email/sign-in.html` is the email, pasted into two of Supabase's templates
(Authentication → Emails): **Magic link or OTP** (someone signing in again) and **Confirm sign up**
(someone's first time), both with the subject "Sign in to mockspeed".

Its button is `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=email`: this site's own
`/auth/callback`, so the email points nowhere else, and the one-time token sits after the # where
only the page sees it. The page hands it to `/api/auth/session`, which has Supabase check it once.
Links from before (`{{ .ConfirmationURL }}`, through Supabase) still work.

## Run, test, deploy

```
node web/dev.mjs --port 8790 --env ~/path/to/keys.env
node --test web/test/*.test.mjs        # against the real store and Realtime; no model calls
vercel deploy --prod                    # from the repo root; the project's root directory is web/
```
