import { assertEquals, assertStringIncludes } from "@std/assert";
import { injectDecisionModel } from "@uriv/chaff";
import { pipe } from "gamla";
import type { Anomaly } from "./anomaly.ts";
import { decideAutoGithubIssues } from "./autoIssue.ts";
import {
  autoOpenedGithubIssueLabel,
  createGithubIssueLabel,
  injectEmailFetch,
  sendAnomalyAlerts,
  subjectGithubIssueOpenedSuffix,
  viewGithubIssueLabel,
} from "./email.ts";
import type { AlertFeedbackRecord } from "./feedback.ts";
import { injectGithubFetch, saveProjectGithubConfig } from "./github.ts";
import { handleInvestigate } from "./investigate.ts";
import { getTurso, initTursoSchema } from "./turso.ts";

await initTursoSchema();

const testProjectId = "test_auto_issue_proj";

const makeRecord = (
  overrides: Partial<AlertFeedbackRecord> & {
    token: string;
    eventName: string;
  },
): AlertFeedbackRecord => ({
  projectId: testProjectId,
  bucket: "2026-06-01T14",
  metric: "totalCount",
  userId: "_",
  expected: 1,
  actual: 20,
  zScore: 8.5,
  anomaliesJson: "[]",
  historyJson: JSON.stringify({ counts: [1, 1, 0, 2, 1, 20] }),
  statsJson: null,
  rating: null,
  feedbackAt: null,
  createdAt: 1780000000000,
  ...overrides,
});

const cleanupAutoIssueTestData = async () => {
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
      {
        sql: "DELETE FROM email_rate_limits WHERE to_email LIKE 'auto-test-%';",
        args: [],
      },
    ],
    "write",
  );
};

type CapturedEmail = {
  to: string[];
  subject: string;
  html: string;
  text: string;
};

type CapturedGithubCall = {
  url: string;
  method: string;
  body: string;
};

const makeEmailRecorder =
  (inbox: CapturedEmail[]) =>
  (_url: string, init?: RequestInit): Promise<Response> => {
    inbox.push(JSON.parse(init?.body ? String(init.body) : "{}"));
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

const makeGithubRecorder = (
  calls: CapturedGithubCall[],
  responder: (call: CapturedGithubCall) => Response,
) =>
(url: string, init?: RequestInit): Promise<Response> => {
  const call: CapturedGithubCall = {
    url,
    method: init?.method ?? "GET",
    body: init?.body ? String(init.body) : "",
  };
  calls.push(call);
  return Promise.resolve(responder(call));
};

Deno.test(
  "decideAutoGithubIssues (live chaff decision model) opens issues for errors and full outages while skipping healthy usage, partial dips, error drops, and guardrails",
  async () => {
    const errorSpike = makeRecord({
      token: "t-err",
      eventName: "payment_failed",
      metric: "totalCount",
      expected: 0.4,
      actual: 45,
      zScore: 28.4,
      historyJson: JSON.stringify({ counts: [0, 1, 0, 0, 1, 45] }),
    });
    const fullOutage = makeRecord({
      token: "t-outage",
      eventName: "search_performed",
      metric: "percentageDrop",
      expected: 38.5,
      actual: 0,
      zScore: 1,
      historyJson: JSON.stringify({ counts: [40, 36, 42, 39, 35, 0] }),
    });
    const healthyUserSpike = makeRecord({
      token: "t-chat",
      eventName: "chat_message",
      metric: "userSpike",
      userId: "user_42",
      expected: 4.5,
      actual: 19,
      zScore: 3.7,
      historyJson: JSON.stringify({ counts: [4, 5, 3, 6, 5, 19] }),
    });
    const offPeakDip = makeRecord({
      token: "t-dip",
      eventName: "agent_run",
      bucket: "2026-06-01T03",
      metric: "percentageDrop",
      expected: 44.2,
      actual: 9,
      zScore: 0.8,
      historyJson: JSON.stringify({ counts: [48, 42, 30, 18, 12, 9] }),
    });
    const errorDropToZero = makeRecord({
      token: "t-err-drop",
      eventName: "api_submit_failure",
      metric: "percentageDrop",
      expected: 120,
      actual: 0,
      zScore: 1,
      historyJson: JSON.stringify({ counts: [110, 130, 125, 115, 0] }),
    });
    const quotaGuardrail = makeRecord({
      token: "t-quota",
      eventName: "Quota Exceeded",
      metric: "totalCount",
      expected: 0.5,
      actual: 25,
      zScore: 18.2,
      historyJson: JSON.stringify({ counts: [0, 1, 0, 1, 0, 25] }),
    });

    const [
      errSelected,
      outageSelected,
      chatSelected,
      dipSelected,
      errDropSelected,
      quotaSelected,
    ] = await Promise.all([
      decideAutoGithubIssues({
        projectName: "payments",
        records: [errorSpike],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "search-app",
        records: [fullOutage],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "chat-app",
        records: [healthyUserSpike],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "agent-app",
        records: [offPeakDip],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "ingest-app",
        records: [errorDropToZero],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "billing-app",
        records: [quotaGuardrail],
        recentIssues: [],
      }),
    ]);

    assertEquals(errSelected.map(({ token }) => token), ["t-err"]);
    assertEquals(outageSelected.map(({ token }) => token), ["t-outage"]);
    assertEquals(chatSelected, []);
    assertEquals(dipSelected, []);
    assertEquals(errDropSelected, []);
    assertEquals(quotaSelected, []);
  },
);

Deno.test(
  "decideAutoGithubIssues (live chaff decision model) deduplicates multi-alert incident batches and recent 24h issues",
  async () => {
    const genericError = makeRecord({
      token: "t-generic",
      eventName: "unhandled_rejection",
      expected: 0.05,
      actual: 12,
      zScore: 16.4,
    });
    const detailedError = makeRecord({
      token: "t-detailed",
      eventName:
        "unhandled_rejection: TypeError: Cannot read properties of undefined (reading 'id')",
      expected: 0.02,
      actual: 12,
      zScore: 22.1,
    });

    const [dedupedBatch, suppressedByRecent] = await Promise.all([
      decideAutoGithubIssues({
        projectName: "webapp",
        records: [genericError, detailedError],
        recentIssues: [],
      }),
      decideAutoGithubIssues({
        projectName: "webapp",
        records: [detailedError],
        recentIssues: [
          {
            eventName: detailedError.eventName,
            bucket: "2026-06-01T12",
            issueNumber: 51,
            issueUrl: "https://github.com/acme/webapp/issues/51",
          },
        ],
      }),
    ]);

    assertEquals(dedupedBatch.map(({ token }) => token), ["t-detailed"]);
    assertEquals(suppressedByRecent, []);
  },
);

Deno.test(
  "sendAnomalyAlerts auto-opens GitHub issue when decision model approves and reflects it in email subject, HTML, text, and /investigate",
  async () => {
    await cleanupAutoIssueTestData();
    await saveProjectGithubConfig({
      projectId: testProjectId,
      githubToken: "ghp_test_token",
      githubRepo: "acme/payments",
    });

    const anomaly: Anomaly = {
      projectId: testProjectId,
      eventName: "payment_failed",
      bucket: "2026-06-01T15",
      expected: 1.2,
      actual: 34,
      zScore: 12.4,
      metric: "totalCount",
      detectedAt: "2026-06-01T15:20:00Z",
    };

    const emails: CapturedEmail[] = [];
    const githubCalls: CapturedGithubCall[] = [];
    const issueUrl = "https://github.com/acme/payments/issues/88";

    await pipe(
      injectDecisionModel((_state, questions) =>
        Promise.resolve(
          Object.fromEntries(
            Object.keys(questions).map((
              k,
            ) => [k, { type: "noul", noul: 0.94 }]),
          ),
        )
      ),
      injectGithubFetch(
        makeGithubRecorder(
          githubCalls,
          () =>
            new Response(JSON.stringify({ html_url: issueUrl, number: 88 }), {
              status: 201,
            }),
        ),
      ),
      injectEmailFetch(makeEmailRecorder(emails)),
    )(() =>
      sendAnomalyAlerts("auto-test-yes@example.com", "payments", [anomaly])
    )();

    assertEquals(githubCalls.length, 1);
    assertEquals(
      githubCalls[0].url,
      "https://api.github.com/repos/acme/payments/issues",
    );
    const issuePayload = JSON.parse(githubCalls[0].body);
    assertStringIncludes(issuePayload.title, "Anomaly in payment_failed");
    assertStringIncludes(issuePayload.body, "Project: payments");

    assertEquals(emails.length, 1);
    assertEquals(
      emails[0].subject,
      `[payments] Total Count: payment_failed${
        subjectGithubIssueOpenedSuffix(88)
      }`,
    );
    assertStringIncludes(emails[0].html, autoOpenedGithubIssueLabel);
    assertStringIncludes(emails[0].html, viewGithubIssueLabel(88));
    assertStringIncludes(emails[0].html, issueUrl);
    assertEquals(emails[0].html.includes(createGithubIssueLabel), false);
    assertStringIncludes(
      emails[0].text,
      `${autoOpenedGithubIssueLabel} (#88): ${issueUrl}`,
    );
    assertEquals(emails[0].text.includes(`${createGithubIssueLabel}:`), false);

    const tokenRow = await getTurso().execute({
      sql: "SELECT token FROM alert_feedback WHERE project_id = ?;",
      args: [testProjectId],
    });
    const alertToken = String(tokenRow.rows[0].token);
    const investigateRes = await handleInvestigate(
      new URL(`https://anomalisa.uriv.me/investigate?token=${alertToken}`),
      () => Promise.resolve("payments"),
    );
    assertEquals(investigateRes, { kind: "redirect", location: issueUrl });

    await cleanupAutoIssueTestData();
  },
);

Deno.test(
  "sendAnomalyAlerts reflects per-card status in mixed batches and keeps manual link when decision is negative or GitHub fails",
  async () => {
    await cleanupAutoIssueTestData();
    await saveProjectGithubConfig({
      projectId: testProjectId,
      githubToken: "ghp_test_token",
      githubRepo: "acme/payments",
    });

    const bugAnomaly: Anomaly = {
      projectId: testProjectId,
      eventName: "worker_crash",
      bucket: "2026-06-01T16",
      expected: 0.1,
      actual: 28,
      zScore: 19.5,
      metric: "totalCount",
      detectedAt: "2026-06-01T16:10:00Z",
    };
    const usageAnomaly: Anomaly = {
      projectId: testProjectId,
      eventName: "chat_message",
      bucket: "2026-06-01T16",
      expected: 10,
      actual: 35,
      zScore: 3.8,
      metric: "userSpike",
      userId: "user_42",
      detectedAt: "2026-06-01T16:12:00Z",
    };

    const mixedEmails: CapturedEmail[] = [];
    const mixedGithubCalls: CapturedGithubCall[] = [];
    const mixedIssueUrl = "https://github.com/acme/payments/issues/89";

    await pipe(
      injectDecisionModel(() =>
        Promise.resolve({
          alert_0: { type: "noul", noul: 0.91 },
          alert_1: { type: "noul", noul: 0.05 },
        })
      ),
      injectGithubFetch(
        makeGithubRecorder(
          mixedGithubCalls,
          () =>
            new Response(
              JSON.stringify({ html_url: mixedIssueUrl, number: 89 }),
              { status: 201 },
            ),
        ),
      ),
      injectEmailFetch(makeEmailRecorder(mixedEmails)),
    )(() =>
      sendAnomalyAlerts("auto-test-mixed@example.com", "payments", [
        bugAnomaly,
        usageAnomaly,
      ])
    )();

    assertEquals(mixedGithubCalls.length, 1);
    assertEquals(mixedEmails.length, 1);
    assertEquals(
      mixedEmails[0].subject,
      `[payments] 2 anomalies detected${subjectGithubIssueOpenedSuffix(89)}`,
    );
    assertStringIncludes(mixedEmails[0].html, autoOpenedGithubIssueLabel);
    assertStringIncludes(mixedEmails[0].html, viewGithubIssueLabel(89));
    assertStringIncludes(mixedEmails[0].html, createGithubIssueLabel);
    assertStringIncludes(
      mixedEmails[0].text,
      `${autoOpenedGithubIssueLabel} (#89): ${mixedIssueUrl}`,
    );
    assertStringIncludes(mixedEmails[0].text, `${createGithubIssueLabel}:`);

    const failedEmails: CapturedEmail[] = [];
    const failedGithubCalls: CapturedGithubCall[] = [];
    const failAnomaly: Anomaly = {
      ...bugAnomaly,
      eventName: "db_timeout",
      bucket: "2026-06-01T17",
    };

    await pipe(
      injectDecisionModel(() =>
        Promise.resolve({ alert_0: { type: "noul", noul: 0.96 } })
      ),
      injectGithubFetch(
        makeGithubRecorder(
          failedGithubCalls,
          () =>
            new Response(JSON.stringify({ message: "Bad credentials" }), {
              status: 401,
            }),
        ),
      ),
      injectEmailFetch(makeEmailRecorder(failedEmails)),
    )(() =>
      sendAnomalyAlerts("auto-test-fail@example.com", "payments", [failAnomaly])
    )();

    assertEquals(failedGithubCalls.length, 1);
    assertEquals(failedEmails.length, 1);
    assertEquals(failedEmails[0].subject, "[payments] Total Count: db_timeout");
    assertEquals(
      failedEmails[0].html.includes(autoOpenedGithubIssueLabel),
      false,
    );
    assertStringIncludes(failedEmails[0].html, createGithubIssueLabel);

    await cleanupAutoIssueTestData();
  },
);
