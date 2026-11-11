import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Anomaly } from "./anomaly.ts";
import type { AlertFeedbackRecord } from "./feedback.ts";
import { createAlertFeedbackTokens } from "./feedback.ts";
import {
  getProjectGithubConfig,
  handleProjectGithubRequest,
  normalizeGithubRepo,
} from "./github.ts";
import {
  buildAgentPrompt,
  buildIssueTitle,
  handleInvestigate,
  handleInvestigatePost,
  renderNotFoundHtml,
  renderTokenFormHtml,
} from "./investigate.ts";
import { getTurso, initTursoSchema } from "./turso.ts";

await initTursoSchema();

const testProjectId = "test_investigate_proj";

const sampleAnomaly: Anomaly = {
  projectId: testProjectId,
  eventName: "payment_failed",
  bucket: "2026-06-01T12",
  expected: 2.5,
  actual: 15,
  zScore: 4.8,
  metric: "totalCount",
  detectedAt: "2026-06-01T12:30:00Z",
  trend: "rising",
};

const secondAnomaly: Anomaly = {
  ...sampleAnomaly,
  eventName: "checkout_timeout",
  bucket: "2026-06-01T13",
};

const sampleCounts = {
  payment_failed: [
    { bucket: "2026-06-01T10", count: 2 },
    { bucket: "2026-06-01T11", count: 3 },
    { bucket: "2026-06-01T12", count: 15 },
  ],
  checkout_timeout: [
    { bucket: "2026-06-01T12", count: 1 },
    { bucket: "2026-06-01T13", count: 12 },
  ],
};

const sampleRecord: AlertFeedbackRecord = {
  token: "tok-123",
  projectId: testProjectId,
  eventName: "payment_failed",
  bucket: "2026-06-01T12",
  metric: "totalCount",
  userId: "_",
  expected: 2.5,
  actual: 15,
  zScore: 4.8,
  anomaliesJson: JSON.stringify([sampleAnomaly]),
  historyJson: JSON.stringify({
    counts: [2, 3, 15],
    buckets: sampleCounts.payment_failed,
  }),
  statsJson: JSON.stringify([
    { type: "totalCount", mean: 3, m2: 12, n: 20, lastBucket: "2026-06-01T12" },
  ]),
  rating: null,
  feedbackAt: null,
  createdAt: Date.now(),
};

const cleanupTestData = async () => {
  const res = await getTurso().execute({
    sql: "SELECT token FROM alert_feedback WHERE project_id = ?;",
    args: [testProjectId],
  });
  await Promise.all(
    res.rows.map((row) =>
      getTurso().execute({
        sql: "DELETE FROM alert_github_issues WHERE token = ?;",
        args: [String(row.token)],
      })
    ),
  );
  await getTurso().batch(
    [
      {
        sql: "DELETE FROM alert_feedback WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM project_github WHERE project_id = ?;",
        args: [testProjectId],
      },
    ],
    "write",
  );
};

type CapturedFetch = {
  url: string;
  method: string;
  auth: string;
  body: string;
};

const requestUrl = (input: string | URL | Request): string =>
  input instanceof URL
    ? input.toString()
    : input instanceof Request
    ? input.url
    : input;

const withGithubMock = async <T>(
  responder: (req: CapturedFetch) => Response,
  fn: (calls: CapturedFetch[]) => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  const calls: CapturedFetch[] = [];
  const mock: typeof fetch = (input, init) => {
    const url = requestUrl(input);
    if (!url.startsWith("https://api.github.com/")) {
      return original(input, init);
    }
    const captured: CapturedFetch = {
      url,
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization") ?? "",
      body: init?.body ? String(init.body) : "",
    };
    calls.push(captured);
    return Promise.resolve(responder(captured));
  };
  globalThis.fetch = mock;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
};

Deno.test("normalizeGithubRepo accepts owner/repo and GitHub URLs and rejects invalid values", () => {
  assertEquals(normalizeGithubRepo("acme/payments"), "acme/payments");
  assertEquals(
    normalizeGithubRepo("  https://github.com/acme/payments.service/  "),
    "acme/payments.service",
  );
  assertEquals(
    normalizeGithubRepo("https://github.com/acme/payments.git"),
    "acme/payments",
  );
  assertEquals(normalizeGithubRepo("not-a-repo"), "");
  assertEquals(
    normalizeGithubRepo("https://github.com/acme/payments/issues"),
    "",
  );
});

Deno.test("buildIssueTitle and buildAgentPrompt include structured anomaly context", () => {
  assertEquals(
    buildIssueTitle(sampleRecord),
    "Anomaly in payment_failed: expected 2.5, got 15 (Mon Jun 1, 12pm–1pm UTC)",
  );
  const prompt = buildAgentPrompt(sampleRecord, "payments");
  assertStringIncludes(prompt, "Investigate this Anomalisa anomaly");
  assertStringIncludes(prompt, "Project: payments");
  assertStringIncludes(prompt, "Event: payment_failed");
  assertStringIncludes(prompt, "2026-06-01T12 (Mon Jun 1, 12pm–1pm UTC)");
  assertStringIncludes(prompt, "Expected: 2.5");
  assertStringIncludes(prompt, "Actual: 15");
  assertStringIncludes(prompt, "Z-score: 4.8");
  assertStringIncludes(prompt, "2, 3, 15");
  assertStringIncludes(prompt, "2026-06-01T12: 15");
  assertStringIncludes(prompt, "trend: rising");
  assertStringIncludes(prompt, "Detected at: 2026-06-01T12:30:00Z");
});

Deno.test("renderTokenFormHtml renders token input and escapes untrusted fields", () => {
  const html = renderTokenFormHtml({
    record: { ...sampleRecord, eventName: "<script>alert(1)</script>" },
    projectName: "<b>payments</b>",
    githubRepo: 'acme/"bad"',
    error: "<img src=x onerror=alert(1)>",
    repos: [],
  });
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertEquals(html.includes("<img src=x"), false);
  assertStringIncludes(html, 'name="githubToken"');
  assertStringIncludes(html, "Save token &amp; create issue");
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(html, "&lt;b&gt;payments&lt;/b&gt;");
  assertStringIncludes(html, "&lt;img src=x onerror=alert(1)&gt;");
});

Deno.test("renderNotFoundHtml and handleInvestigate return 404 when alert token is missing or invalid", async () => {
  assertStringIncludes(renderNotFoundHtml(), "Alert Details Not Found");
  const res = await handleInvestigate(
    new URL("https://example.com/investigate?token=non_existent"),
    () => Promise.resolve("payments"),
  );
  assertEquals(res.kind, "html");
  if (res.kind === "html") {
    assertEquals(res.status, 404);
    assertStringIncludes(res.html, "Alert Details Not Found");
  }
});

Deno.test("missing GitHub token flow prompts for token, saves it for project, creates issue, and reuses it on next alert", async () => {
  await cleanupTestData();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly, secondAnomaly],
      sampleCounts,
    );
    const token1 = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];
    const token2 = tokens[`${secondAnomaly.eventName}|${secondAnomaly.bucket}`];

    const getMissing = await handleInvestigate(
      new URL(`https://example.com/investigate?token=${token1}`),
      () => Promise.resolve("payments"),
    );
    assertEquals(getMissing.kind, "html");
    if (getMissing.kind === "html") {
      assertEquals(getMissing.status, 200);
      assertStringIncludes(getMissing.html, "Connect GitHub for payments");
      assertStringIncludes(getMissing.html, 'name="githubToken"');
      assertEquals(getMissing.html.includes("Copy text for agent"), false);
    }

    await withGithubMock(
      ({ url, method }) =>
        method === "GET" && url.includes("/user/repos")
          ? new Response(
            JSON.stringify([{ name: "payments", full_name: "acme/payments" }]),
            { status: 200 },
          )
          : new Response(
            JSON.stringify({
              html_url: "https://github.com/acme/payments/issues/42",
              number: 42,
            }),
            { status: 201 },
          ),
      async (calls) => {
        const postBody = new URLSearchParams({
          token: token1,
          githubToken: "github_pat_secret123",
          githubRepo: "",
        }).toString();
        const created = await handleInvestigatePost(
          postBody,
          () => Promise.resolve("payments"),
        );
        assertEquals(created, {
          kind: "redirect",
          location: "https://github.com/acme/payments/issues/42",
        });
        assertEquals(calls.length, 2);
        assertEquals(calls[0].auth, "Bearer github_pat_secret123");
        assertEquals(
          calls[1].url,
          "https://api.github.com/repos/acme/payments/issues",
        );
        const issuePayload = JSON.parse(calls[1].body);
        assertStringIncludes(issuePayload.title, "Anomaly in payment_failed");
        assertStringIncludes(issuePayload.body, "Project: payments");

        const savedConfig = await getProjectGithubConfig(testProjectId);
        assertEquals(savedConfig, {
          projectId: testProjectId,
          githubToken: "github_pat_secret123",
          githubRepo: "acme/payments",
        });

        const repeatGet = await handleInvestigate(
          new URL(`https://example.com/investigate?token=${token1}`),
          () => Promise.resolve("payments"),
        );
        assertEquals(repeatGet, {
          kind: "redirect",
          location: "https://github.com/acme/payments/issues/42",
        });
        assertEquals(calls.length, 2);
      },
    );

    const getConfigured = await handleInvestigate(
      new URL(`https://example.com/investigate?token=${token2}`),
      () => Promise.resolve("payments"),
    );
    assertEquals(getConfigured.kind, "html");
    if (getConfigured.kind === "html") {
      assertEquals(getConfigured.status, 200);
      assertStringIncludes(getConfigured.html, 'id="auto-create-form"');
      assertStringIncludes(getConfigured.html, "acme/payments");
    }

    await withGithubMock(
      () =>
        new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/payments/issues/43",
            number: 43,
          }),
          { status: 201 },
        ),
      async (calls) => {
        const autoCreated = await handleInvestigatePost(
          new URLSearchParams({ token: token2 }).toString(),
          () => Promise.resolve("payments"),
        );
        assertEquals(autoCreated, {
          kind: "redirect",
          location: "https://github.com/acme/payments/issues/43",
        });
        assertEquals(calls.length, 1);
        assertEquals(calls[0].auth, "Bearer github_pat_secret123");
      },
    );
  } finally {
    await cleanupTestData();
  }
});

Deno.test("handleInvestigatePost prompts for repo selection when token sees multiple non-matching repos and recovers from revoked token", async () => {
  await cleanupTestData();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const token = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];

    await withGithubMock(
      () =>
        new Response(
          JSON.stringify([
            { name: "alpha", full_name: "acme/alpha" },
            { name: "beta", full_name: "acme/beta" },
          ]),
          { status: 200 },
        ),
      async () => {
        const ambiguous = await handleInvestigatePost(
          new URLSearchParams({
            token,
            githubToken: "ghp_multi",
            githubRepo: "",
          }).toString(),
          () => Promise.resolve("unmatched-name"),
        );
        assertEquals(ambiguous.kind, "html");
        if (ambiguous.kind === "html") {
          assertEquals(ambiguous.status, 400);
          assertStringIncludes(ambiguous.html, "Multiple repositories");
          assertStringIncludes(ambiguous.html, '<option value="acme/alpha">');
          assertStringIncludes(ambiguous.html, '<option value="acme/beta">');
        }
      },
    );

    await withGithubMock(
      () =>
        new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
        }),
      async () => {
        const unauthorized = await handleInvestigatePost(
          new URLSearchParams({
            token,
            githubToken: "ghp_expired",
            githubRepo: "acme/alpha",
          }).toString(),
          () => Promise.resolve("alpha"),
        );
        assertEquals(unauthorized.kind, "html");
        if (unauthorized.kind === "html") {
          assertEquals(unauthorized.status, 400);
          assertStringIncludes(
            unauthorized.html,
            "GitHub token is invalid or expired.",
          );
          assertStringIncludes(unauthorized.html, 'value="acme/alpha"');
        }
      },
    );
  } finally {
    await cleanupTestData();
  }
});

Deno.test("handleProjectGithubRequest supports get, set, and delete for dashboard settings", async () => {
  await cleanupTestData();
  const resolveProj = (tok: string) =>
    tok === "proj-secret"
      ? Promise.resolve({ id: testProjectId, name: "payments" })
      : Promise.reject(new Error("Invalid token"));
  try {
    const initial = await handleProjectGithubRequest(
      JSON.stringify({ token: "proj-secret", action: "get" }),
      resolveProj,
    );
    assertEquals(initial, {
      status: 200,
      body: { configured: false, githubRepo: "" },
    });

    await withGithubMock(
      () =>
        new Response(JSON.stringify({ full_name: "acme/payments" }), {
          status: 200,
        }),
      async () => {
        const saved = await handleProjectGithubRequest(
          JSON.stringify({
            token: "proj-secret",
            action: "set",
            githubToken: "github_pat_abc",
            githubRepo: "https://github.com/acme/payments",
          }),
          resolveProj,
        );
        assertEquals(saved, {
          status: 200,
          body: { ok: true, configured: true, githubRepo: "acme/payments" },
        });
      },
    );

    const afterSet = await handleProjectGithubRequest(
      JSON.stringify({ token: "proj-secret", action: "get" }),
      resolveProj,
    );
    assertEquals(afterSet, {
      status: 200,
      body: { configured: true, githubRepo: "acme/payments" },
    });

    const deleted = await handleProjectGithubRequest(
      JSON.stringify({ token: "proj-secret", action: "delete" }),
      resolveProj,
    );
    assertEquals(deleted, {
      status: 200,
      body: { ok: true, configured: false, githubRepo: "" },
    });
  } finally {
    await cleanupTestData();
  }
});
