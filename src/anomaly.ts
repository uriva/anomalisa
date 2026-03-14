const kv = await Deno.openKv();

type Stats = {
  mean: number;
  m2: number;
  n: number;
  lastBucket: string;
};

type Metric = "totalCount" | "userSpike" | "percentageSpike";

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
};

const getHourBucket = (): string => new Date().toISOString().slice(0, 13);

export const updateStats = (stats: Stats, value: number): Stats => {
  const n = stats.n + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / n;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;
  return { mean, m2, n, lastBucket: stats.lastBucket };
};

export const stdDev = ({ m2, n }: Stats): number =>
  n < 2 ? 0 : Math.sqrt(m2 / (n - 1));

const round2 = (x: number) => Math.round(x * 100) / 100;

const minDataPoints = 3;
const zScoreThreshold = 2;
const percentageThreshold = 1.0;
const minAbsoluteDiff = 3;
const countTtlMs = 7 * 24 * 60 * 60 * 1000;
const anomalyTtlMs = 30 * 24 * 60 * 60 * 1000;

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

export const updateStatsWithZeros = (stats: Stats, count: number): Stats =>
  Array.from({ length: count }).reduce<Stats>(
    (s) => updateStats(s, 0),
    stats,
  );

export const detectAnomaly = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  metric: Metric,
  userId?: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
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
      bucket: stats.lastBucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: round2(z),
      detectedAt: new Date().toISOString(),
      metric,
      ...(userId ? { userId } : {}),
    }
    : null;
};

export const detectPercentageSpike = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) return null;
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
      bucket: stats.lastBucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: round2(pctChange),
      detectedAt: new Date().toISOString(),
      metric: "percentageSpike",
    }
    : null;
};

const anomalyKey = (
  { projectId, eventName, bucket, metric, userId }: Anomaly,
): Deno.KvKey => ["anomalies", projectId, eventName, bucket, metric, userId ?? "_"];

const storeAnomaly = async (anomaly: Anomaly): Promise<boolean> => {
  const existing = await kv.get(anomalyKey(anomaly));
  return existing.value
    ? false
    : (await kv.atomic()
      .check(existing)
      .set(anomalyKey(anomaly), anomaly, { expireIn: anomalyTtlMs })
      .commit()).ok;
};

const getOrInitStats = async (
  key: Deno.KvKey,
  bucket: string,
): Promise<Stats> => {
  const entry = await kv.get<Stats>(key);
  if (entry.value) return entry.value;
  const initial = emptyStats(bucket);
  await kv.set(key, initial);
  return initial;
};

const incrementAndGet = async (key: Deno.KvKey, ttl: number) => {
  const entry = await kv.get<number>(key);
  const next = (entry.value ?? 0) + 1;
  await kv.set(key, next, { expireIn: ttl });
  return next;
};

const updateMaxUserCount = async (key: Deno.KvKey, userCount: number) => {
  const entry = await kv.get<number>(key);
  const current = entry.value ?? 0;
  if (userCount > current) {
    await kv.set(key, userCount, { expireIn: countTtlMs });
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
    userId,
  );
};

const handleBucketTransition = async (
  stats: Stats,
  projectId: string,
  eventName: string,
  bucket: string,
): Promise<Anomaly[]> => {
  const prevTotalCount =
    (await kv.get<number>(["counts", projectId, eventName, stats.lastBucket]))
      .value ?? 0;

  const skippedHours = Math.max(0, hoursBetween(stats.lastBucket, bucket) - 1);
  const statsWithZeros = updateStatsWithZeros(stats, skippedHours);
  const updatedStats = updateStats(statsWithZeros, prevTotalCount);

  const anomalies = [
    detectAnomaly(
      statsWithZeros,
      prevTotalCount,
      projectId,
      eventName,
      "totalCount",
    ),
    detectPercentageSpike(
      statsWithZeros,
      prevTotalCount,
      projectId,
      eventName,
    ),
  ].filter((a): a is Anomaly => a !== null);

  const prevMaxUserCount = (await kv.get<number>([
    "maxUserCount",
    projectId,
    eventName,
    stats.lastBucket,
  ])).value ?? 0;

  const perUserStatsKey = ["stats", "perUser", projectId, eventName];
  const perUserStats = await getOrInitStats(perUserStatsKey, bucket);
  const perUserSkippedZeros = updateStatsWithZeros(perUserStats, skippedHours);

  const [stored] = await Promise.all([
    Promise.all(anomalies.map(storeAnomaly)),
    kv.set(["stats", "total", projectId, eventName], {
      ...updatedStats,
      lastBucket: bucket,
    }),
    kv.set(perUserStatsKey, {
      ...updateStats(perUserSkippedZeros, prevMaxUserCount),
      lastBucket: bucket,
    }),
  ]);

  const newAnomalies = anomalies.filter((_, i) => stored[i]);

  newAnomalies.forEach((a) =>
    console.warn("ANOMALY DETECTED:", JSON.stringify(a))
  );

  return newAnomalies;
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

  const stored = userSpikeAnomaly && await storeAnomaly(userSpikeAnomaly);
  return stored ? [userSpikeAnomaly] : [];
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
    kv.list<number>({ prefix: ["counts", projectId] }),
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
    kv.list<Anomaly>({ prefix: ["anomalies", projectId] }),
  );
  return entries.map(({ value }) => value);
};
