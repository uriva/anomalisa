let _kv: Deno.Kv | null = null;
const getKv = async () => _kv ??= await Deno.openKv();

type Stats = {
  mean: number;
  m2: number;
  n: number;
  lastBucket: string;
};

type Metric = "totalCount" | "userSpike" | "percentageSpike" | "percentageDrop";

export type Anomaly = {
  projectId: string;
  eventName: string;
  bucket: string;
  expected: number;
  actual: number;
  zScore: number;
  detectedAt: string;
  metric: Metric;
  userId?: string;
  trend?: string;
};

const getHourBucket = (): string => new Date().toISOString().slice(0, 13);

export const updateStats = (stats: Stats, value: number, decay = 1.0): Stats => {
  const n = stats.n * decay + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / n;
  const delta2 = value - mean;
  const m2 = stats.m2 * decay + delta * delta2;
  return { mean, m2, n, lastBucket: stats.lastBucket };
};

export const stdDev = ({ m2, n }: Stats): number =>
  n < 2 ? 0 : Math.sqrt(m2 / (n - 1));

const round2 = (x: number) => Math.round(x * 100) / 100;

const minDataPoints = 3;
const zScoreThreshold = 3;
const percentageThreshold = 1.0;
const minAbsoluteDiff = 3;
const minPercentageDropMean = 30;
const minPercentageSpikeMean = 10;
const minPercentageSpikeZScore = 2.5;
const poissonPThreshold = 1e-3;
const countTtlMs = 7 * 24 * 60 * 60 * 1000;
const anomalyTtlMs = 30 * 24 * 60 * 60 * 1000;
const statsDecay = 0.98;

export const emptyStats = (lastBucket: string): Stats => ({
  mean: 0,
  m2: 0,
  n: 0,
  lastBucket,
});

const bucketToMs = (bucket: string): number =>
  new Date(bucket + ":00:00Z").getTime();

const msPerHour = 60 * 60 * 1000;

export const hoursBetween = (a: string, b: string): number =>
  Math.max(0, Math.round((bucketToMs(b) - bucketToMs(a)) / msPerHour));

export const updateStatsWithZeros = (stats: Stats, count: number, decay = 1.0): Stats =>
  Array.from({ length: count }).reduce<Stats>(
    (s) => updateStats(s, 0, decay),
    stats,
  );

export const detectAnomaly = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  metric: Metric,
  bucket: string,
  userId?: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
  if (count > 0 && count < 2) return null;
  if (metric === "userSpike" && count < 3) return null;
  if (metric === "totalCount" && stats.mean < 1 && count < 5) return null;
  const sd = stdDev(stats);
  const z = sd > 0
    ? Math.abs(count - stats.mean) / sd
    : count !== stats.mean
    ? Infinity
    : 0;
  return z > zScoreThreshold
    ? {
      projectId,
      eventName,
      bucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: round2(z),
      detectedAt: new Date().toISOString(),
      metric,
      ...(userId ? { userId } : {}),
    }
    : null;
};

// Log-gamma via Lanczos approximation. Accurate to ~1e-10 for x > 0.
const lnGamma = (x: number): number => {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0];
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t +
    Math.log(a);
};

// log P(X = k | lambda) for Poisson.
const lnPoissonPmf = (k: number, lambda: number): number => {
  if (lambda === 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(lambda) - lambda - lnGamma(k + 1);
};

// log(a + b) given log(a) and log(b), numerically stable.
const logSumExp = (a: number, b: number): number => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
};

// P(X >= k | lambda). Computed in log space for numerical stability.
const poissonUpperTail = (k: number, lambda: number): number => {
  if (k <= 0) return 1;
  // Sum PMF from 0..k-1 in log space, then complement.
  let logSum = -Infinity;
  for (let i = 0; i < k; i++) {
    logSum = logSumExp(logSum, lnPoissonPmf(i, lambda));
  }
  const cdfBelow = Math.exp(logSum);
  return Math.max(0, 1 - cdfBelow);
};

// P(X <= k | lambda).
const poissonLowerTail = (k: number, lambda: number): number => {
  if (k < 0) return 0;
  let logSum = -Infinity;
  for (let i = 0; i <= k; i++) {
    logSum = logSumExp(logSum, lnPoissonPmf(i, lambda));
  }
  return Math.min(1, Math.exp(logSum));
};

// Two-sided Poisson tail probability: 2 * min(upper, lower), clipped to 1.
const poissonTwoSidedP = (count: number, lambda: number): number => {
  if (lambda <= 0) return count === 0 ? 1 : 0;
  const upper = poissonUpperTail(count, lambda);
  const lower = poissonLowerTail(count, lambda);
  return Math.min(1, 2 * Math.min(upper, lower));
};

export const detectPoissonAnomaly = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  bucket: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
  // At very sparse baselines the Poisson tail probability becomes statistically
  // significant for tiny absolute counts (e.g. lambda=0.03, count=2 -> p<1e-3),
  // but a couple of events in an hour isn't an alert-worthy event. Mirror the
  // floor in detectAnomaly: when the baseline is below 1/hr, require at least
  // 5 events to fire.
  if (stats.mean < 1 && count < 5) return null;
  const lambda = stats.mean;
  const p = poissonTwoSidedP(count, lambda);
  if (!(p < poissonPThreshold)) return null;
  const score = p > 0 ? -Math.log10(p) : Infinity;
  return {
    projectId,
    eventName,
    bucket,
    expected: round2(lambda),
    actual: count,
    zScore: round2(score),
    detectedAt: new Date().toISOString(),
    metric: "totalCount",
  };
};

export const detectPercentageSpike = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  bucket: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
  if (stats.mean < minPercentageSpikeMean) return null;
  const sd = stdDev(stats);
  const z = sd > 0 ? (count - stats.mean) / sd : Infinity;
  if (z < minPercentageSpikeZScore) return null;
  const pctChange = stats.mean > 0
    ? (count - stats.mean) / stats.mean
    : count > 0
    ? Infinity
    : 0;
  return pctChange > percentageThreshold &&
      count - stats.mean >= minAbsoluteDiff
    ? {
      projectId,
      eventName,
      bucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: round2(pctChange),
      detectedAt: new Date().toISOString(),
      metric: "percentageSpike",
    }
    : null;
};

export const detectPercentageDrop = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  bucket: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
  if (stats.mean < minPercentageDropMean) return null;
  const pctChange = (stats.mean - count) / stats.mean;
  return pctChange > percentageThreshold / 2 &&
      stats.mean - count >= minAbsoluteDiff
    ? {
      projectId,
      eventName,
      bucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: round2(pctChange),
      detectedAt: new Date().toISOString(),
      metric: "percentageDrop",
    }
    : null;
};

const detectSkippedHour = (
  stats: Stats,
  projectId: string,
  eventName: string,
): Anomaly[] =>
  [
    detectPoissonAnomaly(stats, 0, projectId, eventName, stats.lastBucket),
    detectPercentageDrop(stats, 0, projectId, eventName, stats.lastBucket),
  ].filter((a): a is Anomaly => a !== null);

const skippedHourStep = (
  projectId: string,
  eventName: string,
  decay = 1.0,
) =>
(
  { stats, anomalies }: { stats: Stats; anomalies: Anomaly[] },
): { stats: Stats; anomalies: Anomaly[] } => ({
  stats: updateStats(stats, 0, decay),
  anomalies: [...anomalies, ...detectSkippedHour(stats, projectId, eventName)],
});

export const detectSkippedHourAnomalies = (
  stats: Stats,
  skippedHours: number,
  projectId: string,
  eventName: string,
  decay = 1.0,
): Anomaly[] =>
  Array.from({ length: skippedHours }).reduce<
    { stats: Stats; anomalies: Anomaly[] }
  >(
    skippedHourStep(projectId, eventName, decay),
    { stats, anomalies: [] },
  ).anomalies;

export const detectBucketAnomalies = (
  stats: Stats,
  hourStats: Stats,
  prevTotalCount: number,
  skippedHours: number,
  projectId: string,
  eventName: string,
  decay = 1.0,
): Anomaly[] => {
  const statsWithZeros = updateStatsWithZeros(stats, skippedHours, decay);
  const hourHasData = hourStats.n >= minDataPoints;
  const bucket = stats.lastBucket;
  return [
    ...detectSkippedHourAnomalies(stats, skippedHours, projectId, eventName, decay),
    detectPoissonAnomaly(
      hourHasData ? hourStats : statsWithZeros,
      prevTotalCount,
      projectId,
      eventName,
      bucket,
    ),
    hourHasData
      ? detectPercentageSpike(hourStats, prevTotalCount, projectId, eventName, bucket)
      : detectPercentageSpike(statsWithZeros, prevTotalCount, projectId, eventName, bucket),
    detectPercentageDrop(hourStats, prevTotalCount, projectId, eventName, bucket),
  ].filter((a): a is Anomaly => a !== null);
};

export type Direction = "high" | "low";

export const anomalyDirection = (a: Anomaly): Direction =>
  a.actual > a.expected ? "high" : "low";

const anomalyKey = (
  { projectId, eventName, bucket, metric, userId }: Anomaly,
): Deno.KvKey => [
  "anomalies",
  projectId,
  eventName,
  bucket,
  metric,
  userId ?? "_",
];

const storeAnomaly = async (anomaly: Anomaly): Promise<boolean> => {
  const existing = await (await getKv()).get(anomalyKey(anomaly));
  return existing.value ? false : (await (await getKv()).atomic()
    .check(existing)
    .set(anomalyKey(anomaly), anomaly, { expireIn: anomalyTtlMs })
    .commit()).ok;
};

export const getTrendIndication = async (
  projectId: string,
  eventName: string,
  currentDirection: "high" | "low",
): Promise<string | null> => {
  const allAnomalies = await getAnomalies(projectId);
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const recentSameEventAndDirection = allAnomalies.filter((a) => {
    if (a.eventName !== eventName) return false;
    const direction = anomalyDirection(a);
    if (direction !== currentDirection) return false;
    const detectedMs = new Date(a.detectedAt).getTime();
    return detectedMs >= oneDayAgo && detectedMs < now;
  });

  if (recentSameEventAndDirection.length >= 1) {
    const count = recentSameEventAndDirection.length + 1;
    return currentDirection === "high"
      ? `📈 Recurring growth trend (${count} alerts in the last 24h)`
      : `📉 Recurring decrease trend (${count} alerts in the last 24h)`;
  }
  return null;
};

const attachTrendToAnomaly = async (anomaly: Anomaly): Promise<Anomaly> => {
  const direction = anomalyDirection(anomaly);
  const trend = await getTrendIndication(anomaly.projectId, anomaly.eventName, direction);
  return trend ? { ...anomaly, trend } : anomaly;
};

const storeAndFilter = async (anomalies: Anomaly[]): Promise<Anomaly[]> => {
  const anomaliesWithTrends = await Promise.all(anomalies.map(attachTrendToAnomaly));
  const stored = await Promise.all(anomaliesWithTrends.map(storeAnomaly));
  return anomaliesWithTrends.filter((_, i) => stored[i]);
};

const getOrInitStats = async (
  key: Deno.KvKey,
  bucket: string,
): Promise<Stats> => {
  const entry = await (await getKv()).get<Stats>(key);
  if (entry.value) return entry.value;
  const initial = emptyStats(bucket);
  await (await getKv()).set(key, initial);
  return initial;
};

const incrementAndGet = async (key: Deno.KvKey, ttl: number) => {
  const entry = await (await getKv()).get<number>(key);
  const next = (entry.value ?? 0) + 1;
  await (await getKv()).set(key, next, { expireIn: ttl });
  return next;
};

const updateMaxUserCount = async (key: Deno.KvKey, userCount: number) => {
  const entry = await (await getKv()).get<number>(key);
  const current = entry.value ?? 0;
  if (userCount > current) {
    await (await getKv()).set(key, userCount, { expireIn: countTtlMs });
  }
};

const checkUserSpike = async (
  projectId: string,
  eventName: string,
  bucket: string,
  userId: string,
  userCount: number,
): Promise<Anomaly | null> => {
  const perUserStatsKey = ["stats", "perUser", projectId, eventName];
  const perUserStats = await getOrInitStats(perUserStatsKey, bucket);
  return detectAnomaly(
    perUserStats,
    userCount,
    projectId,
    eventName,
    "userSpike",
    bucket,
    userId,
  );
};

const handleBucketTransition = async (
  stats: Stats,
  projectId: string,
  eventName: string,
  bucket: string,
): Promise<Anomaly[]> => {
  const prevTotalCount = (await (await getKv()).get<number>([
    "counts",
    projectId,
    eventName,
    stats.lastBucket,
  ]))
    .value ?? 0;

  const skippedHours = Math.max(0, hoursBetween(stats.lastBucket, bucket) - 1);
  const statsWithZeros = updateStatsWithZeros(stats, skippedHours, statsDecay);
  const updatedStats = updateStats(statsWithZeros, prevTotalCount, statsDecay);

  const prevHourOfDay = parseInt(stats.lastBucket.slice(-2), 10);
  const hourStatsKey = ["stats", "byHour", projectId, eventName, prevHourOfDay];
  const hourStats = await getOrInitStats(hourStatsKey, stats.lastBucket);

  const anomalies = detectBucketAnomalies(
    stats,
    hourStats,
    prevTotalCount,
    skippedHours,
    projectId,
    eventName,
    statsDecay,
  );

  const prevMaxUserCount = (await (await getKv()).get<number>([
    "maxUserCount",
    projectId,
    eventName,
    stats.lastBucket,
  ])).value ?? 0;

  const perUserStatsKey = ["stats", "perUser", projectId, eventName];
  const perUserStats = await getOrInitStats(perUserStatsKey, bucket);
  const perUserSkippedZeros = updateStatsWithZeros(perUserStats, skippedHours, statsDecay);

  const [notifiable] = await Promise.all([
    storeAndFilter(anomalies),
    (await getKv()).set(["stats", "total", projectId, eventName], {
      ...updatedStats,
      lastBucket: bucket,
    }),
    (await getKv()).set(perUserStatsKey, {
      ...updateStats(perUserSkippedZeros, prevMaxUserCount, statsDecay),
      lastBucket: bucket,
    }),
    (await getKv()).set(hourStatsKey, updateStats(hourStats, prevTotalCount, statsDecay)),
  ]);

  notifiable.forEach((a) =>
    console.warn("ANOMALY DETECTED:", JSON.stringify(a))
  );

  return notifiable;
};

const trackUserSpike = async (
  projectId: string,
  eventName: string,
  bucket: string,
  userId: string,
): Promise<Anomaly[]> => {
  const userCount = await incrementAndGet(
    ["userCounts", projectId, eventName, bucket, userId],
    countTtlMs,
  );

  await updateMaxUserCount(
    ["maxUserCount", projectId, eventName, bucket],
    userCount,
  );

  const userSpikeAnomaly = await checkUserSpike(
    projectId,
    eventName,
    bucket,
    userId,
    userCount,
  );

  return userSpikeAnomaly ? storeAndFilter([userSpikeAnomaly]) : [];
};

export const recordEvent = async (
  projectId: string,
  eventName: string,
  userId?: string,
): Promise<Anomaly[]> => {
  const bucket = getHourBucket();

  await incrementAndGet(["counts", projectId, eventName, bucket], countTtlMs);

  const totalStatsKey = ["stats", "total", projectId, eventName];
  const totalStats = await getOrInitStats(totalStatsKey, bucket);

  const newUserSpike = userId
    ? await trackUserSpike(projectId, eventName, bucket, userId)
    : [];

  newUserSpike.forEach((a) =>
    console.warn("ANOMALY DETECTED:", JSON.stringify(a))
  );

  const bucketAnomalies = totalStats.lastBucket === bucket
    ? []
    : await handleBucketTransition(totalStats, projectId, eventName, bucket);

  return [...newUserSpike, ...bucketAnomalies];
};

export const getEventCounts = async (
  projectId: string,
): Promise<Record<string, Array<{ bucket: string; count: number }>>> => {
  const entries = await Array.fromAsync(
    (await getKv()).list<number>({ prefix: ["counts", projectId] }),
  );
  const events: Record<string, Array<{ bucket: string; count: number }>> = {};
  entries.forEach(({ key, value }) => {
    const eventName = String(key[2]);
    const bucket = String(key[3]);
    (events[eventName] ??= []).push({ bucket, count: value });
  });
  Object.values(events).forEach((arr) =>
    arr.sort((a, b) => a.bucket.localeCompare(b.bucket))
  );
  return events;
};

export const getMaxUserCounts = async (
  projectId: string,
): Promise<Record<string, Array<{ bucket: string; count: number }>>> => {
  const entries = await Array.fromAsync(
    (await getKv()).list<number>({ prefix: ["maxUserCount", projectId] }),
  );
  const events: Record<string, Array<{ bucket: string; count: number }>> = {};
  entries.forEach(({ key, value }) => {
    const eventName = String(key[2]);
    const bucket = String(key[3]);
    (events[eventName] ??= []).push({ bucket, count: value });
  });
  Object.values(events).forEach((arr) =>
    arr.sort((a, b) => a.bucket.localeCompare(b.bucket))
  );
  return events;
};

export const getAnomalies = async (projectId: string): Promise<Anomaly[]> => {
  const entries = await Array.fromAsync(
    (await getKv()).list<Anomaly>({ prefix: ["anomalies", projectId] }),
  );
  return entries.map(({ value }) => value);
};

export const checkAllEmptyBuckets = async (): Promise<
  Record<string, Anomaly[]>
> => {
  const currentBucket = getHourBucket();
  const entries = await Array.fromAsync(
    (await getKv()).list<Stats>({ prefix: ["stats", "total"] }),
  );

  const anomaliesByProject: Record<string, Anomaly[]> = {};
  for (const { key, value } of entries) {
    const projectId = String(key[2]);
    const eventName = String(key[3]);
    if (value.lastBucket !== currentBucket) {
      const anomalies = await handleBucketTransition(
        value,
        projectId,
        eventName,
        currentBucket,
      );
      if (anomalies.length > 0) {
        (anomaliesByProject[projectId] ??= []).push(...anomalies);
      }
    }
  }
  return anomaliesByProject;
};

const outgoingAlertsPrefix = (projectId: string): Deno.KvKey => [
  "outgoingAlerts",
  projectId,
];

const outgoingAlertTtlMs = 5 * 60 * 1000;

export const enqueueOutgoingAlerts = async (
  projectId: string,
  anomalies: Anomaly[],
): Promise<void> => {
  const now = Date.now();
  const kv = await getKv();
  await Promise.all(
    anomalies.map((a, i) =>
      kv.set([...outgoingAlertsPrefix(projectId), `${now}-${i}`], a, {
        expireIn: outgoingAlertTtlMs,
      })
    ),
  );
};

export const drainOutgoingAlerts = async (): Promise<
  Record<string, Anomaly[]>
> => {
  const kv = await getKv();
  const entries = await Array.fromAsync(
    kv.list<Anomaly>({ prefix: ["outgoingAlerts"] }),
  );
  const byProject: Record<string, Anomaly[]> = {};
  for (const { key, value } of entries) {
    const projectId = String(key[1]);
    (byProject[projectId] ??= []).push(value);
    kv.delete(key).catch(() => {});
  }
  return byProject;
};
