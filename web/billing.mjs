// billing — paying for more changes a day, through Stripe Checkout, and what Stripe tells us after.
//
// The person is sent to a Checkout page Stripe hosts, for a monthly subscription; when they come
// back (/upgrade/done) the server asks Stripe about that Checkout itself and marks the account paid
// at once, without waiting for the webhook. The webhook (/api/stripe) then keeps the plan in step
// with the subscription: renewed, failing, cancelled. Every call is plain fetch against Stripe's
// REST API with STRIPE_SECRET_KEY (a test key, sk_test_…, until the price is set); STRIPE_API may
// point it elsewhere, as the tests do.
//
// The price is STRIPE_PRICE when it names one; else Checkout is given the amount itself
// (PRICE_USD_MONTH), so no product has to be made in Stripe first.

import { createHmac, timingSafeEqual } from "node:crypto";

// Stripe's form encoding: nested keys in brackets.
function form(o, pre = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    const key = pre ? `${pre}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export function billing(env) {
  const secret = env.STRIPE_SECRET_KEY || null;
  const api = (env.STRIPE_API || "https://api.stripe.com").replace(/\/$/, "");
  const dollars = Number(env.PRICE_USD_MONTH || 12);
  async function call(method, path, body) {
    const res = await fetch(`${api}/v1/${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? form(body).toString() : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${j.error?.message ?? ""}`.slice(0, 300));
    return j;
  }
  return {
    ready: Boolean(secret),
    test: Boolean(secret?.startsWith("sk_test_") || secret?.startsWith("rk_test_")),
    dollars,
    // A Checkout for this account: its address. `back` is where on this site they come back to.
    async checkout(user, origin, back, customer = null) {
      const item = env.STRIPE_PRICE ? { price: env.STRIPE_PRICE, quantity: 1 }
        : { quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(dollars * 100), recurring: { interval: "month" }, product_data: { name: "mockspeed" } } };
      const s = await call("POST", "checkout/sessions", {
        mode: "subscription",
        line_items: { 0: item },
        client_reference_id: user.id,
        ...(customer ? { customer } : { customer_email: user.email || undefined }),
        metadata: { user: user.id },
        subscription_data: { metadata: { user: user.id } },
        success_url: `${origin}/upgrade/done?s={CHECKOUT_SESSION_ID}&back=${encodeURIComponent(back)}`,
        cancel_url: `${origin}${back}`,
      });
      return s.url;
    },
    // A finished Checkout: whose it is and its subscription, as Stripe says; null when not paid.
    async finished(id) {
      const s = await call("GET", `checkout/sessions/${encodeURIComponent(id)}?expand[]=subscription`);
      if (s.status !== "complete" || !s.client_reference_id) return null;
      const sub = s.subscription;
      return { user: s.client_reference_id, customer: s.customer, subscription: sub?.id ?? sub ?? null, status: sub?.status ?? (s.payment_status === "paid" ? "active" : "incomplete") };
    },
    // Stripe's page where a paying person changes their card or cancels.
    async portal(customer, back) {
      return (await call("POST", "billing_portal/sessions", { customer, return_url: back })).url;
    },
    // A webhook's event, once its signature (Stripe-Signature: t=…,v1=…) is checked against
    // STRIPE_WEBHOOK_SECRET; null when it isn't Stripe's, or is over five minutes old.
    event(raw, header) {
      const key = env.STRIPE_WEBHOOK_SECRET;
      if (!key || !header) return null;
      const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((p) => p.length === 2 && p[0] !== "v1"));
      const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
      const t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > 300) return null;
      const want = Buffer.from(createHmac("sha256", key).update(`${t}.${raw}`).digest("hex"));
      if (!sigs.some((s) => { const got = Buffer.from(s); return got.length === want.length && timingSafeEqual(got, want); })) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
  };
}

// The same signature Stripe puts on a webhook, for the tests.
export function signed(raw, key, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${raw}`).digest("hex")}`;
}
