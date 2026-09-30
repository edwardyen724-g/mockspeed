// store — the web app's projects and usage rows, kept in Supabase (web/db/*.sql).
//
// Every call goes to one of the database's ms_* functions through its REST API, with the project's
// publishable key and the server's own key (MS_SERVER_KEY), which each function checks before it
// does anything. The tables themselves are closed to the outside by row-level security.

export function store({ SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, MS_SERVER_KEY }) {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !MS_SERVER_KEY) throw new Error("the store needs SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and MS_SERVER_KEY");
  async function rpc(fn, args) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "content-type": "application/json" },
      body: JSON.stringify({ k: MS_SERVER_KEY, ...args }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`store ${fn} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    // A project, or null.
    get: async (id) => (await rpc("ms_get", { p_id: id }))[0] ?? null,
    create: async ({ id, owner = null, anon = null, ip = null, state }) => (await rpc("ms_create", { p_id: id, p_owner: owner, p_anon: anon, p_ip: ip, p_state: state }))[0],
    // The new rev, or 0 when another save landed first.
    save: (id, rev, state, title, screens) => rpc("ms_save", { p_id: id, p_rev: rev, p_state: state, p_title: title, p_screens: screens }),
    list: (owner) => rpc("ms_list", { p_owner: owner }),
    remove: (id, owner) => rpc("ms_delete", { p_id: id, p_owner: owner }),
    expect: (anon, email) => rpc("ms_expect", { p_anon: anon, p_email: email }),
    claim: (owner, anon, email) => rpc("ms_claim", { p_owner: owner, p_anon: anon ?? null, p_email: email ?? null }),
    anonBuilds: (ip) => rpc("ms_anon_builds", { p_ip: ip }),
    use: (rows) => (rows.length ? rpc("ms_use", { p_rows: rows }) : 0),
    usage: (since) => rpc("ms_usage", { p_since: since }),
    // Before a change: { plan, changes (the account's today), spend (every call's today, in USD) }.
    gate: async (user) => { const g = (await rpc("ms_gate", { p_user: user ?? null }))[0]; return { plan: g.plan, changes: g.changes, spend: Number(g.spend) }; },
    account: async (user) => (await rpc("ms_account", { p_user: user }))[0] ?? null,
    // What Stripe says of an account's subscription; the plan that makes it ('paid' or 'free').
    setPlan: (user, { customer = null, subscription = null, status }) => rpc("ms_set_plan", { p_user: user, p_customer: customer, p_subscription: subscription, p_status: status }),
    subscriber: (subscription) => rpc("ms_subscriber", { p_subscription: subscription }),
  };
}
