import { assertEquals, assertStringIncludes } from "@std/assert";
import { injectProjectLookup } from "./db.ts";
import { injectEmailFetch, sendTestAnomalyAlert } from "./email.ts";
import { httpHandler } from "./server.ts";
import { handleTestAnomalyRequest } from "./testAnomaly.ts";

type CapturedEmail = {
  url: string;
  auth: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
};

const makeEmailRecorder =
  (captured: CapturedEmail[]) =>
  (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = JSON.parse(init?.body ? String(init.body) : "{}");
    captured.push({
      url,
      auth: new Headers(init?.headers).get("authorization") ?? "",
      to: parsed.to ?? [],
      subject: parsed.subject ?? "",
      html: parsed.html ?? "",
      text: parsed.text ?? "",
    });
    return Promise.resolve(new Response("OK", { status: 200 }));
  };

const failingEmailFetch = (): Promise<Response> =>
  Promise.resolve(new Response("Unauthorized", { status: 401 }));

const sampleProject = {
  id: "proj-1",
  name: "Demo App",
  token: "tok-valid-123",
  owner: { id: "user-1", email: "owner@example.com" },
};

const stubProjectLookup = (token: string) =>
  Promise.resolve(token === sampleProject.token ? sampleProject : null);

const postJson = (path: string, body: string) =>
  httpHandler(
    new Request(`https://anomalisa.uriv.me${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );

Deno.test("sendTestAnomalyAlert sends sample alert email without touching Turso", async () => {
  const captured: CapturedEmail[] = [];
  await injectEmailFetch(makeEmailRecorder(captured))(async () => {
    await sendTestAnomalyAlert("dev@example.com", "Demo App", "proj-1");
  })();
  assertEquals(captured.length, 1);
  assertEquals(captured[0].to, ["dev@example.com"]);
  assertStringIncludes(captured[0].subject, "[Test]");
  assertStringIncludes(captured[0].subject, "[Demo App]");
  assertStringIncludes(captured[0].subject, "checkout_error");
  assertStringIncludes(captured[0].html, "Demo App");
  assertStringIncludes(captured[0].html, "checkout_error");
  assertStringIncludes(captured[0].html, "sparkline");
  assertStringIncludes(captured[0].html, "Sample test alert");
  assertStringIncludes(captured[0].text, "checkout_error");
  assertStringIncludes(captured[0].text, "expected 12, got 48");
});

Deno.test("handleTestAnomalyRequest rejects invalid JSON and missing token", async () => {
  const invalidJson = await handleTestAnomalyRequest(
    "{bad",
    stubProjectLookup,
  );
  assertEquals(invalidJson, {
    status: 400,
    body: { error: "Invalid request" },
  });

  const emptyToken = await handleTestAnomalyRequest(
    JSON.stringify({ token: "" }),
    stubProjectLookup,
  );
  assertEquals(emptyToken, {
    status: 400,
    body: { error: "Invalid request" },
  });
});

Deno.test("handleTestAnomalyRequest rejects unknown project token", async () => {
  const captured: CapturedEmail[] = [];
  const res = await injectEmailFetch(makeEmailRecorder(captured))(() =>
    handleTestAnomalyRequest(
      JSON.stringify({ token: "wrong-token" }),
      stubProjectLookup,
    )
  )();
  assertEquals(res, { status: 400, body: { error: "Invalid token" } });
  assertEquals(captured.length, 0);
});

Deno.test("handleTestAnomalyRequest sends email to project owner on valid token", async () => {
  const captured: CapturedEmail[] = [];
  const res = await injectEmailFetch(makeEmailRecorder(captured))(() =>
    handleTestAnomalyRequest(
      JSON.stringify({ token: sampleProject.token }),
      stubProjectLookup,
    )
  )();
  assertEquals(res, {
    status: 200,
    body: { ok: true, sentTo: "owner@example.com" },
  });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].to, ["owner@example.com"]);
});

Deno.test("handleTestAnomalyRequest returns 500 when email send fails", async () => {
  const res = await injectEmailFetch(failingEmailFetch)(() =>
    handleTestAnomalyRequest(
      JSON.stringify({ token: sampleProject.token }),
      stubProjectLookup,
    )
  )();
  assertEquals(res.status, 500);
  assertStringIncludes(String(res.body.error), "Email send failed");
});

Deno.test("POST /api/test-anomaly sends test anomaly email via httpHandler", async () => {
  const captured: CapturedEmail[] = [];
  const res = await injectProjectLookup(stubProjectLookup)(() =>
    injectEmailFetch(makeEmailRecorder(captured))(() =>
      postJson(
        "/api/test-anomaly",
        JSON.stringify({ token: sampleProject.token }),
      )
    )()
  )();
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, sentTo: "owner@example.com" });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].to, ["owner@example.com"]);
});

Deno.test("POST /api/test-anomaly rejects invalid token via httpHandler", async () => {
  const captured: CapturedEmail[] = [];
  const res = await injectProjectLookup(stubProjectLookup)(() =>
    injectEmailFetch(makeEmailRecorder(captured))(() =>
      postJson("/api/test-anomaly", JSON.stringify({ token: "nope" }))
    )()
  )();
  assertEquals(res.status, 400);
  assertEquals(await res.json(), { error: "Invalid token" });
  assertEquals(captured.length, 0);
});

Deno.test("POST / typed-api sendTestAnomaly sends test anomaly email", async () => {
  const captured: CapturedEmail[] = [];
  const res = await injectProjectLookup(stubProjectLookup)(() =>
    injectEmailFetch(makeEmailRecorder(captured))(() =>
      postJson(
        "/",
        JSON.stringify({
          endpoint: "sendTestAnomaly",
          payload: { token: sampleProject.token },
        }),
      )
    )()
  )();
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, sentTo: "owner@example.com" });
  assertEquals(captured.length, 1);
  assertEquals(captured[0].to, ["owner@example.com"]);
});

Deno.test("web/app.html includes Send Test Anomaly button wired to /api/test-anomaly", async () => {
  const html = await Deno.readTextFile(
    new URL("../web/app.html", import.meta.url),
  );
  assertStringIncludes(html, "Send Test Anomaly");
  assertStringIncludes(html, "/api/test-anomaly");
});
