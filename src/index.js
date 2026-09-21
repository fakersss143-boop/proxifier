import { Hono } from "hono";
import { sign, verify } from "hono/jwt";
import { hashPassword, verifyPassword } from "./crypto.js";
import { pickProxy } from "./webshare.js";
import { createCustomer, createCheckoutSession, verifyStripeSignature } from "./stripe.js";
import { generateWifiProxyProfile } from "./mobileconfig.js";

const app = new Hono();

const PLAN_LIMITS = {
  free: { maxConcurrent: 1, chooseCountry: false },
  basic: { maxConcurrent: 3, chooseCountry: false },
  pro: { maxConcurrent: 10, chooseCountry: true },
};

// ---------- auth middleware ----------
async function requireAuth(c, next) {
  const authHeader = c.req.header("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return c.json({ error: "Missing auth token" }, 401);

  try {
    const payload = await verify(token, c.env.JWT_SECRET);
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

async function requireActiveSubscription(c, next) {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    "SELECT subscription_status, plan FROM users WHERE id = ?"
  )
    .bind(user.id)
    .first();
  if (!row || (row.subscription_status !== "active" && row.plan !== "free")) {
    return c.json({ error: "Active subscription required" }, 402);
  }
  await next();
}

// ---------- auth routes ----------
app.post("/auth/register", async (c) => {
  const { email, password } = await c.req.json();
  if (!email || !password || password.length < 8) {
    return c.json({ error: "Valid email and password (8+ chars) required" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ error: "Email already registered" }, 409);

  const { hash, salt } = await hashPassword(password);
  const result = await c.env.DB.prepare(
    "INSERT INTO users (email, password_hash, password_salt) VALUES (?, ?, ?)"
  )
    .bind(email, hash, salt)
    .run();

  const userId = result.meta.last_row_id;
  const token = await sign({ id: userId, email, plan: "free" }, c.env.JWT_SECRET);
  return c.json({ token, user: { id: userId, email, plan: "free" } }, 201);
});

app.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json();
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  if (!user) return c.json({ error: "Invalid credentials" }, 401);

  const valid = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!valid) return c.json({ error: "Invalid credentials" }, 401);

  const token = await sign({ id: user.id, email: user.email, plan: user.plan }, c.env.JWT_SECRET);
  return c.json({ token, user: { id: user.id, email: user.email, plan: user.plan } });
});

// ---------- billing routes ----------
app.post("/billing/checkout", requireAuth, async (c) => {
  const { plan } = await c.req.json(); // "basic" | "pro"
  const priceId = plan === "basic" ? c.env.STRIPE_PRICE_ID_BASIC : c.env.STRIPE_PRICE_ID_PRO;
  if (!priceId) return c.json({ error: "Unknown plan" }, 400);

  const authUser = c.get("user");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(authUser.id).first();

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await createCustomer(c.env, user.email);
    customerId = customer.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?")
      .bind(customerId, user.id)
      .run();
  }

  const appUrl = c.env.APP_URL || new URL(c.req.url).origin;
  const session = await createCheckoutSession(c.env, {
    customerId,
    priceId,
    successUrl: `${appUrl}/billing/success`,
    cancelUrl: `${appUrl}/billing/cancel`,
    userId: user.id,
    plan,
  });

  return c.json({ url: session.url });
});

app.post("/billing/webhook", async (c) => {
  const payload = await c.req.text();
  const signature = c.req.header("stripe-signature") || "";

  const valid = await verifyStripeSignature(payload, signature, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return c.json({ error: "Invalid signature" }, 400);

  const event = JSON.parse(payload);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = Number(session.metadata.userId);
    const plan = session.metadata.plan;
    await c.env.DB.prepare(
      "UPDATE users SET plan = ?, subscription_status = 'active', stripe_subscription_id = ? WHERE id = ?"
    )
      .bind(plan, session.subscription, userId)
      .run();
  } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object;
    await c.env.DB.prepare("UPDATE users SET subscription_status = ? WHERE stripe_subscription_id = ?")
      .bind(sub.status, sub.id)
      .run();
  }

  return c.json({ received: true });
});

// ---------- proxy routes ----------
app.post("/proxy/assign", requireAuth, requireActiveSubscription, async (c) => {
  const authUser = c.get("user");
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(authUser.id).first();
  const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;

  const { count } = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM proxy_assignments WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
  )
    .bind(user.id)
    .first();

  if (count >= limits.maxConcurrent) {
    return c.json({ error: `Plan limit reached (${limits.maxConcurrent} concurrent proxies for ${user.plan})` }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const countryCode = limits.chooseCountry ? body.countryCode : undefined;

  try {
    const proxy = await pickProxy(c.env, { countryCode });

    const result = await c.env.DB.prepare(
      `INSERT INTO proxy_assignments
       (user_id, proxy_address, proxy_port, proxy_username, proxy_password, country_code, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+1 hour'))`
    )
      .bind(user.id, proxy.address, proxy.port, proxy.username, proxy.password, proxy.countryCode)
      .run();

    return c.json(
      {
        assignmentId: result.meta.last_row_id,
        proxy,
        expiresInSeconds: 3600,
      },
      201
    );
  } catch (err) {
    return c.json({ error: "Could not assign a proxy right now", detail: String(err) }, 502);
  }
});

app.get("/proxy/mine", requireAuth, async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    "SELECT id, proxy_address, proxy_port, country_code, assigned_at, expires_at FROM proxy_assignments WHERE user_id = ? ORDER BY assigned_at DESC LIMIT 20"
  )
    .bind(user.id)
    .all();
  return c.json({ assignments: results });
});

// Generates an installable .mobileconfig for a given assignment, scoped to
// one Wi-Fi network (see README for why this can't be device-wide on a
// regular, non-supervised iPhone).
// Query params: assignmentId (required), ssid (required), wifiPassword (optional)
app.get("/proxy/profile", requireAuth, async (c) => {
  const user = c.get("user");
  const assignmentId = c.req.query("assignmentId");
  const ssid = c.req.query("ssid");
  const wifiPassword = c.req.query("wifiPassword");

  if (!assignmentId || !ssid) {
    return c.json({ error: "assignmentId and ssid query params are required" }, 400);
  }

  const assignment = await c.env.DB.prepare(
    "SELECT * FROM proxy_assignments WHERE id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
  )
    .bind(assignmentId, user.id)
    .first();

  if (!assignment) {
    return c.json({ error: "Assignment not found, not yours, or expired" }, 404);
  }

  const xml = generateWifiProxyProfile({
    ssid,
    wifiPassword,
    proxyHost: assignment.proxy_address,
    proxyPort: assignment.proxy_port,
    proxyUsername: assignment.proxy_username,
    proxyPassword: assignment.proxy_password,
    displayName: `VPN Proxy (${ssid})`,
  });

  return new Response(xml, {
    headers: {
      "Content-Type": "application/x-apple-aspen-config",
      "Content-Disposition": 'attachment; filename="proxy.mobileconfig"',
    },
  });
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
