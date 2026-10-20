import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Anomaly } from "./anomaly.ts";
import type { AlertFeedbackRecord } from "./feedback.ts";
import { createAlertFeedbackTokens } from "./feedback.ts";
import {
  buildAgentPrompt,
  handleInvestigate,
  renderInvestigateHtml,
} from "./investigate.ts";
import { getTurso, initTursoSchema } from "./turso.ts";

await initTursoSchema();

const sampleAnomaly: Anomaly = {
  projectId: "test_investigate_proj",
  eventName: "payment_failed",
  bucket: "2026-06-01T12",
  expected: 2.5,
  actual: 15,
  zScore: 4.8,
  metric: "totalCount",
  detectedAt: "2026-06-01T12:30:00Z",
  trend: "rising",
};

const sampleCounts = {
  payment_failed: [
    { bucket: "2026-06-01T10", count: 2 },
    { bucket: "2026-06-01T11", count: 3 },
    { bucket: "2026-06-01T12", count: 15 },
  ],
};

const sampleRecord: AlertFeedbackRecord = {
  token: "tok-123",
  projectId: "test_investigate_proj",
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

const cleanupTestFeedback = () =>
  getTurso().execute({
    sql: "DELETE FROM alert_feedback WHERE project_id = ?;",
    args: ["test_investigate_proj"],
  });

Deno.test("buildAgentPrompt includes the alert context", () => {
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

Deno.test("renderInvestigateHtml renders a copy button and prompt", () => {
  const html = renderInvestigateHtml(sampleRecord, "payments");
  assertStringIncludes(html, "Investigate this anomaly");
  assertStringIncludes(html, "Copy text for agent");
  assertStringIncludes(html, 'id="agent-prompt"');
  assertStringIncludes(html, "payment_failed");
  assertStringIncludes(html, "payments");
  assertStringIncludes(html, "navigator.clipboard.writeText");
});

Deno.test("renderInvestigateHtml escapes prompt content", () => {
  const html = renderInvestigateHtml(
    { ...sampleRecord, eventName: "<script>alert(1)</script>" },
    "<b>payments</b>",
  );
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertStringIncludes(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(html, "&lt;b&gt;payments&lt;/b&gt;");
});

Deno.test("renderInvestigateHtml renders not-found page for missing record", () => {
  const html = renderInvestigateHtml(null, "");
  assertStringIncludes(html, "Alert Details Not Found");
  assertStringIncludes(html, "box-sizing: border-box");
});

Deno.test("handleInvestigate returns copy page for a valid token", async () => {
  await cleanupTestFeedback();
  try {
    const tokens = await createAlertFeedbackTokens(
      [sampleAnomaly],
      sampleCounts,
    );
    const token = tokens[`${sampleAnomaly.eventName}|${sampleAnomaly.bucket}`];
    const { html, status } = await handleInvestigate(
      new URL(`https://example.com/investigate?token=${token}`),
      () => Promise.resolve("payments"),
    );
    assertEquals(status, 200);
    assertStringIncludes(html, "Copy text for agent");
    assertStringIncludes(html, "payments");
    assertStringIncludes(html, "payment_failed");
  } finally {
    await cleanupTestFeedback();
  }
});

Deno.test("handleInvestigate returns 404 for invalid token", async () => {
  const { html, status } = await handleInvestigate(
    new URL("https://example.com/investigate?token=non_existent"),
    () => Promise.resolve("payments"),
  );
  assertEquals(status, 404);
  assertStringIncludes(html, "Alert Details Not Found");
});
