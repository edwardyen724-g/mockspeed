// live — what a tab watching a mock hears while it changes, whichever instance makes the change: a
// change made through the person's own AI (web/mcp.mjs) runs in a request the tab has nothing to do
// with, so its frames go out on a Supabase Realtime channel and the page listens there
// (trial/shell.html). A channel's name is a keyed hash only this server can make — of the project,
// or of the account for "your AI opened another mock" — and the page is given it only when it may
// see that project.
//
// Frames are the whole mock each time, so only the newest waiting one needs to go: a channel sends
// one message at a time and, while one is on its way, keeps just the latest to send next.

import { createHmac } from "node:crypto";

const hash = (secret, what) => createHmac("sha256", secret).update(what).digest("base64url").slice(0, 32);
export const projectTopic = (secret, id) => `ms-p-${hash(secret, `live:${id}`)}`;
export const accountTopic = (secret, uid) => `ms-a-${hash(secret, `acct:${uid}`)}`;

// Supabase's limit on one message is 256 KB; a mock's frame is about 30 KB. A bigger one goes without
// its picture, and the page fetches the mock itself.
const MOST = 200_000;

export function live({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY }) {
  const on = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
  async function post(topic, event, payload) {
    if (!on) return;
    if (payload.html && payload.html.length > MOST) payload = { ...payload, html: null, reload: true };
    try {
      const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
      });
      if (!res.ok) console.error(`live: ${topic} ${res.status} ${(await res.text()).slice(0, 120)}`);
    } catch (e) {
      console.error(`live: ${topic} ${e.message}`);
    }
  }

  return {
    // What a page needs to listen: the address, the public key and the channels.
    config: (topics) => (on ? { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, ...topics } : null),
    send: post,
    // One change's frames. `snapshot(withMock)` is read when a message is about to go, so it is the
    // mock as it is then: `touch(true)` after the mock changed, `touch()` after only the page's state
    // did. The first send waits a moment, so a change made in several steps at once goes as one.
    // `end(last)` sends the last message after whatever is still going, and resolves once it is sent.
    channel(topic, snapshot) {
      let dirty = null, running = null;
      async function pump() {
        await new Promise((ok) => setTimeout(ok, 0));
        while (dirty) {
          const mock = dirty === "frame";
          dirty = null;
          await post(topic, "frame", snapshot(mock));
        }
        running = null;
      }
      return {
        touch(mock = false) {
          dirty = mock || dirty === "frame" ? "frame" : "state";
          running ??= pump();
        },
        async end(last) {
          dirty = null;
          await running;
          await post(topic, "frame", last);
        },
      };
    },
  };
}
