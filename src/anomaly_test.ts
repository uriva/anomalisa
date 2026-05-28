import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Anomaly,
  anomalyDirection,
  type CooldownEntry,
  detectAnomaly,
  detectBucketAnomalies,
  detectPercentageDrop,
  detectPercentageSpike,
  detectPoissonAnomaly,
  detectSkippedHourAnomalies,
  drainOutgoingAlerts,
  emptyStats,
  enqueueOutgoingAlerts,
  hoursBetween,
  shouldSuppress,
  stdDev,
  updateStats,
  updateStatsWithZeros,
} from "./anomaly.ts";

const buildStats = (values: number[], lastBucket: string) =>
  values.reduce(
    (stats, value) => updateStats(stats, value),
    emptyStats(lastBucket),
  );

Deno.test("updateStats — single value gives correct mean", () => {
  const stats = updateStats(emptyStats("2026-01-01T00"), 10);
  assertEquals(stats.n, 1);
  assertEquals(stats.mean, 10);
  assertEquals(stats.m2, 0);
});

Deno.test("updateStats — multiple values give correct mean", () => {
  const stats = buildStats([10, 20, 30], "2026-01-01T00");
  assertEquals(stats.n, 3);
  assertAlmostEquals(stats.mean, 20, 0.001);
});

Deno.test("updateStats — preserves lastBucket from input", () => {
  const stats = updateStats(emptyStats("2026-01-01T05"), 42);
  assertEquals(stats.lastBucket, "2026-01-01T05");
});

Deno.test("stdDev — returns 0 for fewer than 2 data points", () => {
  assertEquals(stdDev(emptyStats("x")), 0);
  assertEquals(stdDev(updateStats(emptyStats("x"), 10)), 0);
});

Deno.test("stdDev — correct for known values", () => {
  const stats = buildStats([2, 4, 4, 4, 5, 5, 7, 9], "x");
  assertAlmostEquals(stdDev(stats), 2.1381, 0.001);
});

Deno.test("stdDev — zero for identical values", () => {
  const stats = buildStats([5, 5, 5, 5], "x");
  assertAlmostEquals(stdDev(stats), 0, 0.001);
});

Deno.test("detectAnomaly — returns null when n < 3 (cold start)", () => {
  const stats = buildStats([10, 20], "2026-01-01T02");
  assertEquals(
    detectAnomaly(stats, 100, "proj1", "signup", "totalCount", stats.lastBucket),
    null,
  );
});

Deno.test("detectAnomaly — returns null for normal value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  assertEquals(
    detectAnomaly(stats, 11, "proj1", "signup", "totalCount", stats.lastBucket),
    null,
  );
});

Deno.test("detectAnomaly — detects totalCount anomaly for extreme value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  const result = detectAnomaly(stats, 100, "proj1", "signup", "totalCount", stats.lastBucket);
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.projectId, "proj1");
  assertEquals(anomaly.eventName, "signup");
  assertEquals(anomaly.actual, 100);
  assertEquals(anomaly.zScore > 2, true);
  assertEquals(anomaly.metric, "totalCount");
  assertEquals(anomaly.userId, undefined);
});

Deno.test("detectAnomaly — detects userSpike with userId", () => {
  const stats = buildStats([5, 6, 5, 4, 5], "2026-01-01T04");
  const result = detectAnomaly(
    stats,
    50,
    "proj1",
    "pageview",
    "userSpike",
    stats.lastBucket,
    "user-abc",
  );
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.metric, "userSpike");
  assertEquals(anomaly.userId, "user-abc");
});

Deno.test("detectAnomaly — ignores single-event user spike", () => {
  const stats = buildStats([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], "2026-05-17T15");
  assertEquals(
    detectAnomaly(
      stats,
      1,
      "p",
      "e",
      "userSpike",
      stats.lastBucket,
      "u",
    ),
    null,
  );
});

Deno.test("detectAnomaly — ignores single-event total count spike", () => {
  const stats = buildStats([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], "2026-05-20T07");
  assertEquals(
    detectAnomaly(
      stats,
      1,
      "p",
      "e",
      "totalCount",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectAnomaly — ignores double-event user spike", () => {
  const stats = buildStats([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], "2026-05-20T16");
  assertEquals(
    detectAnomaly(
      stats,
      2,
      "p",
      "e",
      "userSpike",
      stats.lastBucket,
      "u",
    ),
    null,
  );
});

Deno.test("detectAnomaly — ignores small uptick on sparse event", () => {
  const stats = buildStats([0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "2026-04-20T16");
  assertEquals(
    detectAnomaly(
      stats,
      4,
      "p",
      "e",
      "totalCount",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectAnomaly — triggers on larger uptick even for sparse event", () => {
  const stats = buildStats([0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "2026-04-20T16");
  const result = detectAnomaly(
    stats,
    5,
    "p",
    "e",
    "totalCount",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
});

Deno.test("detectAnomaly — detects anomaly for zero when mean is high", () => {
  const stats = buildStats([100, 102, 98, 101, 99], "2026-01-01T04");
  const result = detectAnomaly(stats, 0, "proj1", "pageview", "totalCount", stats.lastBucket);
  assertEquals(result !== null, true);
});

Deno.test("detectAnomaly — returns null when stdDev is 0 and value equals mean", () => {
  const stats = buildStats([10, 10, 10, 10], "2026-01-01T04");
  assertEquals(
    detectAnomaly(stats, 10, "proj1", "click", "totalCount", stats.lastBucket),
    null,
  );
});

Deno.test("detectAnomaly — borderline z-score just above threshold triggers", () => {
  const stats = buildStats([10, 20, 30], "2026-01-01T03");
  const sd = stdDev(stats);
  const mean = stats.mean;
  const barelyOver = Math.ceil(mean + 3.1 * sd);
  const result = detectAnomaly(
    stats,
    barelyOver,
    "proj1",
    "test",
    "totalCount",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
});

Deno.test("detectAnomaly — borderline z-score just below threshold does not trigger", () => {
  const stats = buildStats([10, 20, 30], "2026-01-01T03");
  const sd = stdDev(stats);
  const mean = stats.mean;
  const barelyUnder = Math.floor(mean + 2.9 * sd);
  assertEquals(
    detectAnomaly(stats, barelyUnder, "proj1", "test", "totalCount", stats.lastBucket),
    null,
  );
});

Deno.test("detectAnomaly — userSpike omits userId when not provided", () => {
  const stats = buildStats([5, 6, 5, 4, 5], "2026-01-01T04");
  const result = detectAnomaly(stats, 50, "proj1", "event", "userSpike", stats.lastBucket);
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).userId, undefined);
});

// ---------------------------------------------------------------------------
// detectPoissonAnomaly — count-aware tail-probability detector
//
// Motivation: low-rate events (mean < 1/hr) currently rely on z-scores with
// ad-hoc absolute-count floors. For count data, a Poisson tail probability is
// the right model and removes the magic numbers.
//
// Contract (proposed):
//   detectPoissonAnomaly(stats, count, projectId, eventName, bucket)
//     - returns null when stats.n < minDataPoints (cold start)
//     - returns null when the two-sided Poisson tail probability of `count`
//       under rate=stats.mean is above pThreshold (default ~1e-3)
//     - otherwise returns an Anomaly with metric "totalCount" and
//       zScore = -log10(p) (so larger = more anomalous, comparable to old z)
// ---------------------------------------------------------------------------

Deno.test("detectPoissonAnomaly — returns null on cold start (n < 3)", () => {
  const stats = buildStats([1, 0], "2026-05-27T21");
  assertEquals(
    detectPoissonAnomaly(stats, 6, "proj1", "submit_exists", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — returns null for normal value at low mean", () => {
  // mean ~0.7, observing 1 should not fire (p high under Poisson(0.7))
  const stats = buildStats([1, 0, 1, 2, 0, 1, 0, 2, 1, 0], "2026-05-27T21");
  assertEquals(
    detectPoissonAnomaly(stats, 1, "proj1", "submit_exists", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — flags the real alert case (mean ~0.7, count 6)", () => {
  // Reproduces "API submit already exists" alert: expected 0.7, actual 6.
  // Under Poisson(0.7), P(X >= 6) ~= 6e-5 — well below pThreshold.
  const stats = buildStats(
    [1, 0, 1, 2, 0, 1, 0, 2, 1, 0],
    "2026-05-27T21",
  );
  const result = detectPoissonAnomaly(
    stats,
    6,
    "proj1",
    "submit_exists",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.actual, 6);
  assertEquals(anomaly.expected, 0.8);
  assertEquals(anomaly.metric, "totalCount");
  // -log10(p) for p ~ 6e-5 is ~4.2; require it's clearly above noise
  assertEquals(anomaly.zScore > 3, true);
});

Deno.test("detectPoissonAnomaly — flags the supergreen API Error alert (mean ~0.54, count 6)", () => {
  // Real alert: mean 0.54, count 6. Under Poisson(0.54), P(X>=6) ~= 2.2e-5,
  // two-sided p ~= 4.4e-5, -log10(p) ~= 4.36 — clearly anomalous.
  // The sparkline shows a single big spike on an otherwise quiet event,
  // which is exactly the kind of case Poisson should catch.
  const stats = buildStats(
    [0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    "2026-05-28T00",
  );
  const result = detectPoissonAnomaly(
    stats,
    6,
    "supergreen",
    "api_error",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.actual, 6);
  assertEquals(anomaly.zScore > 3, true);
});

Deno.test("detectPoissonAnomaly — borderline case (mean ~1.0, count 5) is suppressed", () => {
  // Reproduces "Scraped URL" alert: expected ~0.97, actual 5.
  // Under Poisson(1.0), two-sided p ~= 0.007 — above pThreshold (1e-3),
  // so we deliberately do NOT fire. This is the whole point of switching
  // to Poisson: the old z-score detector fired here, but at this baseline
  // count=5 just isn't strong enough evidence to alert on.
  const stats = buildStats(
    [1, 1, 0, 2, 1, 1, 0, 2, 1, 1],
    "2026-05-27T21",
  );
  assertEquals(
    detectPoissonAnomaly(stats, 5, "proj1", "scraped_url", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — fires on stronger version of the borderline case (count 7)", () => {
  // Same baseline (mean ~1.0) but count 7: P(X>=7 | 1.0) ~= 8.3e-5,
  // two-sided ~= 1.7e-4 — below threshold, fires.
  const stats = buildStats(
    [1, 1, 0, 2, 1, 1, 0, 2, 1, 1],
    "2026-05-27T21",
  );
  const result = detectPoissonAnomaly(
    stats,
    7,
    "proj1",
    "scraped_url",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 7);
});

Deno.test("detectPoissonAnomaly — small absolute spike at tiny baseline does NOT fire", () => {
  // mean ~0.1, count 2: under Poisson(0.1), P(X >= 2) ~= 0.005 — close to threshold,
  // but the test pins the design intent: very rare events with tiny absolute counts
  // should require strong evidence. With pThreshold = 1e-3 this is suppressed.
  const stats = buildStats(
    [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    "2026-05-27T21",
  );
  assertEquals(
    detectPoissonAnomaly(stats, 2, "proj1", "rare", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — find-scene Extract Frame: lambda=0.03, count=2 does NOT fire", () => {
  // Real alert: expected 0.03, actual 2. Under Poisson(0.03), P(X>=2) ~= 4.4e-4,
  // two-sided ~= 8.8e-4 — below the 1e-3 p-threshold and would fire on math alone.
  // But two events in an hour on a near-zero baseline isn't actionable. The
  // low-baseline absolute floor (count >= 5 when mean < 1) should suppress this,
  // matching the existing guard in detectAnomaly.
  const stats = buildStats(
    [...Array.from({ length: 30 }, () => 0), 1],
    "2026-05-28T10",
  );
  assertEquals(
    detectPoissonAnomaly(stats, 2, "find-scene", "Extract Frame", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — detects drop to zero from high mean", () => {
  // mean ~50, observed 0: P(X = 0) = e^-50 ~ 2e-22 — clearly anomalous on the low side.
  const stats = buildStats([50, 48, 52, 49, 51, 50, 47, 53], "2026-05-27T21");
  const result = detectPoissonAnomaly(
    stats,
    0,
    "proj1",
    "signup",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 0);
});

Deno.test("detectPoissonAnomaly — does not fire on normal traffic at high mean", () => {
  // mean ~50, observed 55: well within Poisson noise.
  const stats = buildStats([50, 48, 52, 49, 51, 50, 47, 53], "2026-05-27T21");
  assertEquals(
    detectPoissonAnomaly(stats, 55, "proj1", "signup", stats.lastBucket),
    null,
  );
});

Deno.test("detectPoissonAnomaly — zScore field encodes -log10(p), larger = more anomalous", () => {
  const lowMean = buildStats([1, 0, 1, 2, 0, 1, 0, 2, 1, 0], "2026-05-27T21");
  const extreme = detectPoissonAnomaly(lowMean, 10, "p", "e", lowMean.lastBucket);
  const milder = detectPoissonAnomaly(lowMean, 6, "p", "e", lowMean.lastBucket);
  assertEquals(extreme !== null, true);
  assertEquals(milder !== null, true);
  assertEquals(
    (extreme as Anomaly).zScore > (milder as Anomaly).zScore,
    true,
  );
});

Deno.test("Welford's — incremental matches batch calculation", () => {
  const values = [3, 7, 11, 5, 9, 2, 14, 6];
  const stats = buildStats(values, "x");

  const batchMean = values.reduce((a, b) => a + b, 0) / values.length;
  const batchVariance =
    values.reduce((sum, v) => sum + (v - batchMean) ** 2, 0) /
    (values.length - 1);
  const batchStdDev = Math.sqrt(batchVariance);

  assertAlmostEquals(stats.mean, batchMean, 0.0001);
  assertAlmostEquals(stdDev(stats), batchStdDev, 0.0001);
});

Deno.test("detectPercentageSpike — returns null when n < 3", () => {
  const stats = buildStats([5, 10], "2026-01-01T02");
  assertEquals(
    detectPercentageSpike(stats, 20, "proj1", "error", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageSpike — returns null when mean is 0", () => {
  const stats = buildStats([0, 0, 0, 0], "2026-01-01T04");
  const result = detectPercentageSpike(stats, 5, "proj1", "error", stats.lastBucket);
  assertEquals(result, null);
});

Deno.test("detectPercentageSpike — returns null when mean is 0 and n < 3", () => {
  const stats = buildStats([0, 0], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 5, "proj1", "error", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageSpike — returns null for normal value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 15, "proj1", "error", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageSpike — detects doubling", () => {
  const stats = buildStats([30, 40, 30, 50, 30], "2026-01-01T04");
  const result = detectPercentageSpike(stats, 80, "proj1", "error", stats.lastBucket);
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.metric, "percentageSpike");
  assertEquals(anomaly.actual, 80);
  assertEquals(anomaly.zScore > 1, true);
});

Deno.test("detectPercentageSpike — returns null when absolute diff below threshold", () => {
  const stats = buildStats([1, 1, 1, 1], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 3, "proj1", "error", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageSpike — suppresses doubling on noisy data when z-score is low", () => {
  const stats = buildStats([10, 30, 70, 20, 130, 50, 40, 80], "2026-01-01T04");
  const doubled = Math.ceil(stats.mean * 2.1);
  assertEquals(
    detectAnomaly(stats, doubled, "proj1", "error", "totalCount", stats.lastBucket),
    null,
  );
  assertEquals(
    detectPercentageSpike(stats, doubled, "proj1", "error", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageDrop — returns null when n < 3", () => {
  const stats = buildStats([10, 10], "2026-01-01T02");
  assertEquals(
    detectPercentageDrop(stats, 0, "p", "e", stats.lastBucket),
    null,
  );
});

Deno.test("detectPercentageDrop — returns null for normal value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  assertEquals(
    detectPercentageDrop(
      stats,
      9,
      "p",
      "e",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — ignores low-volume drops", () => {
  const stats = buildStats([12, 12, 12, 12], "2026-01-01T04");
  assertEquals(
    detectPercentageDrop(
      stats,
      4,
      "p",
      "e",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — detects halving", () => {
  const stats = buildStats([100, 110, 90, 105, 95], "2026-01-01T04");
  const result = detectPercentageDrop(
    stats,
    30,
    "p",
    "e",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).metric, "percentageDrop");
  assertEquals((result as Anomaly).actual, 30);
});

Deno.test("detectPercentageDrop — detects drop to zero with high mean", () => {
  const stats = buildStats([66, 70, 60, 80, 55], "2026-04-17T09");
  const result = detectPercentageDrop(
    stats,
    0,
    "p",
    "Chat Message",
    stats.lastBucket,
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 0);
});

Deno.test("detectPercentageDrop — returns null when absolute diff below threshold", () => {
  const stats = buildStats([5, 5, 5, 5], "2026-01-01T04");
  assertEquals(
    detectPercentageDrop(
      stats,
      3,
      "p",
      "e",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — returns null when mean is 0", () => {
  const stats = buildStats([0, 0, 0, 0], "2026-01-01T04");
  assertEquals(
    detectPercentageDrop(
      stats,
      0,
      "p",
      "e",
      stats.lastBucket,
    ),
    null,
  );
});

Deno.test("detectBucketAnomalies — does not fire percentageDrop for quiet hour consistent with per-hour-of-day history", () => {
  // Global stats mix busy daytime hours with quiet midnight hours,
  // but per-hour stats for midnight show a low mean (~1.5).
  // Getting 1 event at midnight should not trigger a percentageDrop.
  const globalStats = buildStats(
    [2, 1, 1, 2, 1, 2, 1, ...Array.from({ length: 17 }, () => 100)],
    "2026-04-20T00",
  );
  const midnightHourStats = buildStats([2, 1, 1, 2, 1, 2], "2026-04-19T00");
  const result = detectBucketAnomalies(
    globalStats,
    midnightHourStats,
    1,
    0,
    "p",
    "Chat Message",
  );
  assertEquals(
    result.some((a: Anomaly) => a.metric === "percentageDrop"),
    false,
  );
});

Deno.test("detectBucketAnomalies — ignores normal count at naturally busy hour", () => {
  // Global stats: sparse event, mean ~1.0 across all hours
  const globalStats = buildStats(
    [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2],
    "2026-05-20T15",
  );
  // Hour-of-day stats for 3pm: this hour is naturally busy, mean ~5
  const hourStats = buildStats([4, 5, 6, 5, 7, 5], "2026-05-19T15");
  const result = detectBucketAnomalies(
    globalStats,
    hourStats,
    6,
    0,
    "p",
    "Proactive Chat Requested",
  );
  assertEquals(
    result.some((a: Anomaly) => a.metric === "totalCount"),
    false,
  );
  assertEquals(
    result.some((a: Anomaly) => a.metric === "percentageSpike"),
    false,
  );
});

Deno.test("detectBucketAnomalies — dates anomalies to the bucket being closed, not the hourStats initialization bucket", () => {
  const globalStats = buildStats([10, 10, 10], "2026-05-26T00");
  const hourStats = buildStats([10, 10, 10], "2026-04-21T00");
  const result = detectBucketAnomalies(
    globalStats,
    hourStats,
    100,
    0,
    "p",
    "Error Occurred",
  );
  assertEquals(result.length > 0, true);
  for (const anomaly of result) {
    assertEquals(anomaly.bucket, "2026-05-26T00");
  }
});

Deno.test("detectPercentageDrop — catches halving that z-score misses in noisy data", () => {
  const stats = buildStats(
    [30, 80, 120, 40, 200, 60, 90, 150],
    "2026-01-01T04",
  );
  const halved = Math.floor(stats.mean / 3);
  const zRes = detectAnomaly(stats, halved, "p", "e", "totalCount", stats.lastBucket);
  const pctRes = detectPercentageDrop(stats, halved, "p", "e", stats.lastBucket);
  assertEquals(zRes, null);
  assertEquals(pctRes !== null, true);
});

Deno.test("detectSkippedHourAnomalies — empty when no skipped hours", () => {
  assertEquals(
    detectSkippedHourAnomalies(
      buildStats([10, 10, 10], "2026-01-01T03"),
      0,
      "p",
      "e",
    ),
    [],
  );
});

Deno.test("detectSkippedHourAnomalies — detects drop for find-scene scenario", () => {
  const stats = buildStats(
    [
      42,
      46,
      197,
      103,
      75,
      57,
      83,
      88,
      34,
      86,
      146,
      208,
      147,
      216,
      63,
      127,
      235,
      201,
      171,
      25,
      235,
      225,
      60,
      51,
    ],
    "2026-04-17T08",
  );
  const result = detectSkippedHourAnomalies(stats, 10, "p", "Chat Message");
  assertEquals(result.length > 0, true);
  assertEquals(result.every((a: Anomaly) => a.actual === 0), true);
});

Deno.test("detectSkippedHourAnomalies — no anomaly when mean is already zero", () => {
  assertEquals(
    detectSkippedHourAnomalies(
      buildStats([0, 0, 0, 0], "2026-01-01T03"),
      3,
      "p",
      "e",
    ),
    [],
  );
});

Deno.test("hoursBetween — consecutive hours", () => {
  assertEquals(hoursBetween("2026-01-01T05", "2026-01-01T06"), 1);
});

Deno.test("hoursBetween — same bucket", () => {
  assertEquals(hoursBetween("2026-01-01T05", "2026-01-01T05"), 0);
});

Deno.test("hoursBetween — multi-day gap", () => {
  assertEquals(hoursBetween("2026-02-26T00", "2026-03-03T15"), 135);
});

Deno.test("updateStatsWithZeros — adds correct number of zero data points", () => {
  const stats = emptyStats("x");
  const result = updateStatsWithZeros(stats, 5);
  assertEquals(result.n, 5);
  assertEquals(result.mean, 0);
});

Deno.test("updateStatsWithZeros — zero count is no-op", () => {
  const stats = buildStats([10, 20], "x");
  const result = updateStatsWithZeros(stats, 0);
  assertEquals(result.n, stats.n);
  assertEquals(result.mean, stats.mean);
});

Deno.test("updateStatsWithZeros — shifts mean toward zero", () => {
  const stats = buildStats([10, 10, 10], "x");
  const result = updateStatsWithZeros(stats, 7);
  assertEquals(result.n, 10);
  assertAlmostEquals(result.mean, 3, 0.001);
});

Deno.test("detectAnomaly — detects anomaly when stdDev is 0 and value differs from mean", () => {
  const stats = buildStats([0, 0, 0, 0, 0], "2026-01-01T04");
  const result = detectAnomaly(stats, 5, "proj1", "Bot Created", "totalCount", stats.lastBucket);
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 5);
});

Deno.test("detectPercentageSpike — returns null when mean is 0 and value below absolute threshold", () => {
  const stats = buildStats([0, 0, 0, 0, 0], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 1, "proj1", "Bot Created", stats.lastBucket),
    null,
  );
});

Deno.test("rare event with long gap — z-score detects spike after zeros fill in", () => {
  const stats = updateStatsWithZeros(
    updateStats(emptyStats("2026-02-26T00"), 1),
    133,
  );
  const anomaly = detectAnomaly(stats, 20, "proj1", "credits", "totalCount", stats.lastBucket);
  assertEquals(anomaly !== null, true);
  assertEquals((anomaly as Anomaly).zScore > 2, true);
});

Deno.test("rare event with long gap — percentage spike ignores when mean is below threshold", () => {
  const stats = updateStatsWithZeros(
    updateStats(emptyStats("2026-02-26T00"), 1),
    133,
  );
  const anomaly = detectPercentageSpike(stats, 20, "proj1", "credits", stats.lastBucket);
  assertEquals(anomaly, null);
});

Deno.test("level shift — detectAnomaly fires multiple consecutive hours during transition (reproduces alert spam)", () => {
  const normalValues = [
    8,
    12,
    9,
    11,
    10,
    13,
    7,
    11,
    10,
    9,
    8,
    12,
    10,
    11,
    9,
    10,
    13,
    8,
    11,
    10,
    12,
    9,
    10,
    11,
  ];
  const newRate = 50;

  let stats = emptyStats("2026-01-01T00");
  for (const v of normalValues) {
    stats = updateStats(stats, v);
  }

  const consecutiveAlerts: boolean[] = [];
  for (let hour = 0; hour < 10; hour++) {
    const anomaly = detectAnomaly(
      stats,
      newRate,
      "proj1",
      "orders",
      "totalCount",
      stats.lastBucket,
    );
    consecutiveAlerts.push(anomaly !== null);
    stats = updateStats(stats, newRate);
  }

  const alertCount = consecutiveAlerts.filter((x) => x).length;
  assertEquals(
    alertCount >= 3,
    true,
    `Expected at least 3 consecutive alerts during level shift, got ${alertCount}`,
  );
});

Deno.test("anomalyDirection — high when actual > expected", () => {
  assertEquals(
    anomalyDirection({
      actual: 50,
      expected: 10,
    } as Anomaly),
    "high",
  );
});

Deno.test("anomalyDirection — low when actual < expected", () => {
  assertEquals(
    anomalyDirection({
      actual: 0,
      expected: 100,
    } as Anomaly),
    "low",
  );
});

Deno.test("shouldSuppress — returns true for same direction, same magnitude", () => {
  assertEquals(
    shouldSuppress({ direction: "high", actual: 2 }, {
      actual: 3,
      expected: 0.1,
    } as Anomaly),
    true,
  );
});

Deno.test("shouldSuppress — returns false for opposite direction", () => {
  assertEquals(
    shouldSuppress({ direction: "high", actual: 50 }, {
      actual: 0,
      expected: 100,
    } as Anomaly),
    false,
  );
});

Deno.test("shouldSuppress — returns false when no previous entry", () => {
  assertEquals(
    shouldSuppress(null, {
      actual: 50,
      expected: 10,
    } as Anomaly),
    false,
  );
});

Deno.test("shouldSuppress — escalation: same direction but much higher actual is NOT suppressed", () => {
  assertEquals(
    shouldSuppress({ direction: "high", actual: 2 }, {
      actual: 10,
      expected: 0.1,
    } as Anomaly),
    false,
  );
});

Deno.test("shouldSuppress — escalation: doubling still suppressed (boundary)", () => {
  assertEquals(
    shouldSuppress({ direction: "high", actual: 4 }, {
      actual: 8,
      expected: 0.1,
    } as Anomaly),
    true,
  );
});

Deno.test("shouldSuppress — escalation: just over 2x is NOT suppressed", () => {
  assertEquals(
    shouldSuppress({ direction: "high", actual: 4 }, {
      actual: 9,
      expected: 0.1,
    } as Anomaly),
    false,
  );
});

Deno.test("shouldSuppress — escalation: low direction escalation also not suppressed", () => {
  assertEquals(
    shouldSuppress({ direction: "low", actual: 100 }, {
      actual: 10,
      expected: 50,
    } as Anomaly),
    false,
  );
});

Deno.test({
  name: "enqueueOutgoingAlerts and drainOutgoingAlerts — groups by project and deletes on drain",
  sanitizeResources: false,
  fn: async () => {
    const anomaly = (
      projectId: string,
      eventName: string,
      bucket: string,
    ): Anomaly => ({
      projectId,
      eventName,
      bucket,
      expected: 10,
      actual: 2,
      zScore: 3,
      detectedAt: new Date().toISOString(),
      metric: "totalCount" as const,
    });

    await enqueueOutgoingAlerts("p1", [anomaly("p1", "e1", "b1")]);
    await enqueueOutgoingAlerts("p1", [anomaly("p1", "e2", "b2")]);
    await enqueueOutgoingAlerts("p2", [anomaly("p2", "e3", "b3")]);

    const first = await drainOutgoingAlerts();
    assertEquals(Object.keys(first).sort(), ["p1", "p2"]);
    assertEquals(first["p1"].length, 2);
    assertEquals(first["p2"].length, 1);

    // second drain should be empty
    const second = await drainOutgoingAlerts();
    assertEquals(Object.keys(second).length, 0);
  },
});

Deno.test("detectPercentageSpike — suppresses low-volume percentage spikes (find-scene examples)", () => {
  // 1. Email Sent: expected 3.41, actual 8
  const emailStats = buildStats([3.41, 3.41, 3.41, 3.41], "2026-05-27T09");
  assertEquals(
    detectPercentageSpike(emailStats, 8, "p", "Email Sent", "2026-05-27T09"),
    null,
  );

  // 2. Error Occurred: expected 1.03, actual 6
  const errorStats = buildStats([1.03, 1.03, 1.03, 1.03], "2026-05-27T09");
  assertEquals(
    detectPercentageSpike(errorStats, 6, "p", "Error Occurred", "2026-05-27T09"),
    null,
  );

  // 3. Got Video Result: expected 3.76, actual 8
  const videoStats = buildStats([3.76, 3.76, 3.76, 3.76], "2026-05-27T09");
  assertEquals(
    detectPercentageSpike(videoStats, 8, "p", "Got Video Result", "2026-05-27T09"),
    null,
  );

  // 4. Performed Search: expected 8.41, actual 24
  const searchStats = buildStats([8.41, 8.41, 8.41, 8.41], "2026-05-27T09");
  assertEquals(
    detectPercentageSpike(searchStats, 24, "p", "Performed Search", "2026-05-27T09"),
    null,
  );
});

Deno.test("detectPercentageSpike — suppresses noisy high-volume spike (prompt2bot Prompt Constructed)", () => {
  const stats = buildStats(
    [69, 19, 55, 44, 77, 159, 133, 150, 30, 20, 130, 140, 50, 90, 110, 60],
    "2026-05-27T09",
  );
  assertEquals(
    detectPercentageSpike(stats, 197, "p", "Prompt Constructed", "2026-05-27T10"),
    null,
  );
});
