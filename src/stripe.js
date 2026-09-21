// Minimal Stripe integration via plain REST calls + fetch, since the
// official stripe-node SDK isn't built for the Workers runtime.

async function stripeRequest(env, method, path, params) {
  const body = params ? new URLSearchParams(params).toString() : undefined;
  const resp = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Stripe error: ${data.error?.message || resp.status}`);
  return data;
}

export async function createCustomer(env, email) {
  return stripeRequest(env, "POST", "/customers", { email });
}

export async function createCheckoutSession(env, { customerId, priceId, successUrl, cancelUrl, userId, plan }) {
  return stripeRequest(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[userId]": String(userId),
    "metadata[plan]": plan,
  });
}

// Verifies Stripe's webhook signature manually using Web Crypto HMAC-SHA256,
// following Stripe's documented scheme (t=timestamp,v1=signature).
export async function verifyStripeSignature(payload, signatureHeader, secret) {
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const signedPayload = `${parts.t}.${payload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return expected === parts.v1;
}
