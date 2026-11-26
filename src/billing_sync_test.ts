import { assertEquals } from "@std/assert";
import { resolveCheckoutSyncPlan } from "./billing.ts";

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
