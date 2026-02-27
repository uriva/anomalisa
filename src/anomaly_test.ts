import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Anomaly,
  detectAnomaly,
  emptyStats,
  stdDev,
  updateStats,
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
