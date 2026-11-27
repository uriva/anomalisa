import { assertEquals, assertStringIncludes } from "@std/assert";
import { injectDecisionModel } from "@uriv/chaff";
import { pipe } from "gamla";
import type { Anomaly } from "./anomaly.ts";
import {
  currentMonthBucket,
  getBillingStatus,
  getUserSubscription,
  handleProjectSettingsRequest,
  hmacSha256Hex,
  incrementAndCheckMonthlyQuota,
  injectStripeFetch,
  planLimits,
  proFeatureRequiredError,
  stripeProductTag,
  upsertUserSubscription,
  verifyStripeSignature,
} from "./billing.ts";
import { injectVerifyUserToken, type ProjectWithOwner } from "./db.ts";
import { injectEmailFetch, sendAnomalyAlerts } from "./email.ts";
import { injectGithubFetch, saveProjectGithubConfig } from "./github.ts";
import { httpHandler } from "./server.ts";
import { getTurso, initTursoSchema } from "./turso.ts";
import { injectWebhookFetch, sendWebhook } from "./webhook.ts";

await initTursoSchema();

const testUserId = "test_billing_user_001";
const testEmail = "billing-test@example.com";
const testProjectId = "test_billing_project_001";
const testWebhookSecret = "whsec_test_anomalisa_secret";

const cleanupBillingTestData = async () => {
  const feedbackRows = await getTurso().execute({
    sql: "SELECT token FROM alert_feedback WHERE project_id = ?;",
    args: [testProjectId],
  });
  await Promise.all(
    feedbackRows.rows.map((row) =>
      getTurso().execute({
        sql: "DELETE FROM alert_github_issues WHERE token = ?;",
        args: [String(row.token)],
      })
    ),
  );
  await getTurso().batch(
    [
      {
        sql: "DELETE FROM user_subscriptions WHERE user_id = ?;",
        args: [testUserId],
      },
      {
        sql: "DELETE FROM monthly_usage WHERE user_id = ?;",
        args: [testUserId],
      },
      {
        sql: "DELETE FROM project_alert_settings WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM project_github WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM alert_feedback WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM email_rate_limits WHERE to_email = ?;",
        args: [testEmail],
      },
    ],
    "write",
  );
};

const makeStripeSig = async (
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
) => `t=${timestamp},v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;

const withEnv = async (
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
) => {
  const prev = Object.fromEntries(
    Object.keys(vars).map((k) => [k, Deno.env.get(k)]),
  );
  Object.entries(vars).forEach(([k, v]) =>
    v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
  );
  try {
    await fn();
  } finally {
    Object.entries(prev).forEach(([k, v]) =>
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
    );
  }
};

Deno.test("billing endpoints require auth and create Stripe checkout, sync, and portal sessions", async () => {
  await cleanupBillingTestData();
  const stripeCalls: { url: string; method: string; body: string }[] = [];

  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_anomalisa",
      STRIPE_PRO_PRICE_ID: "price_anomalisa_pro_15",
    },
    async () => {
      await pipe(
        injectVerifyUserToken((token) =>
          Promise.resolve(
            token === "valid-user-token"
              ? { id: testUserId, email: testEmail }
              : null,
          )
        ),
        injectStripeFetch((url, init) => {
          const method = init?.method ?? "GET";
          const body = init?.body ? String(init.body) : "";
          stripeCalls.push({ url, method, body });
          if (url.endsWith("/v1/checkout/sessions") && method === "POST") {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  id: "cs_test_anomalisa_123",
                  url: "https://checkout.stripe.com/c/pay/cs_test_anomalisa_123",
                }),
                { status: 200 },
              ),
            );
          }
          if (url.includes("/v1/checkout/sessions/cs_test_anomalisa_123")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  id: "cs_test_anomalisa_123",
                  status: "complete",
                  payment_status: "paid",
                  customer: "cus_anomalisa_1",
                  metadata: {
                    product: stripeProductTag,
                    userId: testUserId,
                    email: testEmail,
                    plan: "pro",
                  },
                  subscription: {
                    id: "sub_anomalisa_1",
                    status: "active",
                    current_period_end: 1800000000,
                    cancel_at_period_end: false,
                  },
                }),
                { status: 200 },
              ),
            );
          }
          if (
            url.endsWith("/v1/billing_portal/sessions") && method === "POST"
          ) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  url: "https://billing.stripe.com/p/session/test_portal",
                }),
                { status: 200 },
              ),
            );
          }
          return Promise.resolve(new Response("{}", { status: 404 }));
        }),
      )(async () => {
        const unauthRes = await httpHandler(
          new Request("https://anomalisa.uriv.me/api/billing/checkout", {
            method: "POST",
          }),
        );
        assertEquals(unauthRes.status, 401);

        const statusFreeRes = await httpHandler(
          new Request("https://anomalisa.uriv.me/api/billing/status", {
            method: "GET",
            headers: { Authorization: "Bearer valid-user-token" },
          }),
        );
        assertEquals(statusFreeRes.status, 200);
        const statusFree = await statusFreeRes.json();
        assertEquals(statusFree.plan, "free");
        assertEquals(statusFree.monthlyEventLimit, planLimits.free);
        assertEquals(statusFree.features, {
          teamEmails: false,
          signedWebhooks: false,
          autoGithubIssues: false,
        });

        const checkoutRes = await httpHandler(
          new Request("https://anomalisa.uriv.me/api/billing/checkout", {
            method: "POST",
            headers: { Authorization: "Bearer valid-user-token" },
          }),
        );
        assertEquals(checkoutRes.status, 200);
        const checkoutData = await checkoutRes.json();
        assertEquals(
          checkoutData.url,
          "https://checkout.stripe.com/c/pay/cs_test_anomalisa_123",
        );
        const checkoutParams = new URLSearchParams(stripeCalls[0].body);
        assertEquals(
          checkoutParams.get("line_items[0][price]"),
          "price_anomalisa_pro_15",
        );
        assertEquals(checkoutParams.get("metadata[product]"), stripeProductTag);
        assertEquals(checkoutParams.get("metadata[userId]"), testUserId);

        const syncRes = await httpHandler(
          new Request("https://anomalisa.uriv.me/api/billing/sync", {
            method: "POST",
            headers: {
              Authorization: "Bearer valid-user-token",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ sessionId: "cs_test_anomalisa_123" }),
          }),
        );
        assertEquals(syncRes.status, 200);
        const synced = await syncRes.json();
        assertEquals(synced.plan, "pro");
        assertEquals(synced.monthlyEventLimit, planLimits.pro);
        assertEquals(synced.hasStripeCustomer, true);
        assertEquals(synced.features, {
          teamEmails: true,
          signedWebhooks: true,
          autoGithubIssues: true,
        });

        const portalRes = await httpHandler(
          new Request("https://anomalisa.uriv.me/api/billing/portal", {
            method: "POST",
            headers: { Authorization: "Bearer valid-user-token" },
          }),
        );
        assertEquals(portalRes.status, 200);
        const portalData = await portalRes.json();
        assertEquals(
          portalData.url,
          "https://billing.stripe.com/p/session/test_portal",
        );
      })();
    },
  );
  await cleanupBillingTestData();
});

Deno.test("Stripe webhook verifies HMAC signature, ignores unrelated products, and syncs subscription lifecycle", async () => {
  await cleanupBillingTestData();

  await withEnv({ STRIPE_WEBHOOK_SECRET: testWebhookSecret }, async () => {
    const staleSig = await makeStripeSig(
      "{}",
      testWebhookSecret,
      Math.floor(Date.now() / 1000) - 600,
    );
    assertEquals(
      await verifyStripeSignature("{}", staleSig, testWebhookSecret),
      false,
    );

    const badSigRes = await httpHandler(
      new Request("https://anomalisa.uriv.me/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": "t=123,v1=deadbeef" },
        body: "{}",
      }),
    );
    assertEquals(badSigRes.status, 400);

    const unrelatedBody = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_other",
          customer: "cus_other",
          subscription: "sub_other",
          metadata: { product: "other-app", userId: testUserId },
        },
      },
    });
    const unrelatedRes = await httpHandler(
      new Request("https://anomalisa.uriv.me/api/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": await makeStripeSig(
            unrelatedBody,
            testWebhookSecret,
          ),
        },
        body: unrelatedBody,
      }),
    );
    assertEquals(unrelatedRes.status, 200);
    assertEquals((await unrelatedRes.json()).ignored, true);
    assertEquals(await getUserSubscription(testUserId), null);

    const completedBody = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_live_1",
          customer: "cus_live_1",
          subscription: "sub_live_1",
          metadata: {
            product: stripeProductTag,
            userId: testUserId,
            email: testEmail,
            plan: "pro",
          },
        },
      },
    });
    const completedRes = await httpHandler(
      new Request("https://anomalisa.uriv.me/api/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": await makeStripeSig(
            completedBody,
            testWebhookSecret,
          ),
        },
        body: completedBody,
      }),
    );
    assertEquals(completedRes.status, 200);
    const afterComplete = await getUserSubscription(testUserId);
    assertEquals(afterComplete?.plan, "pro");
    assertEquals(afterComplete?.stripeCustomerId, "cus_live_1");
    assertEquals(afterComplete?.stripeSubscriptionId, "sub_live_1");

    const updatedBody = JSON.stringify({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_live_1",
          customer: "cus_live_1",
          status: "active",
          current_period_end: 1850000000,
          cancel_at_period_end: true,
        },
      },
    });
    const updatedRes = await httpHandler(
      new Request("https://anomalisa.uriv.me/api/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": await makeStripeSig(
            updatedBody,
            testWebhookSecret,
          ),
        },
        body: updatedBody,
      }),
    );
    assertEquals(updatedRes.status, 200);
    const afterUpdate = await getUserSubscription(testUserId);
    assertEquals(afterUpdate?.currentPeriodEnd, 1850000000 * 1000);
    assertEquals(afterUpdate?.cancelAtPeriodEnd, true);

    const deletedBody = JSON.stringify({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_live_1",
          customer: "cus_live_1",
          status: "canceled",
        },
      },
    });
    const deletedRes = await httpHandler(
      new Request("https://anomalisa.uriv.me/api/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": await makeStripeSig(
            deletedBody,
            testWebhookSecret,
          ),
        },
        body: deletedBody,
      }),
    );
    assertEquals(deletedRes.status, 200);
    const afterDelete = await getBillingStatus(testUserId, testEmail);
    assertEquals(afterDelete.plan, "free");
    assertEquals(afterDelete.status, "canceled");
  });

  await cleanupBillingTestData();
});

Deno.test("monthly quota enforces 100k events/mo on Free and 1M events/mo on Pro", async () => {
  await cleanupBillingTestData();
  const month = currentMonthBucket();

  await getTurso().execute({
    sql: `INSERT INTO monthly_usage (user_id, month_bucket, count, updated_at) VALUES (?, ?, ?, ?);`,
    args: [testUserId, month, planLimits.free - 1, Date.now()],
  });

  const allowedFree = await incrementAndCheckMonthlyQuota(
    testUserId,
    testEmail,
  );
  assertEquals(allowedFree.allowed, true);
  assertEquals(allowedFree.count, planLimits.free);
  assertEquals(allowedFree.limit, planLimits.free);

  const blockedFree = await incrementAndCheckMonthlyQuota(
    testUserId,
    testEmail,
  );
  assertEquals(blockedFree.allowed, false);
  assertEquals(blockedFree.plan, "free");
  assertEquals(blockedFree.limit, planLimits.free);

  await upsertUserSubscription({
    userId: testUserId,
    email: testEmail,
    plan: "pro",
    status: "active",
    stripeCustomerId: "cus_quota_1",
    stripeSubscriptionId: "sub_quota_1",
  });

  const allowedPro = await incrementAndCheckMonthlyQuota(testUserId, testEmail);
  assertEquals(allowedPro.allowed, true);
  assertEquals(allowedPro.plan, "pro");
  assertEquals(allowedPro.count, planLimits.free + 1);
  assertEquals(allowedPro.limit, planLimits.pro);

  await getTurso().execute({
    sql: `UPDATE monthly_usage SET count = ? WHERE user_id = ? AND month_bucket = ?;`,
    args: [planLimits.pro, testUserId, month],
  });
  const blockedPro = await incrementAndCheckMonthlyQuota(testUserId, testEmail);
  assertEquals(blockedPro.allowed, false);
  assertEquals(blockedPro.plan, "pro");
  assertEquals(blockedPro.limit, planLimits.pro);

  await cleanupBillingTestData();
});

Deno.test("Pro feature gating restricts team emails, signed webhooks with retries, and automated AI GitHub issues", async () => {
  await cleanupBillingTestData();

  const mockProject: ProjectWithOwner = {
    id: testProjectId,
    name: "billing-proj",
    token: "tok-billing-1",
    owner: { id: testUserId, email: testEmail },
  };
  const resolveMockProject = () => Promise.resolve(mockProject);

  const freeEmailAttempt = await handleProjectSettingsRequest(
    JSON.stringify({
      token: mockProject.token,
      action: "set",
      alertEmails: ["teammate@example.com"],
    }),
    resolveMockProject,
  );
  assertEquals(freeEmailAttempt.status, 403);
  assertEquals(freeEmailAttempt.body.error, proFeatureRequiredError);

  const freeWebhookAttempt = await handleProjectSettingsRequest(
    JSON.stringify({
      token: mockProject.token,
      action: "set",
      webhookSecret: "whsec_my_secret",
    }),
    resolveMockProject,
  );
  assertEquals(freeWebhookAttempt.status, 403);

  await upsertUserSubscription({
    userId: testUserId,
    email: testEmail,
    plan: "pro",
    status: "active",
  });

  const proSave = await handleProjectSettingsRequest(
    JSON.stringify({
      token: mockProject.token,
      action: "set",
      alertEmails: ["teammate@example.com", "oncall@example.com"],
      webhookSecret: "whsec_my_secret",
    }),
    resolveMockProject,
  );
  assertEquals(proSave.status, 200);
  assertEquals(proSave.body.alertEmails, [
    "teammate@example.com",
    "oncall@example.com",
  ]);
  assertEquals(proSave.body.webhookSecret, "whsec_my_secret");

  await saveProjectGithubConfig({
    projectId: testProjectId,
    githubToken: "ghp_test",
    githubRepo: "acme/app",
  });

  const anomaly: Anomaly = {
    projectId: testProjectId,
    eventName: "payment_failed",
    bucket: "2026-07-01T10",
    expected: 0.2,
    actual: 30,
    zScore: 15,
    metric: "totalCount",
    detectedAt: "2026-07-01T10:15:00Z",
  };

  const sentEmails: { to: string[]; subject: string }[] = [];
  const githubCalls: string[] = [];

  await pipe(
    injectDecisionModel((_s, q) =>
      Promise.resolve(
        Object.fromEntries(
          Object.keys(q).map((k) => [k, { type: "noul", noul: 0.95 }]),
        ),
      )
    ),
    injectGithubFetch((url) => {
      githubCalls.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/app/issues/7",
            number: 7,
          }),
          { status: 201 },
        ),
      );
    }),
    injectEmailFetch((_url, init) => {
      sentEmails.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(new Response("OK", { status: 200 }));
    }),
  )(async () => {
    await sendAnomalyAlerts(
      testEmail,
      "billing-proj",
      [anomaly],
      undefined,
      undefined,
      { enableAutoGithubIssues: false },
    );
    assertEquals(githubCalls.length, 0);
    assertEquals(sentEmails[0].to, [testEmail]);

    await sendAnomalyAlerts(
      testEmail,
      "billing-proj",
      [{ ...anomaly, bucket: "2026-07-01T11" }],
      undefined,
      undefined,
      {
        extraEmails: ["teammate@example.com", "oncall@example.com"],
        enableAutoGithubIssues: true,
      },
    );
    assertEquals(githubCalls.length, 1);
    assertEquals(sentEmails[1].to, [
      testEmail,
      "teammate@example.com",
      "oncall@example.com",
    ]);
    assertStringIncludes(sentEmails[1].subject, "GitHub issue #7 opened");
  })();

  const webhookCalls: { sig: string | null; body: string }[] = [];
  await injectWebhookFetch((_url, init) => {
    const headers = new Headers(init?.headers);
    webhookCalls.push({
      sig: headers.get("x-anomalisa-signature"),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(
      new Response(webhookCalls.length === 1 ? "fail" : "ok", {
        status: webhookCalls.length === 1 ? 500 : 200,
      }),
    );
  })(async () => {
    await sendWebhook("https://hooks.example.com/alerts", anomaly, {
      secret: "whsec_my_secret",
      retries: 2,
      retryDelayMs: 5,
      timestampSeconds: 1700000000,
    });
  })();

  assertEquals(webhookCalls.length, 2);
  const expectedSig = `t=1700000000,v1=${
    await hmacSha256Hex(
      "whsec_my_secret",
      `1700000000.${JSON.stringify(anomaly)}`,
    )
  }`;
  assertEquals(webhookCalls[0].sig, expectedSig);
  assertEquals(webhookCalls[1].sig, expectedSig);

  await cleanupBillingTestData();
});

Deno.test("checkout sync does not upgrade unpaid, open, expired, or unexpanded sessions to Pro", async () => {
  await cleanupBillingTestData();

  await withEnv(
    {
      STRIPE_SECRET_KEY: "sk_test_mock",
      STRIPE_PRO_PRICE_ID: "price_anomalisa_pro_15",
      APP_BASE_URL: "https://anomalisa.uriv.me",
    },
    async () => {
      const sessionCases = [
        {
          id: "cs_test_unpaid_open",
          status: "open",
          payment_status: "unpaid",
          customer: null,
          client_reference_id: testUserId,
          subscription: null,
          metadata: { product: stripeProductTag, userId: testUserId },
        },
        {
          id: "cs_test_unpaid_expired",
          status: "expired",
          payment_status: "unpaid",
          customer: "cus_unpaid_1",
          client_reference_id: testUserId,
          subscription: "sub_unexpanded_unpaid",
          metadata: { product: stripeProductTag, userId: testUserId },
        },
        {
          id: "cs_test_incomplete",
          status: "complete",
          payment_status: "unpaid",
          customer: "cus_incomplete_1",
          client_reference_id: testUserId,
          subscription: { id: "sub_incomplete_1", status: "incomplete" },
          metadata: { product: stripeProductTag, userId: testUserId },
        },
      ];

      await pipe(
        injectVerifyUserToken((token) =>
          Promise.resolve(
            token === "valid-user-token"
              ? { id: testUserId, email: testEmail }
              : null,
          )
        ),
        injectStripeFetch((url) => {
          const match = sessionCases.find((c) => url.includes(c.id));
          return Promise.resolve(
            match
              ? new Response(JSON.stringify(match), { status: 200 })
              : new Response("{}", { status: 404 }),
          );
        }),
      )(async () => {
        await sessionCases.reduce(
          async (prev, sessionCase) => {
            await prev;
            const syncRes = await httpHandler(
              new Request("https://anomalisa.uriv.me/api/billing/sync", {
                method: "POST",
                headers: {
                  Authorization: "Bearer valid-user-token",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ sessionId: sessionCase.id }),
              }),
            );
            assertEquals(syncRes.status, 200);
            const synced = await syncRes.json();
            assertEquals(synced.plan, "free");
            assertEquals(synced.monthlyEventLimit, planLimits.free);
            assertEquals(synced.features.teamEmails, false);
          },
          Promise.resolve(),
        );
      })();
    },
  );

  await cleanupBillingTestData();
});

Deno.test("grandfathered accounts bypass monthly_usage writes and quota cap", async () => {
  const grandfatheredUserId = "test_grandfathered_user_001";
  const grandfatheredEmail = "uri.valevski@gmail.com";
  const month = currentMonthBucket();
  const cleanup = () =>
    getTurso().execute({
      sql: "DELETE FROM monthly_usage WHERE user_id = ?;",
      args: [grandfatheredUserId],
    });

  await cleanup();
  try {
    const first = await incrementAndCheckMonthlyQuota(
      grandfatheredUserId,
      grandfatheredEmail,
    );
    assertEquals(first.allowed, true);
    assertEquals(first.plan, "pro");

    const rowsAfterFirst = await getTurso().execute({
      sql:
        "SELECT count FROM monthly_usage WHERE user_id = ? AND month_bucket = ?;",
      args: [grandfatheredUserId, month],
    });
    assertEquals(rowsAfterFirst.rows.length, 0);

    await getTurso().execute({
      sql:
        "INSERT INTO monthly_usage (user_id, month_bucket, count, updated_at) VALUES (?, ?, ?, ?);",
      args: [grandfatheredUserId, month, planLimits.pro, Date.now()],
    });
    const aboveCap = await incrementAndCheckMonthlyQuota(
      grandfatheredUserId,
      grandfatheredEmail,
    );
    assertEquals(aboveCap.allowed, true);
    assertEquals(aboveCap.plan, "pro");
  } finally {
    await cleanup();
  }
});
