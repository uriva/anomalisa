const kv = await Deno.openKv();

type Stats = {
  mean: number;
  m2: number;
  n: number;
  lastBucket: string;
};

type Metric = "totalCount" | "userSpike";

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
const countTtlMs = 7 * 24 * 60 * 60 * 1000;
const anomalyTtlMs = 30 * 24 * 60 * 60 * 1000;

export const emptyStats = (lastBucket: string): Stats => ({
  mean: 0,
  m2: 0,
  n: 0,
  lastBucket,
});

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
  const z = sd > 0 ? Math.abs(count - stats.mean) / sd : 0;
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

const storeAnomaly = (projectId: string, anomaly: Anomaly) =>
  kv.set(["anomalies", projectId, anomaly.detectedAt], anomaly, {
    expireIn: anomalyTtlMs,
  });

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
  const perUserStats =
    (await kv.get<Stats>(perUserStatsKey)).value ?? emptyStats(bucket);
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
): Promise<Anomaly | null> => {
  const prevTotalCount =
    (await kv.get<number>(["counts", projectId, eventName, stats.lastBucket]))
      .value ?? 0;

  const anomaly = detectAnomaly(
    stats,
    prevTotalCount,
    projectId,
    eventName,
    "totalCount",
  );

  const prevMaxUserCount =
    (await kv.get<number>([
      "maxUserCount",
      projectId,
      eventName,
      stats.lastBucket,
    ])).value ?? 0;

  const perUserStatsKey = ["stats", "perUser", projectId, eventName];
  const perUserStats =
    (await kv.get<Stats>(perUserStatsKey)).value ?? emptyStats(bucket);

  await Promise.all([
    kv.set(["stats", "total", projectId, eventName], {
      ...updateStats(stats, prevTotalCount),
      lastBucket: bucket,
    }),
    kv.set(perUserStatsKey, {
      ...updateStats(perUserStats, prevMaxUserCount),
      lastBucket: bucket,
    }),
    ...(anomaly ? [storeAnomaly(projectId, anomaly)] : []),
  ]);

  if (anomaly) console.warn("ANOMALY DETECTED:", JSON.stringify(anomaly));

  return anomaly;
};

export const recordEvent = async (
  projectId: string,
  eventName: string,
  userId: string,
): Promise<Anomaly[]> => {
  const bucket = getHourBucket();

  const [, userCount] = await Promise.all([
    incrementAndGet(["counts", projectId, eventName, bucket], countTtlMs),
    incrementAndGet(
      ["userCounts", projectId, eventName, bucket, userId],
      countTtlMs,
    ),
  ]);

  await updateMaxUserCount(
    ["maxUserCount", projectId, eventName, bucket],
    userCount,
  );

  const totalStatsKey = ["stats", "total", projectId, eventName];
  const totalStats =
    (await kv.get<Stats>(totalStatsKey)).value ?? emptyStats(bucket);

  const userSpikeAnomaly = await checkUserSpike(
    projectId,
    eventName,
    bucket,
    userId,
    userCount,
  );

  if (userSpikeAnomaly) {
    await storeAnomaly(projectId, userSpikeAnomaly);
    console.warn("ANOMALY DETECTED:", JSON.stringify(userSpikeAnomaly));
  }

  const bucketAnomaly = totalStats.lastBucket === bucket
    ? null
    : await handleBucketTransition(totalStats, projectId, eventName, bucket);

  return [userSpikeAnomaly, bucketAnomaly].filter(
    (a): a is Anomaly => a !== null,
  );
};

export const getAnomalies = async (projectId: string): Promise<Anomaly[]> => {
  const entries = await Array.fromAsync(
    kv.list<Anomaly>({ prefix: ["anomalies", projectId] }),
  );
  return entries.map(({ value }) => value);
};
