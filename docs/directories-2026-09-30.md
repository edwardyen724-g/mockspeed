# Submitting mockspeed to the Claude and ChatGPT directories (2026-09-30)

Everything the two submission forms ask for, filled in. The forms belong to Edward's accounts, so
he submits them. Requirements were read from the official docs on 2026-09-30. Sources:
- Claude: claude.com/docs/connectors/building/submission, …/authentication, …/review-criteria, and
  the Anthropic Software Directory Policy.
- ChatGPT: developers.openai.com/plugins/deploy/submission, /plugins/plugin-guidelines,
  /plugins/build/auth.

**OpenAI changed its flow in late September 2026.** ChatGPT "apps" are now "plugins", uploaded as a
ZIP at platform.openai.com/plugins. Older guides describe the earlier form.

## What the server already does for both (phase M3)

- **Sign-in is OAuth 2.1.** It has:
  - protected resource metadata, where `resource` is exactly `<site>/mcp`;
  - authorization server metadata with `S256`, token auth `none`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true` and `iss` on every redirect;
  - DCR and CIMD;
  - refresh tokens that rotate on every use, with `invalid_grant` when expired.

  Claude's callback (`https://claude.ai/api/mcp/auth_callback`), Claude Code's loopback (any port),
  and ChatGPT's callback (`https://chatgpt.com/connector_platform_oauth_redirect`, or its
  per-connector one) are all accepted. The consent page names the app and the host it returns to.
- **Every tool has a title and all three hints.**
  - `look`: read only.
  - `open_mock`: write, not destructive. It only adds a mock.
  - `say`, `take_offer`, `undo`: destructive. They can take things out of a mock. They can be undone, but OpenAI says that doesn't count.
  - None of them is open-world.
- **The panel declares its CSP** (Supabase Realtime, https + wss) and `openai/widgetDomain` (the
  site's origin). It sets `redirect_domains` to the site. `ui.domain` is left out, since Claude
  derives it from the connector URL.
- **Nothing is sold inside the chat.** At the day's limit, the AI and the panel point at `<site>/plans`, an information
  page, never at a checkout. ChatGPT forbids "initiating subscriptions" or "linking directly to a
  checkout" from a plugin.
- **Privacy** is at `<site>/privacy`, **terms** at `<site>/terms`, and **docs** at `<site>/connect`.
  The **icon** is at `<site>/icon.svg`.
- **Reviewer sign-in.** Reviewers can't open email links, so set `REVIEW_EMAIL` and a
  `REVIEW_PASSWORD` of 16+ random characters in Vercel. The sign-in page then offers "Reviewing
  mockspeed? Sign in with the password you were given". Give both only in the forms' credential
  fields.
- **ChatGPT's domain check.** Put the token from the MCPs tab in Vercel as `OPENAI_APPS_CHALLENGE`.
  `<site>/.well-known/openai-apps-challenge` then serves it as plain text.

## Common answers

| Field | Answer |
|---|---|
| Name | mockspeed |
| Server URL | https://mockspeed.vercel.app/mcp |
| One-liner (≤200; ChatGPT short description ≤30) | Draws grey mocks of sites and apps as you talk · ChatGPT: "Grey mocks as you talk" |
| Category | Design / Productivity |
| Docs | https://mockspeed.vercel.app/connect |
| Privacy | https://mockspeed.vercel.app/privacy |
| Terms | https://mockspeed.vercel.app/terms |
| Support | mockspeed@sealed.run (set `SUPPORT_EMAIL` to change it on the pages) |
| Auth | OAuth (Claude: `oauth_cimd`, which falls back to DCR) |
| Reads / writes | Both: it makes and changes the person's own mocks |
| Data | Our own service. No health data, no sponsored content |
| Icon | `web/pages/icon.svg` (512×512 SVG; ChatGPT accepts SVG, 48–4096 px square) |

**Description (≤2000; ChatGPT long description ≤4000):**

> mockspeed draws a grey mock of the website or app you're talking over with Claude, right in the
> chat, while you talk. Say what you have in mind — "a site for Ferment, a sourdough club: classes,
> a schedule, sign up" — and the pages appear in a few seconds, using the names, prices and times
> from your conversation instead of placeholder text. Then keep talking: "what if those were cards",
> "put the prices under the names", "add a page for the starter swap". Each change is drawn as it's
> said. You can also click the mock and change it yourself in the panel; your AI hears what you
> changed. Every mock is kept in your mockspeed account, where you can open it in a browser and
> export it as HTML or as a prompt for whoever builds it. Mocks are rough grey sketches for thinking
> an idea through, not finished designs.

ChatGPT's listing may not mention pricing or trials, and this text doesn't.

**Example prompts** (Claude needs 3+; ChatGPT `defaultPrompt` takes up to 3, ≤128 chars each):
1. "I'm starting a sourdough club called Ferment — classes on Saturdays, £25 each. Sketch the site."
2. "Mock up a booking app for my barber shop: services, a calendar, and a confirmation screen."
3. "What would a landing page for my newsletter look like? Then make the signup box bigger."

## Claude: claude.ai/directory/manage → Submit new → MCP connector

1. **Connection:** the server URL above (a universal URL).
2. **Tools:** synced from the server, with nothing flagged.
3. **Listing:** the name, one-liner and description above, categories, the docs, privacy and support fields, the icon, and the slug `mockspeed`. **The slug is permanent.**
4. **Use cases:**
   - Primary use: sketching a site or app's pages while talking it over.
   - What a person needs first: a mockspeed account, made at sign-in with any email.
5. **Company:** Edward fills this in. It is shown publicly.
6. **Authentication:** `oauth_cimd`.
7. **Data handling:** our own API. No health data, no sponsored content.
8. **Test & launch:**
   - Reviewer steps: add the connector, choose "Reviewing mockspeed?" on the sign-in page, and use the `REVIEW_EMAIL` and `REVIEW_PASSWORD` given in the form.
   - Allowed link URI: `https://mockspeed.vercel.app` (the panel's "Open in a tab").
   - Confirm every tool ran as a custom connector.
9. **Compliance:** seven acknowledgments.
   - One concerns financial transactions. mockspeed moves no money for the user. The only payment is the person's own subscription on the site, which the chat never starts.
10. **Screenshots:** 3–5 PNG, at least 1000 px wide, cropped to the panel, with each prompt given separately. Take them from claude.ai after deploy.

## ChatGPT: platform.openai.com/plugins → Upload new plugin

Before you start:
- Verify the organization (individual or business) at platform.openai.com/settings/organization/general. The directory shows the verified name.
- Your role needs Apps Management Write.

1. **ZIP:** `plugin.json`, `mcp.json` and the icon. A draft is in `docs/chatgpt-plugin/`. Check it against the upload validator; the schema is new.
2. **MCPs tab → Connect:**
   - Paste the server URL.
   - Copy the challenge token into Vercel `OPENAI_APPS_CHALLENGE` and redeploy, so the domain check passes.
   - Copy the redirect URI shown there and make sure it is the plain `connector_platform_oauth_redirect`, which it should be, since `iss` is supported.
3. **Review details:** the reviewer email and password. The account must work with no email link; the password route does that.
4. **Test cases:** 5 positive and 3 negative (below).
5. **Demo recording:** a short screen recording of the flow in ChatGPT. It is required, and only Edward can record it.
6. **Commerce:** none in the plugin. The subscription is on the website only.
7. **Countries:** all available.

**Positive test cases** (prompt → tools → expected):
1. "Sketch a site for Ferment, a sourdough club: classes, schedule, sign up" → `open_mock`, `say` → a 3–4 page grey mock in the panel, titled Ferment.
2. (after 1) "what if the classes were cards" → `say` → the class list redrawn as cards.
3. (after 1) "add a page for the starter swap" → `say` → a new page named for the starter swap.
4. (after 1) "undo that" → `undo` → the last change taken back.
5. (after 1) "what's on the mock now?" → `look` → a list of its pages and elements, with the mock shown again.

**Negative test cases** (mockspeed should not be used):
1. "Write me a CSS file for a navbar" → no mockspeed tool. It's code, not a mock.
2. "What's the weather in Leeds?" → no mockspeed tool.
3. "Summarize this article" → no mockspeed tool.

## Open questions for Edward

- **The name and the slug.** Both directories make the name public, and Claude's slug is
  permanent. Decision d1 (product name and domain) is still open. Submitting means listing as
  "mockspeed" at mockspeed.vercel.app; a new domain later means editing both listings.
- **The support address.** mockspeed@sealed.run is a sending address. It needs to receive mail too,
  or the address has to change (`SUPPORT_EMAIL`).
- **The company name** shown on both listings, and the verified identity on OpenAI.
- **The terms and privacy pages** are plain first drafts. Read them before submitting.
