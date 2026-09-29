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
- `pages/` — the landing, projects, sign-in and not-found pages. The editor is `../trial/shell.html`
  in its web mode.

Each request opens its project from the store (`trial/engine.mjs` `save()` / `saved`), acts, and
saves it over the state it opened, so any instance serves any request. A change streams back as
lines of JSON: a frame of the mock each time it redraws, then the reply. Every model call inside it
is metered (`trial/meter.mjs`) and kept as a row of `usage_events`.

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
node --test web/test/*.test.mjs        # against the real store; no model calls
vercel deploy --prod                    # from the repo root; the project's root directory is web/
```
