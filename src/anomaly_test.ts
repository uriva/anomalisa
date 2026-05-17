import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Anomaly,
  anomalyDirection,
  type CooldownEntry,
  detectAnomaly,
  detectBucketAnomalies,
  detectPercentageDrop,
  detectPercentageSpike,
  detectSkippedHourAnomalies,
  emptyStats,
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
    detectAnomaly(stats, 100, "proj1", "signup", "totalCount"),
    null,
  );
});

Deno.test("detectAnomaly — returns null for normal value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  assertEquals(
    detectAnomaly(stats, 11, "proj1", "signup", "totalCount"),
    null,
  );
});

Deno.test("detectAnomaly — detects totalCount anomaly for extreme value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  const result = detectAnomaly(stats, 100, "proj1", "signup", "totalCount");
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
    "user-abc",
  );
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.metric, "userSpike");
  assertEquals(anomaly.userId, "user-abc");
});

Deno.test("detectAnomaly — ignores single-event user spike", () => {
  assertEquals(
    detectAnomaly(
      buildStats([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], "2026-05-17T15"),
      1,
      "p",
      "e",
      "userSpike",
      "u",
    ),
    null,
  );
});

Deno.test("detectAnomaly — detects anomaly for zero when mean is high", () => {
  const stats = buildStats([100, 102, 98, 101, 99], "2026-01-01T04");
  const result = detectAnomaly(stats, 0, "proj1", "pageview", "totalCount");
  assertEquals(result !== null, true);
});

Deno.test("detectAnomaly — returns null when stdDev is 0 and value equals mean", () => {
  const stats = buildStats([10, 10, 10, 10], "2026-01-01T04");
  assertEquals(
    detectAnomaly(stats, 10, "proj1", "click", "totalCount"),
    null,
  );
});

Deno.test("detectAnomaly — borderline z-score just above threshold triggers", () => {
  const stats = buildStats([10, 20, 30], "2026-01-01T03");
  const sd = stdDev(stats);
  const mean = stats.mean;
  const barelyOver = Math.ceil(mean + 2.1 * sd);
  const result = detectAnomaly(
    stats,
    barelyOver,
    "proj1",
    "test",
    "totalCount",
  );
  assertEquals(result !== null, true);
});

Deno.test("detectAnomaly — borderline z-score just below threshold does not trigger", () => {
  const stats = buildStats([10, 20, 30], "2026-01-01T03");
  const sd = stdDev(stats);
  const mean = stats.mean;
  const barelyUnder = Math.floor(mean + 1.9 * sd);
  assertEquals(
    detectAnomaly(stats, barelyUnder, "proj1", "test", "totalCount"),
    null,
  );
});

Deno.test("detectAnomaly — userSpike omits userId when not provided", () => {
  const stats = buildStats([5, 6, 5, 4, 5], "2026-01-01T04");
  const result = detectAnomaly(stats, 50, "proj1", "event", "userSpike");
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).userId, undefined);
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
    detectPercentageSpike(stats, 20, "proj1", "error"),
    null,
  );
});

Deno.test("detectPercentageSpike — detects spike when mean is 0 and count is above absolute threshold", () => {
  const stats = buildStats([0, 0, 0, 0], "2026-01-01T04");
  const result = detectPercentageSpike(stats, 5, "proj1", "error");
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 5);
});

Deno.test("detectPercentageSpike — returns null when mean is 0 and n < 3", () => {
  const stats = buildStats([0, 0], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 5, "proj1", "error"),
    null,
  );
});

Deno.test("detectPercentageSpike — returns null for normal value", () => {
  const stats = buildStats([10, 12, 11, 10, 13], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 15, "proj1", "error"),
    null,
  );
});

Deno.test("detectPercentageSpike — detects doubling", () => {
  const stats = buildStats([3, 4, 3, 5, 3], "2026-01-01T04");
  const result = detectPercentageSpike(stats, 8, "proj1", "error");
  assertEquals(result !== null, true);
  const anomaly = result as Anomaly;
  assertEquals(anomaly.metric, "percentageSpike");
  assertEquals(anomaly.actual, 8);
  assertEquals(anomaly.zScore > 1, true);
});

Deno.test("detectPercentageSpike — returns null when absolute diff below threshold", () => {
  const stats = buildStats([1, 1, 1, 1], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 3, "proj1", "error"),
    null,
  );
});

Deno.test("detectPercentageSpike — catches doubling that z-score misses in noisy data", () => {
  const stats = buildStats([1, 3, 7, 2, 13, 5, 4, 8], "2026-01-01T04");
  const mean = stats.mean;
  const doubled = Math.ceil(mean * 2.1);
  const zScoreResult = detectAnomaly(
    stats,
    doubled,
    "proj1",
    "error",
    "totalCount",
  );
  const pctResult = detectPercentageSpike(stats, doubled, "proj1", "error");
  assertEquals(zScoreResult, null);
  assertEquals(pctResult !== null, true);
});

Deno.test("detectPercentageDrop — returns null when n < 3", () => {
  assertEquals(
    detectPercentageDrop(buildStats([10, 10], "2026-01-01T02"), 0, "p", "e"),
    null,
  );
});

Deno.test("detectPercentageDrop — returns null for normal value", () => {
  assertEquals(
    detectPercentageDrop(
      buildStats([10, 12, 11, 10, 13], "2026-01-01T04"),
      9,
      "p",
      "e",
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — ignores low-volume drops", () => {
  assertEquals(
    detectPercentageDrop(
      buildStats([12, 12, 12, 12], "2026-01-01T04"),
      4,
      "p",
      "e",
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — detects halving", () => {
  const result = detectPercentageDrop(
    buildStats([100, 110, 90, 105, 95], "2026-01-01T04"),
    30,
    "p",
    "e",
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).metric, "percentageDrop");
  assertEquals((result as Anomaly).actual, 30);
});

Deno.test("detectPercentageDrop — detects drop to zero with high mean", () => {
  const result = detectPercentageDrop(
    buildStats([66, 70, 60, 80, 55], "2026-04-17T09"),
    0,
    "p",
    "Chat Message",
  );
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 0);
});

Deno.test("detectPercentageDrop — returns null when absolute diff below threshold", () => {
  assertEquals(
    detectPercentageDrop(
      buildStats([5, 5, 5, 5], "2026-01-01T04"),
      3,
      "p",
      "e",
    ),
    null,
  );
});

Deno.test("detectPercentageDrop — returns null when mean is 0", () => {
  assertEquals(
    detectPercentageDrop(
      buildStats([0, 0, 0, 0], "2026-01-01T04"),
      0,
      "p",
      "e",
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

Deno.test("detectPercentageDrop — catches halving that z-score misses in noisy data", () => {
  const stats = buildStats(
    [30, 80, 120, 40, 200, 60, 90, 150],
    "2026-01-01T04",
  );
  const halved = Math.floor(stats.mean / 3);
  const zRes = detectAnomaly(stats, halved, "p", "e", "totalCount");
  const pctRes = detectPercentageDrop(stats, halved, "p", "e");
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
  const result = detectAnomaly(stats, 1, "proj1", "Bot Created", "totalCount");
  assertEquals(result !== null, true);
  assertEquals((result as Anomaly).actual, 1);
});

Deno.test("detectPercentageSpike — returns null when mean is 0 and value below absolute threshold", () => {
  const stats = buildStats([0, 0, 0, 0, 0], "2026-01-01T04");
  assertEquals(
    detectPercentageSpike(stats, 1, "proj1", "Bot Created"),
    null,
  );
});

Deno.test("rare event with long gap — z-score detects spike after zeros fill in", () => {
  const stats = updateStatsWithZeros(
    updateStats(emptyStats("2026-02-26T00"), 1),
    133,
  );
  const anomaly = detectAnomaly(stats, 20, "proj1", "credits", "totalCount");
  assertEquals(anomaly !== null, true);
  assertEquals((anomaly as Anomaly).zScore > 2, true);
});

Deno.test("rare event with long gap — percentage spike detects after zeros fill in", () => {
  const stats = updateStatsWithZeros(
    updateStats(emptyStats("2026-02-26T00"), 1),
    133,
  );
  const anomaly = detectPercentageSpike(stats, 20, "proj1", "credits");
  assertEquals(anomaly !== null, true);
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
    );
    consecutiveAlerts.push(anomaly !== null);
    stats = updateStats(stats, newRate);
  }

  const alertCount = consecutiveAlerts.filter((x) => x).length;
  assertEquals(
    alertCount >= 5,
    true,
    `Expected at least 5 consecutive alerts during level shift, got ${alertCount}`,
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
