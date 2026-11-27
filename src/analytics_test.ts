import { assertEquals } from "@std/assert";
import { injectAnalyticsFetch } from "./analytics.ts";
import { injectProjectLookup } from "./db.ts";
import { injectEmailFetch } from "./email.ts";
import { httpHandler } from "./server.ts";
import { getTurso, initTursoSchema } from "./turso.ts";

await initTursoSchema();

const testProjectId = "test_analytics_project_001";
const testUserId = "test_analytics_user_001";
const testEmail = "analytics-test@example.com";
const testToken = "tok-analytics-test-001";

const sampleProject = {
  id: testProjectId,
  name: "Analytics Test App",
  token: testToken,
  owner: { id: testUserId, email: testEmail },
};

const stubProjectLookup = (token: string) =>
  Promise.resolve(token === testToken ? sampleProject : null);

const noopFetch = (): Promise<Response> =>
  Promise.resolve(new Response("OK", { status: 200 }));

const makeAnalyticsRecorder =
  (captured: string[]) =>
  (_url: string, init?: RequestInit): Promise<Response> => {
    const parsed = JSON.parse(init?.body ? String(init.body) : "{}");
    captured.push(String(parsed.event ?? ""));
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

const postSendEvent = (eventName: string) =>
  httpHandler(
    new Request("https://anomalisa.uriv.me/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "sendEvent",
        payload: { token: testToken, eventName },
      }),
    }),
  );

const cleanupAnalyticsTestData = () =>
  getTurso().batch(
    [
      {
        sql: "DELETE FROM counts WHERE project_id = ?;",
        args: [testProjectId],
      },
      { sql: "DELETE FROM stats WHERE project_id = ?;", args: [testProjectId] },
      {
        sql: "DELETE FROM anomalies WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM outgoing_alerts WHERE project_id = ?;",
        args: [testProjectId],
      },
      {
        sql: "DELETE FROM monthly_usage WHERE user_id = ?;",
        args: [testUserId],
      },
      {
        sql: "DELETE FROM admin_notifications WHERE key IN (?, ?);",
        args: [`first_event:${testProjectId}`, `signup:${testEmail}`],
      },
    ],
    "write",
  );

Deno.test("sendEvent does not capture per-event PostHog send_event", async () => {
  await cleanupAnalyticsTestData();
  const captured: string[] = [];
  try {
    await injectProjectLookup(stubProjectLookup)(() =>
      injectEmailFetch(noopFetch)(() =>
        injectAnalyticsFetch(makeAnalyticsRecorder(captured))(async () => {
          const first = await postSendEvent("ping");
          assertEquals(first.status, 200);
          assertEquals(
            captured.toSorted(),
            ["first_event_received", "user_signup"],
          );

          captured.length = 0;
          const second = await postSendEvent("ping");
          assertEquals(second.status, 200);
          assertEquals(captured, []);
        })()
      )()
    )();
  } finally {
    await cleanupAnalyticsTestData();
  }
});
