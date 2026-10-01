# ChatGPT plugin package

What OpenAI's plugin upload (platform.openai.com/plugins) accepted on 2026-10-01, after its validator:

- one folder, zipped (`mockspeed/…`), holding `.agent-plugin/plugin.json`, `.mcp.json` and `icon.svg`;
- `interface` at the top of the manifest, with `category` one of the dashboard's titles ("Developer
  Tools" passed its check; "Design" isn't one, and "Productivity" didn't match the description) and
  `capabilities` as short labels;
- each test case's `tools_triggered` a single string.

`.mcp.json` is kept here as `mcp.json` (the dotted name can't be written from this repo's sandbox);
rename it when zipping, and point `logo`/`composerIcon` at `./icon.svg`. The demo recording URL and
reviewer credentials go in the dashboard, never in the zip. See ../directories-2026-09-30.md.
