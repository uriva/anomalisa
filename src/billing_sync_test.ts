import { assertEquals } from "@std/assert";
import { pipe } from "gamla";
import {
  type AnalyticsProperties,
  injectCaptureServerEvent,
} from "./analytics.ts";
import {
  type BillingStatus,
  createCheckoutSession,
  handleStripeWebhook,
  hmacSha256Hex,
  injectGetBillingStatus,
  injectGetUserSubscription,
  injectRecordAdminNotificationOnce,
  injectStripeFetch,
  injectUpsertUserSubscription,
  resolveCheckoutSyncPlan,
  syncCheckoutSession,
} from "./billing.ts";

Deno.test("resolveCheckoutSyncPlan rejects unpaid, open, expired, or unexpanded sessions", () => {
  assertEquals(
    resolveCheckoutSyncPlan({
      id: "cs_open_null",
      status: "open",
      payment_status: "unpaid",
      subscription: null,
    }).shouldUpsert,
    false,
  );

  assertEquals(
    resolveCheckoutSyncPlan({
      id: "cs_expired_unexpanded",
      status: "expired",
      payment_status: "unpaid",
      subscription: "sub_unexpanded",
    }).shouldUpsert,
    false,
  );

  assertEquals(
    resolveCheckoutSyncPlan({
      id: "cs_incomplete",
      status: "complete",
      payment_status: "unpaid",
      subscription: { id: "sub_inc", status: "incomplete" },
    }).shouldUpsert,
    false,
  );

  assertEquals(
    resolveCheckoutSyncPlan({
      id: "cs_missing_sub_status",
      status: "open",
      payment_status: "unpaid",
      subscription: { id: "sub_empty" },
    }).shouldUpsert,
    false,
  );
});

Deno.test("resolveCheckoutSyncPlan upgrades paid or verified active/trialing sessions to Pro", () => {
  const paidExpanded = resolveCheckoutSyncPlan({
    id: "cs_paid_active",
    status: "complete",
    payment_status: "paid",
    subscription: {
      id: "sub_active",
      status: "active",
      current_period_end: 1800000000,
      cancel_at_period_end: false,
    },
  });
  assertEquals(paidExpanded.shouldUpsert, true);
  assertEquals(paidExpanded.plan, "pro");
  assertEquals(paidExpanded.status, "active");
  assertEquals(paidExpanded.stripeSubscriptionId, "sub_active");
  assertEquals(paidExpanded.currentPeriodEnd, 1800000000 * 1000);

  const trialing = resolveCheckoutSyncPlan({
    id: "cs_trial",
    status: "complete",
    payment_status: "no_payment_required",
    subscription: { id: "sub_trial", status: "trialing" },
  });
  assertEquals(trialing.shouldUpsert, true);
  assertEquals(trialing.plan, "pro");
  assertEquals(trialing.status, "trialing");

  const paidUnexpanded = resolveCheckoutSyncPlan({
    id: "cs_paid_unexpanded",
    status: "complete",
    payment_status: "paid",
    subscription: "sub_paid_str",
  });
  assertEquals(paidUnexpanded.shouldUpsert, true);
  assertEquals(paidUnexpanded.plan, "pro");
  assertEquals(paidUnexpanded.status, "active");
  assertEquals(paidUnexpanded.stripeSubscriptionId, "sub_paid_str");

  const paidCanceled = resolveCheckoutSyncPlan({
    id: "cs_paid_canceled",
    status: "complete",
    payment_status: "paid",
    subscription: { id: "sub_canceled", status: "canceled" },
  });
  assertEquals(paidCanceled.shouldUpsert, true);
  assertEquals(paidCanceled.plan, "free");
  assertEquals(paidCanceled.status, "canceled");
});

type CapturedEvent = {
  distinctId: string;
  event: string;
  properties?: AnalyticsProperties;
};

const fakeProBillingStatus: BillingStatus = {
  plan: "pro",
  status: "active",
  cancelAtPeriodEnd: false,
  hasStripeCustomer: true,
  grandfathered: false,
  monthlyEventCount: 0,
  monthlyEventLimit: 1_000_000,
  proPriceMonthlyUsd: 15,
  features: {
    teamEmails: true,
    signedWebhooks: true,
    autoGithubIssues: true,
  },
};

const makeCheckoutSessionPayload = (sessionId: string) => ({
  id: sessionId,
  status: "complete",
  payment_status: "paid",
  customer: "cus_123",
  customer_email: "bob@example.com",
  client_reference_id: "user_2",
  subscription: {
    id: "sub_123",
    status: "active",
    current_period_end: 1800000000,
    cancel_at_period_end: false,
  },
  metadata: {
    product: "anomalisa",
    userId: "user_2",
    email: "bob@example.com",
    plan: "pro",
  },
});

const restoreEnv = (key: string, prev: string | undefined) => {
  if (prev !== undefined) {
    Deno.env.set(key, prev);
  } else {
    Deno.env.delete(key);
  }
};

Deno.test("createCheckoutSession emits checkout_started server event", async () => {
  const prevStripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_123");
  const events: CapturedEvent[] = [];
  try {
    const result = await pipe(
      injectGetUserSubscription(() => Promise.resolve(null)),
      injectStripeFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "cs_test_start_1",
              url: "https://checkout.stripe.com/c/pay/cs_test_start_1",
            }),
            { status: 200 },
          ),
        )
      ),
      injectCaptureServerEvent((distinctId, event, properties) => {
        events.push({ distinctId, event, properties });
        return Promise.resolve();
      }),
    )(() =>
      createCheckoutSession({
        userId: "user_1",
        email: "alice@example.com",
      })
    )();
    assertEquals(result, {
      url: "https://checkout.stripe.com/c/pay/cs_test_start_1",
      sessionId: "cs_test_start_1",
    });
    assertEquals(events, [
      {
        distinctId: "alice@example.com",
        event: "checkout_started",
        properties: {
          sessionId: "cs_test_start_1",
          userId: "user_1",
          plan: "pro",
        },
      },
    ]);
  } finally {
    restoreEnv("STRIPE_SECRET_KEY", prevStripeKey);
  }
});

Deno.test("syncCheckoutSession and handleStripeWebhook emit deduplicated pro_upgraded once", async () => {
  const prevStripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const prevWebhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  Deno.env.set("STRIPE_SECRET_KEY", "sk_test_123");
  Deno.env.set("STRIPE_WEBHOOK_SECRET", "whsec_test_123");
  const seenKeys = new Set<string>();
  const events: CapturedEvent[] = [];
  const recordOnce = (key: string): Promise<boolean> => {
    if (seenKeys.has(key)) return Promise.resolve(false);
    seenKeys.add(key);
    return Promise.resolve(true);
  };
  const captureRecorder = (
    distinctId: string,
    event: string,
    properties?: AnalyticsProperties,
  ): Promise<void> => {
    events.push({ distinctId, event, properties });
    return Promise.resolve();
  };
  try {
    const syncStatus = await pipe(
      injectStripeFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(makeCheckoutSessionPayload("cs_test_upgrade_1")),
            { status: 200 },
          ),
        )
      ),
      injectUpsertUserSubscription(() => Promise.resolve()),
      injectGetBillingStatus(() => Promise.resolve(fakeProBillingStatus)),
      injectRecordAdminNotificationOnce(recordOnce),
      injectCaptureServerEvent(captureRecorder),
    )(() =>
      syncCheckoutSession({
        userId: "user_2",
        email: "bob@example.com",
        sessionId: "cs_test_upgrade_1",
      })
    )();
    assertEquals(syncStatus.plan, "pro");
    assertEquals(events, [
      {
        distinctId: "bob@example.com",
        event: "pro_upgraded",
        properties: {
          sessionId: "cs_test_upgrade_1",
          source: "checkout_sync",
        },
      },
    ]);

    const rawBody1 = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: makeCheckoutSessionPayload("cs_test_upgrade_1") },
    });
    const ts1 = Math.floor(Date.now() / 1000);
    const sig1 = await hmacSha256Hex("whsec_test_123", `${ts1}.${rawBody1}`);
    const webhookRes1 = await pipe(
      injectUpsertUserSubscription(() => Promise.resolve()),
      injectRecordAdminNotificationOnce(recordOnce),
      injectCaptureServerEvent(captureRecorder),
    )(() => handleStripeWebhook(rawBody1, `t=${ts1},v1=${sig1}`))();
    assertEquals(webhookRes1, { status: 200, body: { ok: true } });
    assertEquals(events.length, 1);

    const rawBody2 = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: makeCheckoutSessionPayload("cs_test_upgrade_2") },
    });
    const ts2 = Math.floor(Date.now() / 1000);
    const sig2 = await hmacSha256Hex("whsec_test_123", `${ts2}.${rawBody2}`);
    const webhookRes2 = await pipe(
      injectUpsertUserSubscription(() => Promise.resolve()),
      injectRecordAdminNotificationOnce(recordOnce),
      injectCaptureServerEvent(captureRecorder),
    )(() => handleStripeWebhook(rawBody2, `t=${ts2},v1=${sig2}`))();
    assertEquals(webhookRes2, { status: 200, body: { ok: true } });
    assertEquals(events[1], {
      distinctId: "bob@example.com",
      event: "pro_upgraded",
      properties: {
        sessionId: "cs_test_upgrade_2",
        source: "stripe_webhook",
      },
    });

    await pipe(
      injectStripeFetch(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(makeCheckoutSessionPayload("cs_test_upgrade_2")),
            { status: 200 },
          ),
        )
      ),
      injectUpsertUserSubscription(() => Promise.resolve()),
      injectGetBillingStatus(() => Promise.resolve(fakeProBillingStatus)),
      injectRecordAdminNotificationOnce(recordOnce),
      injectCaptureServerEvent(captureRecorder),
    )(() =>
      syncCheckoutSession({
        userId: "user_2",
        email: "bob@example.com",
        sessionId: "cs_test_upgrade_2",
      })
    )();
    assertEquals(events.length, 2);
  } finally {
    restoreEnv("STRIPE_SECRET_KEY", prevStripeKey);
    restoreEnv("STRIPE_WEBHOOK_SECRET", prevWebhookSecret);
  }
});
