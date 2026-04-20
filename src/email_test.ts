import { assertEquals } from "@std/assert";
import type { Anomaly } from "./anomaly.ts";
import {
  anomaliesHtml,
  anomaliesText,
  batchSubject,
  formatBucket,
} from "./email.ts";

const singleAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "login",
  bucket: "2026-04-06T23",
  expected: 10,
  actual: 30,
  zScore: 3.5,
  metric: "totalCount",
  detectedAt: "2026-04-06T23:30:00Z",
};

const twoAnomalies: Anomaly[] = [
  singleAnomaly,
  {
    projectId: "proj1",
    eventName: "signup",
    bucket: "2026-04-07T09",
    expected: 5,
    actual: 20,
    zScore: 4.1,
    metric: "percentageSpike",
    detectedAt: "2026-04-07T09:15:00Z",
    userId: "user123",
  },
];

const longUserAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "click",
  bucket: "2026-04-07T09",
  expected: 5,
  actual: 20,
  zScore: 4.1,
  metric: "userSpike",
  detectedAt: "2026-04-07T09:15:00Z",
  userId: "this_is_a_very_long_user_id_that_should_be_truncated",
};

const dropAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "Chat Message",
  bucket: "2026-04-17T09",
  expected: 66,
  actual: 0,
  zScore: 1,
  metric: "percentageDrop",
  detectedAt: "2026-04-17T10:05:00Z",
};

Deno.test("batchSubject uses specific subject for single anomaly", () => {
  assertEquals(
    batchSubject("myapp", [singleAnomaly]),
    "[myapp] Total Count: login",
  );
});

Deno.test("batchSubject labels percentageDrop as Percentage Drop", () => {
  assertEquals(
    batchSubject("myapp", [dropAnomaly]),
    "[myapp] Percentage Drop: Chat Message",
  );
});

Deno.test("anomaliesHtml renders percentageDrop section", () => {
  const html = anomaliesHtml("myapp", [dropAnomaly]);
  assertEquals(html.includes("Percentage Drop"), true);
  assertEquals(html.includes("dropped"), true);
});

Deno.test("batchSubject shows count for multiple anomalies", () => {
  assertEquals(
    batchSubject("myapp", twoAnomalies),
    "[myapp] 2 anomalies detected",
  );
});

Deno.test("batchSubject truncates long user id", () => {
  assertEquals(
    batchSubject("myapp", [longUserAnomaly]),
    "[myapp] User Spike: click (this_is_a_very_long_...)",
  );
});

Deno.test("anomaliesHtml says 'Anomaly Detected' without count for single anomaly", () => {
  const html = anomaliesHtml("myapp", [singleAnomaly]);
  assertEquals(html.includes("1 Anomaly"), false);
  assertEquals(html.includes("Anomaly Detected"), true);
});

Deno.test("anomaliesHtml shows count for multiple anomalies", () => {
  const html = anomaliesHtml("myapp", twoAnomalies);
  assertEquals(html.includes("2 Anomalies Detected"), true);
});

Deno.test("anomaliesHtml truncates long user id", () => {
  const html = anomaliesHtml("myapp", [longUserAnomaly]);
  assertEquals(html.includes("this_is_a_very_long_user_id"), false);
  assertEquals(html.includes("this_is_a_very_long_..."), true);
});

Deno.test("formatBucket renders human-readable date", () => {
  assertEquals(formatBucket("2026-04-06T23"), "Mon Apr 6, 11pm–12am UTC");
});

Deno.test("formatBucket renders midnight as 12am", () => {
  assertEquals(formatBucket("2026-04-07T00"), "Tue Apr 7, 12am–1am UTC");
});

Deno.test("formatBucket renders hour as range e.g. 12am–1am", () => {
  assertEquals(formatBucket("2026-04-20T00"), "Mon Apr 20, 12am–1am UTC");
});

Deno.test("formatBucket renders noon as 12pm", () => {
  assertEquals(formatBucket("2026-04-07T12"), "Tue Apr 7, 12pm–1pm UTC");
});

Deno.test("formatBucket renders morning hour", () => {
  assertEquals(formatBucket("2026-04-07T09"), "Tue Apr 7, 9am–10am UTC");
});

Deno.test("anomaliesHtml uses formatted bucket not raw ISO", () => {
  const html = anomaliesHtml("myapp", [singleAnomaly]);
  assertEquals(html.includes("2026-04-06T23"), false);
  assertEquals(html.includes("Mon Apr 6, 11pm–12am UTC"), true);
});

Deno.test("anomaliesText uses formatted bucket not raw ISO", () => {
  const text = anomaliesText([singleAnomaly]);
  assertEquals(text.includes("2026-04-06T23"), false);
  assertEquals(text.includes("Mon Apr 6, 11pm–12am UTC"), true);
});

Deno.test("anomaliesText truncates long user id", () => {
  const text = anomaliesText([longUserAnomaly]);
  assertEquals(text.includes("this_is_a_very_long_user_id"), false);
  assertEquals(text.includes("this_is_a_very_long_..."), true);
});
