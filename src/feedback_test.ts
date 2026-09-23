import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Anomaly } from "./anomaly.ts";
import {
  createAlertFeedbackTokens,
  getAlertFeedback,
  getBadAlertsForTesting,
  handleFeedback,
  renderFeedbackHtml,
  updateAlertFeedback,
} from "./feedback.ts";
import { getTurso, initTursoSchema } from "./turso.ts";

await initTursoSchema();

const sampleAnomaly: Anomaly = {
  projectId: "test_fb_proj",
  eventName: "payment_failed",
  bucket: "2026-06-01T12",
  expected: 2.5,
  actual: 15,
  zScore: 4.8,
  metric: "totalCount",
  detectedAt: "2026-06-01T12:30:00Z",
};

const sampleCounts = {
  payment_failed: [
    { bucket: "2026-06-01T10", count: 2 },
    { bucket: "2026-06-01T11", count: 3 },
    { bucket: "2026-06-01T12", count: 15 },
  ],
};

const cleanupTestFeedback = () =>
  getTurso().execute({
    sql: "DELETE FROM alert_feedback WHERE project_id = ?;",
    args: ["test_fb_proj"],
  });

Deno.test("createAlertFeedbackTokens stores snapshot and returns mapping", async () => {
  await cleanupTestFeedback();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const key = `${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`;
    const token = tokens[key];
    assertEquals(typeof token, "string");
    assertEquals(token.length > 0, true);

    const record = await getAlertFeedback(token);
    assertEquals(record !== null, true);
    assertEquals(record?.projectId, "test_fb_proj");
    assertEquals(record?.eventName, "payment_failed");
    assertEquals(record?.bucket, "2026-06-01T12");
    assertEquals(record?.expected, 2.5);
    assertEquals(record?.actual, 15);
    assertEquals(record?.zScore, 4.8);
    assertEquals(record?.rating, null);

    const history = JSON.parse(record?.historyJson ?? "{}");
    assertEquals(history.counts, [2, 3, 15]);
  } finally {
    await cleanupTestFeedback();
  }
});

Deno.test("updateAlertFeedback records vote and timestamp", async () => {
  await cleanupTestFeedback();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const token = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];

    const updated = await updateAlertFeedback(token, "good");
    assertEquals(updated, true);

    const record = await getAlertFeedback(token);
    assertEquals(record?.rating, "good");
    assertEquals(typeof record?.feedbackAt, "number");
  } finally {
    await cleanupTestFeedback();
  }
});

Deno.test("getBadAlertsForTesting retrieves false positives with snapshots", async () => {
  await cleanupTestFeedback();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const token = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];
    await updateAlertFeedback(token, "bad");

    const badAlerts = await getBadAlertsForTesting();
    const found = badAlerts.find((r) => r.token === token);
    assertEquals(found !== undefined, true);
    assertEquals(found?.rating, "bad");
    assertEquals(found?.eventName, "payment_failed");

    const history = JSON.parse(found?.historyJson ?? "{}");
    assertEquals(history.counts, [2, 3, 15]);
  } finally {
    await cleanupTestFeedback();
  }
});

Deno.test("renderFeedbackHtml renders not-found page for missing record", () => {
  const html = renderFeedbackHtml(null, null);
  assertStringIncludes(html, "Feedback Link Not Found");
});

Deno.test("renderFeedbackHtml renders action buttons and active status", () => {
  const fakeRecord = {
    token: "tok-123",
    projectId: "p1",
    eventName: "checkout_error",
    bucket: "2026-06-01T14",
    metric: "totalCount",
    userId: "_",
    expected: 1.0,
    actual: 8,
    zScore: 3.9,
    anomaliesJson: "[]",
    historyJson: "{}",
    statsJson: null,
    rating: null,
    feedbackAt: null,
    createdAt: Date.now(),
  };

  const htmlGood = renderFeedbackHtml(fakeRecord, "good");
  assertStringIncludes(htmlGood, "Marked as Good alert");
  assertStringIncludes(htmlGood, "checkout_error");
  assertStringIncludes(htmlGood, "Good alert");
  assertStringIncludes(htmlGood, "Bad alert");

  const htmlBad = renderFeedbackHtml(fakeRecord, "bad");
  assertStringIncludes(htmlBad, "Marked as Bad alert");
});

Deno.test("handleFeedback updates vote and returns confirmation page", async () => {
  await cleanupTestFeedback();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const token = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];

    let captured: { project: string; vote: string } | null = null;
    const url = new URL(`https://example.com/feedback?token=${token}&vote=bad`);
    const { html, status } = await handleFeedback(
      url,
      (projectId, _event, _bucket, vote) => {
        captured = { project: projectId, vote };
      },
    );

    assertEquals(status, 200);
    assertStringIncludes(html, "Marked as Bad alert");
    assertEquals(captured, { project: "test_fb_proj", vote: "bad" });

    const record = await getAlertFeedback(token);
    assertEquals(record?.rating, "bad");
  } finally {
    await cleanupTestFeedback();
  }
});

Deno.test("handleFeedback returns 404 for invalid token", async () => {
  const url = new URL("https://example.com/feedback?token=non_existent&vote=good");
  const { html, status } = await handleFeedback(url);
  assertEquals(status, 404);
  assertStringIncludes(html, "Feedback Link Not Found");
});
