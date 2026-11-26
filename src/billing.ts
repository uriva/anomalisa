import { context } from "@uri/inject";
import { empty, filter, map, nonempty, pipe, reduce } from "gamla";
import { z } from "zod/v4";
import type { ProjectWithOwner } from "./db.ts";
import { getTurso } from "./turso.ts";

export type Plan = "free" | "pro";

export const stripeProductTag = "anomalisa";
export const proPriceMonthlyUsd = 15;
export const proPriceMonthlyCents = 1500;
export const planLimits: Record<Plan, number> = {
  free: 100_000,
  pro: 1_000_000,
};
export const maxTeamAlertEmails = 10;
export const quotaExceededErrorName = "QuotaExceededError";
export const proFeatureRequiredError =
  "Pro plan ($15/mo) required for this feature. Upgrade at https://anomalisa.uriv.me/app";

const grandfatheredEmails = new Set(["uri.valevski@gmail.com"]);
const activeSubscriptionStatuses = new Set(["active", "trialing", "past_due"]);
const defaultAppUrl = "https://anomalisa.uriv.me";
const stripeSignatureToleranceSeconds = 300;

export const {
  inject: injectStripeFetch,
  access: stripeFetch,
} = context(
  (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
);

export type UserSubscription = {
  userId: string;
  email: string;
  plan: Plan;
  status: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
};

export type BillingStatus = {
  plan: Plan;
  status: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  grandfathered: boolean;
  monthlyEventCount: number;
  monthlyEventLimit: number;
  proPriceMonthlyUsd: number;
  features: {
    teamEmails: boolean;
    signedWebhooks: boolean;
    autoGithubIssues: boolean;
  };
};

export type QuotaCheckResult = {
  allowed: boolean;
  plan: Plan;
  count: number;
  limit: number;
  monthBucket: string;
};

export type ProjectAlertSettings = {
  alertEmails: string[];
  webhookSecret: string;
};

const stripeSecretKey = () => Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const stripeWebhookSecret = () => Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const stripeProPriceId = () => Deno.env.get("STRIPE_PRO_PRICE_ID") ?? "";

const normalizePlan = (raw: string | undefined): Plan =>
  raw === "pro" ? "pro" : "free";

const isGrandfatheredEmail = (email: string): boolean =>
  grandfatheredEmails.has(email.trim().toLowerCase());

const isAllowedOrigin = (raw: string): boolean => {
  try {
    const parsed = new URL(raw);
    return parsed.origin === new URL(defaultAppUrl).origin ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
};

const appOrigin = (candidate?: string): string =>
  candidate && isAllowedOrigin(candidate) ? candidate : defaultAppUrl;

export const extractBearerToken = (req: Request): string => {
  const header = req.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

export const currentMonthBucket = (nowMs = Date.now()): string =>
  new Date(nowMs).toISOString().slice(0, 7);

export const makeQuotaExceededError = (
  plan: Plan,
  limit: number,
): Error =>
  Object.assign(
    new Error(
      `Monthly event limit of ${limit.toLocaleString("en-US")} reached for ${plan} plan.${
        plan === "free"
          ? ` Upgrade to Pro ($${proPriceMonthlyUsd}/mo) at ${defaultAppUrl}/app for ${
            planLimits.pro.toLocaleString("en-US")
          } events/month.`
          : ""
      }`,
    ),
    { name: quotaExceededErrorName },
  );

const parseJsonSafe = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const stripeErrorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

const stripeCheckoutResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
});

const stripePortalResponseSchema = z.object({
  url: z.string(),
});

const stripeExpandedSubSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  current_period_end: z.number().optional(),
  cancel_at_period_end: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const stripeCheckoutSessionSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  payment_status: z.string().optional(),
  customer: z.string().nullable().optional(),
  customer_email: z.string().nullable().optional(),
  client_reference_id: z.string().nullable().optional(),
  subscription: z.union([z.string(), stripeExpandedSubSchema]).nullable()
    .optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const stripeWebhookEventSchema = z.object({
  type: z.string(),
  data: z.object({
    object: z.record(z.string(), z.unknown()),
  }).optional(),
});

const stripeSubscriptionEventObjSchema = z.object({
  id: z.string().optional(),
  customer: z.string().nullable().optional(),
  status: z.string().optional(),
  current_period_end: z.number().optional(),
  cancel_at_period_end: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const stripeInvoiceEventObjSchema = z.object({
  subscription: z.string().nullable().optional(),
  customer: z.string().nullable().optional(),
  subscription_details: z.object({
    metadata: z.record(z.string(), z.string()).optional(),
  }).optional(),
  parent: z.object({
    subscription_details: z.object({
      metadata: z.record(z.string(), z.string()).optional(),
    }).optional(),
  }).optional(),
});

const stripeRequest = async (
  method: "GET" | "POST",
  path: string,
  formParams?: URLSearchParams,
): Promise<Record<string, unknown>> => {
  const key = stripeSecretKey();
  if (!key) {
    throw new Error("Stripe billing is not configured on this server.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...(method === "POST" && formParams
      ? { "Content-Type": "application/x-www-form-urlencoded" }
      : {}),
  };
  const res = await stripeFetch(`https://api.stripe.com${path}`, {
    method,
    headers,
    body: method === "POST" && formParams ? formParams.toString() : undefined,
  });
  const text = await res.text();
  const parsed = parseJsonSafe(text);
  if (!res.ok) {
    const errParsed = stripeErrorSchema.safeParse(parsed);
    const errMsg = errParsed.success && errParsed.data.error?.message
      ? errParsed.data.error.message
      : text || `Stripe HTTP ${res.status}`;
    throw new Error(`Stripe error: ${errMsg}`);
  }
  return parsed ?? {};
};

const rowToSubscription = (
  row: Record<string, unknown>,
): UserSubscription => ({
  userId: String(row.user_id),
  email: String(row.email),
  plan: normalizePlan(String(row.plan)),
  status: String(row.status),
  stripeCustomerId: row.stripe_customer_id
    ? String(row.stripe_customer_id)
    : undefined,
  stripeSubscriptionId: row.stripe_subscription_id
    ? String(row.stripe_subscription_id)
    : undefined,
  currentPeriodEnd: row.current_period_end != null
    ? Number(row.current_period_end)
    : undefined,
  cancelAtPeriodEnd: Number(row.cancel_at_period_end ?? 0) === 1,
});

export const getUserSubscription = async (
  userId: string,
): Promise<UserSubscription | null> => {
  const res = await getTurso().execute({
    sql: `SELECT user_id, email, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end
          FROM user_subscriptions WHERE user_id = ?;`,
    args: [userId],
  });
  return empty(res.rows) ? null : rowToSubscription(res.rows[0]);
};

export const getSubscriptionByStripeIds = async ({
  stripeSubscriptionId,
  stripeCustomerId,
}: {
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
}): Promise<UserSubscription | null> => {
  if (stripeSubscriptionId) {
    const bySub = await getTurso().execute({
      sql: `SELECT user_id, email, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end
            FROM user_subscriptions WHERE stripe_subscription_id = ? LIMIT 1;`,
      args: [stripeSubscriptionId],
    });
    if (nonempty(bySub.rows)) return rowToSubscription(bySub.rows[0]);
  }
  if (stripeCustomerId) {
    const byCust = await getTurso().execute({
      sql: `SELECT user_id, email, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end
            FROM user_subscriptions WHERE stripe_customer_id = ? LIMIT 1;`,
      args: [stripeCustomerId],
    });
    if (nonempty(byCust.rows)) return rowToSubscription(byCust.rows[0]);
  }
  return null;
};

export const upsertUserSubscription = async ({
  userId,
  email,
  plan,
  status,
  stripeCustomerId,
  stripeSubscriptionId,
  currentPeriodEnd,
  cancelAtPeriodEnd,
}: {
  userId: string;
  email: string;
  plan: Plan;
  status: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
}): Promise<void> => {
  await getTurso().execute({
    sql: `INSERT INTO user_subscriptions (
            user_id, email, plan, status, stripe_customer_id, stripe_subscription_id,
            current_period_end, cancel_at_period_end, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (user_id) DO UPDATE SET
            email = CASE WHEN excluded.email != '' THEN excluded.email ELSE user_subscriptions.email END,
            plan = excluded.plan,
            status = excluded.status,
            stripe_customer_id = COALESCE(excluded.stripe_customer_id, user_subscriptions.stripe_customer_id),
            stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, user_subscriptions.stripe_subscription_id),
            current_period_end = COALESCE(excluded.current_period_end, user_subscriptions.current_period_end),
            cancel_at_period_end = excluded.cancel_at_period_end,
            updated_at = excluded.updated_at;`,
    args: [
      userId,
      email,
      plan,
      status,
      stripeCustomerId ?? null,
      stripeSubscriptionId ?? null,
      currentPeriodEnd ?? null,
      cancelAtPeriodEnd ? 1 : 0,
      Date.now(),
    ],
  });
};

export const resolveEffectivePlan = async (
  userId: string,
  email: string,
): Promise<Plan> => {
  if (isGrandfatheredEmail(email)) return "pro";
  const sub = await getUserSubscription(userId);
  return sub && activeSubscriptionStatuses.has(sub.status) && sub.plan === "pro"
    ? "pro"
    : "free";
};

export const getMonthlyEventCount = async (
  userId: string,
  monthBucket = currentMonthBucket(),
): Promise<number> => {
  const res = await getTurso().execute({
    sql: `SELECT count FROM monthly_usage WHERE user_id = ? AND month_bucket = ?;`,
    args: [userId, monthBucket],
  });
  return empty(res.rows) ? 0 : Number(res.rows[0].count);
};

export const incrementAndCheckMonthlyQuota = async (
  userId: string,
  email: string,
  nowMs = Date.now(),
): Promise<QuotaCheckResult> => {
  const monthBucket = currentMonthBucket(nowMs);
  const [plan, currentCount] = await Promise.all([
    resolveEffectivePlan(userId, email),
    getMonthlyEventCount(userId, monthBucket),
  ]);
  const limit = planLimits[plan];
  if (currentCount >= limit) {
    return { allowed: false, plan, count: currentCount, limit, monthBucket };
  }
  await getTurso().execute({
    sql: `INSERT INTO monthly_usage (user_id, month_bucket, count, updated_at)
          VALUES (?, ?, 1, ?)
          ON CONFLICT (user_id, month_bucket)
          DO UPDATE SET count = count + 1, updated_at = excluded.updated_at;`,
    args: [userId, monthBucket, nowMs],
  });
  return {
    allowed: true,
    plan,
    count: currentCount + 1,
    limit,
    monthBucket,
  };
};

export const getBillingStatus = async (
  userId: string,
  email: string,
): Promise<BillingStatus> => {
  const [sub, monthlyEventCount] = await Promise.all([
    getUserSubscription(userId),
    getMonthlyEventCount(userId).catch(() => 0),
  ]);
  const grandfathered = isGrandfatheredEmail(email);
  const plan: Plan = grandfathered ||
      (sub !== null && activeSubscriptionStatuses.has(sub.status) &&
        sub.plan === "pro")
    ? "pro"
    : "free";
  const isPro = plan === "pro";
  return {
    plan,
    status: grandfathered ? "active" : (sub?.status ?? "free"),
    ...(sub?.currentPeriodEnd ? { currentPeriodEnd: sub.currentPeriodEnd } : {}),
    cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
    hasStripeCustomer: Boolean(sub?.stripeCustomerId),
    grandfathered,
    monthlyEventCount,
    monthlyEventLimit: planLimits[plan],
    proPriceMonthlyUsd,
    features: {
      teamEmails: isPro,
      signedWebhooks: isPro,
      autoGithubIssues: isPro,
    },
  };
};

export const createCheckoutSession = async ({
  userId,
  email,
  origin,
}: {
  userId: string;
  email: string;
  origin?: string;
}): Promise<{ url: string; sessionId: string }> => {
  const existing = await getUserSubscription(userId);
  const baseUrl = appOrigin(origin);
  const priceId = stripeProPriceId();
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set(
    "success_url",
    `${baseUrl}/app?billing=success&session_id={CHECKOUT_SESSION_ID}`,
  );
  params.set("cancel_url", `${baseUrl}/app?billing=cancelled`);
  params.set("allow_promotion_codes", "true");
  params.set("client_reference_id", userId);
  params.set("line_items[0][quantity]", "1");
  if (priceId) {
    params.set("line_items[0][price]", priceId);
  } else {
    params.set("line_items[0][price_data][currency]", "usd");
    params.set(
      "line_items[0][price_data][unit_amount]",
      String(proPriceMonthlyCents),
    );
    params.set("line_items[0][price_data][recurring][interval]", "month");
    params.set("line_items[0][price_data][product_data][name]", "Anomalisa Pro");
    params.set(
      "line_items[0][price_data][product_data][description]",
      "1,000,000 events/month, team multi-email alerts, signed webhooks with retries, and automated AI GitHub issue investigation.",
    );
    params.set(
      "line_items[0][price_data][product_data][metadata][product]",
      stripeProductTag,
    );
  }
  params.set("metadata[product]", stripeProductTag);
  params.set("metadata[userId]", userId);
  params.set("metadata[email]", email);
  params.set("metadata[plan]", "pro");
  params.set("subscription_data[metadata][product]", stripeProductTag);
  params.set("subscription_data[metadata][userId]", userId);
  params.set("subscription_data[metadata][email]", email);
  params.set("subscription_data[metadata][plan]", "pro");
  if (existing?.stripeCustomerId) {
    params.set("customer", existing.stripeCustomerId);
  } else {
    params.set("customer_email", email);
  }
  const raw = await stripeRequest("POST", "/v1/checkout/sessions", params);
  const parsed = stripeCheckoutResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Stripe Checkout session did not return a redirect URL");
  }
  return { url: parsed.data.url, sessionId: parsed.data.id };
};

export const createBillingPortalSession = async ({
  userId,
  origin,
}: {
  userId: string;
  origin?: string;
}): Promise<{ url: string }> => {
  const existing = await getUserSubscription(userId);
  if (!existing?.stripeCustomerId) {
    throw new Error("No active Stripe billing profile found for this account");
  }
  const params = new URLSearchParams();
  params.set("customer", existing.stripeCustomerId);
  params.set("return_url", `${appOrigin(origin)}/app`);
  const raw = await stripeRequest("POST", "/v1/billing_portal/sessions", params);
  const parsed = stripePortalResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Stripe Billing Portal did not return a redirect URL");
  }
  return { url: parsed.data.url };
};

export const syncCheckoutSession = async ({
  userId,
  email,
  sessionId,
}: {
  userId: string;
  email: string;
  sessionId: string;
}): Promise<BillingStatus> => {
  if (!sessionId.startsWith("cs_")) {
    throw new Error("Invalid Checkout Session ID");
  }
  const raw = await stripeRequest(
    "GET",
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
  );
  const parsed = stripeCheckoutSessionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Unexpected Stripe Checkout session payload");
  }
  const session = parsed.data;
  if (session.metadata?.product !== stripeProductTag) {
    throw new Error("Checkout session does not belong to Anomalisa");
  }
  if (
    session.metadata?.userId !== userId &&
    session.client_reference_id !== userId
  ) {
    throw new Error("Checkout session does not belong to this user");
  }
  const expanded = typeof session.subscription === "object" &&
      session.subscription !== null
    ? session.subscription
    : null;
  const stripeSubscriptionId = typeof session.subscription === "string"
    ? session.subscription
    : expanded?.id;
  const status = expanded?.status ?? "active";
  const currentPeriodEnd = expanded?.current_period_end
    ? expanded.current_period_end * 1000
    : undefined;
  const cancelAtPeriodEnd = Boolean(expanded?.cancel_at_period_end);
  if (
    session.payment_status === "paid" ||
    session.status === "complete" ||
    activeSubscriptionStatuses.has(status)
  ) {
    await upsertUserSubscription({
      userId,
      email,
      plan: activeSubscriptionStatuses.has(status) ? "pro" : "free",
      status,
      stripeCustomerId: session.customer ?? undefined,
      stripeSubscriptionId,
      currentPeriodEnd,
      cancelAtPeriodEnd,
    });
  }
  return getBillingStatus(userId, email);
};

const constantTimeEqualHex = (a: string, b: string): boolean =>
  a.length === b.length &&
  reduce(
    (diff: number, [ca, cb]: [number, number]) => diff | (ca ^ cb),
    () => 0,
  )(
    Array.from({ length: a.length }, (_, i): [number, number] => [
      a.charCodeAt(i),
      b.charCodeAt(i),
    ]),
  ) === 0;

const parseSignatureHeader = (sigHeader: string) => {
  const pairs = pipe(
    map((part: string) => part.trim().split("=", 2)),
    filter((pair: string[]) => pair.length === 2),
  )(sigHeader.split(","));
  const timestampEntry = pairs.find(([k]) => k === "t");
  const timestamp = timestampEntry ? Number(timestampEntry[1]) : NaN;
  const signatures = pipe(
    filter(([k, v]: string[]) => k === "v1" && Boolean(v)),
    map(([, v]: string[]) => v.toLowerCase()),
  )(pairs);
  return { timestamp, signatures };
};

export const hmacSha256Hex = async (
  secret: string,
  message: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

export const verifyStripeSignature = async (
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> => {
  if (!sigHeader || !secret) return false;
  const { timestamp, signatures } = parseSignatureHeader(sigHeader);
  if (!Number.isFinite(timestamp) || empty(signatures)) return false;
  if (Math.abs(nowSeconds - timestamp) > stripeSignatureToleranceSeconds) {
    return false;
  }
  const expectedHex = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => constantTimeEqualHex(sig, expectedHex));
};

const handleCheckoutCompleted = async (
  obj: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const parsed = stripeCheckoutSessionSchema.safeParse(obj);
  if (!parsed.success || parsed.data.metadata?.product !== stripeProductTag) {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const session = parsed.data;
  const userId = session.metadata?.userId ?? session.client_reference_id ?? "";
  if (!userId) return { status: 200, body: { ok: true, ignored: true } };
  const email = session.metadata?.email ?? session.customer_email ?? "";
  const stripeSubscriptionId = typeof session.subscription === "string"
    ? session.subscription
    : session.subscription?.id;
  await upsertUserSubscription({
    userId,
    email,
    plan: "pro",
    status: "active",
    stripeCustomerId: session.customer ?? undefined,
    stripeSubscriptionId,
    cancelAtPeriodEnd: false,
  });
  return { status: 200, body: { ok: true } };
};

const handleSubscriptionEvent = async (
  eventType: string,
  obj: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const parsed = stripeSubscriptionEventObjSchema.safeParse(obj);
  if (!parsed.success) return { status: 200, body: { ok: true, ignored: true } };
  const sub = parsed.data;
  const stripeSubscriptionId = sub.id;
  const stripeCustomerId = sub.customer ?? undefined;
  const isTagged = sub.metadata?.product === stripeProductTag;
  const existing = !isTagged || !sub.metadata?.userId
    ? await getSubscriptionByStripeIds({
      stripeSubscriptionId,
      stripeCustomerId,
    })
    : null;
  if (!isTagged && !existing) {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const userId = sub.metadata?.userId ?? existing?.userId ?? "";
  if (!userId) return { status: 200, body: { ok: true, ignored: true } };
  const status = eventType === "customer.subscription.deleted"
    ? "canceled"
    : (sub.status ?? "active");
  const plan: Plan = activeSubscriptionStatuses.has(status) ? "pro" : "free";
  await upsertUserSubscription({
    userId,
    email: sub.metadata?.email ?? existing?.email ?? "",
    plan,
    status,
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodEnd: sub.current_period_end
      ? sub.current_period_end * 1000
      : undefined,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  });
  return { status: 200, body: { ok: true } };
};

const handleInvoicePaymentFailed = async (
  obj: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const parsed = stripeInvoiceEventObjSchema.safeParse(obj);
  if (!parsed.success) return { status: 200, body: { ok: true, ignored: true } };
  const invoice = parsed.data;
  const stripeSubscriptionId = invoice.subscription ?? undefined;
  const stripeCustomerId = invoice.customer ?? undefined;
  const meta = invoice.subscription_details?.metadata ??
    invoice.parent?.subscription_details?.metadata;
  const existing = await getSubscriptionByStripeIds({
    stripeSubscriptionId,
    stripeCustomerId,
  });
  if (!existing && meta?.product !== stripeProductTag) {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const userId = existing?.userId ?? meta?.userId ?? "";
  if (!userId) return { status: 200, body: { ok: true, ignored: true } };
  await upsertUserSubscription({
    userId,
    email: existing?.email ?? meta?.email ?? "",
    plan: existing?.plan ?? "pro",
    status: "past_due",
    stripeCustomerId,
    stripeSubscriptionId,
    currentPeriodEnd: existing?.currentPeriodEnd,
    cancelAtPeriodEnd: existing?.cancelAtPeriodEnd,
  });
  return { status: 200, body: { ok: true } };
};

export const handleStripeWebhook = async (
  rawBody: string,
  sigHeader: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const secret = stripeWebhookSecret();
  if (!secret) {
    return {
      status: 500,
      body: { error: "Stripe webhook secret is not configured" },
    };
  }
  if (!(await verifyStripeSignature(rawBody, sigHeader, secret))) {
    return { status: 400, body: { error: "Invalid Stripe signature" } };
  }
  const parsedEvent = stripeWebhookEventSchema.safeParse(parseJsonSafe(rawBody));
  if (!parsedEvent.success) {
    return { status: 400, body: { error: "Invalid JSON payload" } };
  }
  const { type, data } = parsedEvent.data;
  if (!data?.object) return { status: 200, body: { ok: true, ignored: true } };
  if (type === "checkout.session.completed") {
    return handleCheckoutCompleted(data.object);
  }
  if (
    type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted"
  ) {
    return handleSubscriptionEvent(type, data.object);
  }
  if (type === "invoice.payment_failed") {
    return handleInvoicePaymentFailed(data.object);
  }
  return { status: 200, body: { ok: true, ignored: true } };
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const parseAlertEmails = (raw: string[] | string): string[] => {
  const items = Array.isArray(raw) ? raw : raw.split(/[\s,;]+/);
  return [
    ...new Set(
      pipe(
        map((s: string) => s.trim().toLowerCase()),
        filter((s: string) => emailPattern.test(s)),
      )(items),
    ),
  ].slice(0, maxTeamAlertEmails);
};

const storedAlertEmailsSchema = z.array(z.string());

export const getProjectAlertSettings = async (
  projectId: string,
): Promise<ProjectAlertSettings> => {
  const res = await getTurso().execute({
    sql: `SELECT alert_emails, webhook_secret FROM project_alert_settings WHERE project_id = ?;`,
    args: [projectId],
  });
  if (empty(res.rows)) return { alertEmails: [], webhookSecret: "" };
  const parsed = storedAlertEmailsSchema.safeParse(
    parseJsonSafe(String(res.rows[0].alert_emails)),
  );
  return {
    alertEmails: parsed.success ? parseAlertEmails(parsed.data) : [],
    webhookSecret: String(res.rows[0].webhook_secret ?? ""),
  };
};

export const saveProjectAlertSettings = async (
  projectId: string,
  { alertEmails, webhookSecret }: ProjectAlertSettings,
): Promise<void> => {
  await getTurso().execute({
    sql: `INSERT INTO project_alert_settings (project_id, alert_emails, webhook_secret, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (project_id)
          DO UPDATE SET alert_emails = excluded.alert_emails,
                        webhook_secret = excluded.webhook_secret,
                        updated_at = excluded.updated_at;`,
    args: [
      projectId,
      JSON.stringify(parseAlertEmails(alertEmails)),
      webhookSecret.trim(),
      Date.now(),
    ],
  });
};

const projectSettingsBodySchema = z.discriminatedUnion("action", [
  z.object({ token: z.string(), action: z.literal("get") }),
  z.object({
    token: z.string(),
    action: z.literal("set"),
    alertEmails: z.union([z.array(z.string()), z.string()]).optional(),
    webhookSecret: z.string().optional(),
  }),
]);

export const handleProjectSettingsRequest = async (
  bodyText: string,
  resolveProject: (token: string) => Promise<ProjectWithOwner>,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const parsed = projectSettingsBodySchema.safeParse(parseJsonSafe(bodyText));
  if (!parsed.success) return { status: 400, body: { error: "Invalid request" } };
  const project = await resolveProject(parsed.data.token).catch(() => null);
  if (!project) return { status: 400, body: { error: "Invalid token" } };
  const isPro =
    (await resolveEffectivePlan(project.owner.id, project.owner.email)) ===
      "pro";
  if (parsed.data.action === "get") {
    const settings = await getProjectAlertSettings(project.id);
    return { status: 200, body: { ...settings, isPro } };
  }
  const existing = await getProjectAlertSettings(project.id);
  const nextEmails = parsed.data.alertEmails !== undefined
    ? parseAlertEmails(parsed.data.alertEmails)
    : existing.alertEmails;
  const nextSecret = parsed.data.webhookSecret !== undefined
    ? parsed.data.webhookSecret.trim()
    : existing.webhookSecret;
  if (!isPro && (nonempty(nextEmails) || Boolean(nextSecret))) {
    return { status: 403, body: { error: proFeatureRequiredError } };
  }
  await saveProjectAlertSettings(project.id, {
    alertEmails: nextEmails,
    webhookSecret: nextSecret,
  });
  return {
    status: 200,
    body: {
      ok: true,
      alertEmails: nextEmails,
      webhookSecret: nextSecret,
      isPro,
    },
  };
};
