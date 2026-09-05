import { getTurso } from "./turso.ts";

export type Stats = {
  mean: number;
  m2: number;
  n: number;
  lastBucket: string;
};

export type Metric =
  | "totalCount"
  | "userSpike"
  | "percentageSpike"
  | "percentageDrop";

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

export const updateStats = (
  stats: Stats,
  value: number,
  decay = 1.0,
): Stats => {
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
const minColdStartCount = 5;
const zScoreThreshold = 3;
const percentageThreshold = 1.0;
const minAbsoluteDiff = 3;
const minPercentageDropMean = 30;
const minPercentageDropZScore = 1.05;
const minPercentageSpikeMean = 10;
const minPercentageSpikeZScore = 2.5;
const poissonPThreshold = 1e-3;
const lnPoissonPThreshold = Math.log(poissonPThreshold);
const countTtlMs = 7 * 24 * 60 * 60 * 1000;
const anomalyTtlMs = 30 * 24 * 60 * 60 * 1000;
const cooldownTtlMs = 48 * 60 * 60 * 1000;
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

export const updateStatsWithZeros = (
  stats: Stats,
  count: number,
  decay = 1.0,
): Stats =>
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
  if (
    (metric === "totalCount" || metric === "userSpike") && stats.mean > 0 &&
    stats.mean < 1 && count < 5
  ) return null;
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

const lnPoissonPmf = (k: number, lambda: number): number => {
  if (lambda === 0) return k === 0 ? 0 : -Infinity;
  return k * Math.log(lambda) - lambda - lnGamma(k + 1);
};

const logSumExp = (a: number, b: number): number => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
};

const lnPoissonRangeMass = (
  lambda: number,
  from: number,
  length: number,
): number =>
  Array.from({ length }).reduce<number>(
    (logSum, _, i) => logSumExp(logSum, lnPoissonPmf(from + i, lambda)),
    -Infinity,
  );

const upperTailTerms = (lambda: number): number =>
  Math.ceil(10 * Math.sqrt(lambda)) + 10;

const lnPoissonUpperTail = (k: number, lambda: number): number =>
  lnPoissonRangeMass(lambda, Math.max(0, k), upperTailTerms(lambda));

const lnPoissonLowerTail = (k: number, lambda: number): number =>
  k < 0 ? -Infinity : lnPoissonRangeMass(lambda, 0, k + 1);

const lnPoissonTwoSidedP = (count: number, lambda: number): number =>
  lambda <= 0 ? count === 0 ? 0 : -Infinity : Math.min(
    0,
    Math.LN2 +
      (count >= lambda
        ? lnPoissonUpperTail(count, lambda)
        : lnPoissonLowerTail(count, lambda)),
  );

export const detectPoissonAnomaly = (
  stats: Stats,
  count: number,
  projectId: string,
  eventName: string,
  bucket: string,
): Anomaly | null => {
  if (stats.n < minDataPoints) {
    if (count < minColdStartCount) return null;
    return {
      projectId,
      eventName,
      bucket,
      expected: round2(stats.mean),
      actual: count,
      zScore: Infinity,
      detectedAt: new Date().toISOString(),
      metric: "totalCount",
    };
  }
  if (stats.mean >= 10 && stdDev(stats) > Math.sqrt(stats.mean)) {
    return detectAnomaly(
      stats,
      count,
      projectId,
      eventName,
      "totalCount",
      bucket,
    );
  }
  if (stats.mean > 0 && stats.mean < 1) {
    if (count < 5) return null;
  } else if (stats.mean >= 1) {
    if (Math.abs(count - stats.mean) < 10) return null;
  }
  const lambda = stats.mean;
  const lnP = lnPoissonTwoSidedP(count, lambda);
  if (!(lnP < lnPoissonPThreshold)) return null;
  const score = -lnP / Math.LN10;
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
  const sd = stdDev(stats);
  const z = sd > 0 ? (stats.mean - count) / sd : Infinity;
  if (z < minPercentageDropZScore) return null;
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
    ...detectSkippedHourAnomalies(
      stats,
      skippedHours,
      projectId,
      eventName,
      decay,
    ),
    detectPoissonAnomaly(
      hourHasData ? hourStats : statsWithZeros,
      prevTotalCount,
      projectId,
      eventName,
      bucket,
    ),
    hourHasData
      ? detectPercentageSpike(
        hourStats,
        prevTotalCount,
        projectId,
        eventName,
        bucket,
      )
      : detectPercentageSpike(
        statsWithZeros,
        prevTotalCount,
        projectId,
        eventName,
        bucket,
      ),
    detectPercentageDrop(
      hourStats,
      prevTotalCount,
      projectId,
      eventName,
      bucket,
    ),
  ].filter((a): a is Anomaly => a !== null);
};

export type Direction = "high" | "low";

export const anomalyDirection = (a: Anomaly): Direction =>
  a.actual > a.expected ? "high" : "low";

export type CooldownEntry = { direction: Direction; actual: number };

const escalationFactor = 2;

export const shouldSuppress = (
  lastEntry: CooldownEntry | null,
  anomaly: Anomaly,
): boolean => {
  if (!lastEntry) return false;
  const direction = anomalyDirection(anomaly);
  if (lastEntry.direction !== direction) return false;
  const isEscalation = direction === "high"
    ? anomaly.actual > lastEntry.actual * escalationFactor
    : anomaly.actual < lastEntry.actual / escalationFactor;
  return !isEscalation;
};

const storeAnomaly = async (anomaly: Anomaly): Promise<boolean> => {
  const result = await getTurso().execute({
    sql: `INSERT INTO anomalies (project_id, event_name, bucket, metric, user_id, expected, actual, z_score, detected_at, trend, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, event_name, bucket, metric, user_id) DO NOTHING;`,
    args: [
      anomaly.projectId,
      anomaly.eventName,
      anomaly.bucket,
      anomaly.metric,
      anomaly.userId ?? "_",
      anomaly.expected,
      anomaly.actual,
      anomaly.zScore,
      anomaly.detectedAt,
      anomaly.trend ?? null,
      Date.now(),
    ],
  });
  return result.rowsAffected > 0;
};

export const checkAndSetCooldown = async (
  anomaly: Anomaly,
): Promise<boolean> => {
  const direction = anomalyDirection(anomaly);
  const now = Date.now();
  const res = await getTurso().execute({
    sql: `SELECT actual, expires_at FROM cooldowns
          WHERE project_id = ? AND event_name = ? AND metric = ? AND direction = ? AND user_id = ?;`,
    args: [
      anomaly.projectId,
      anomaly.eventName,
      anomaly.metric,
      direction,
      anomaly.userId ?? "_",
    ],
  });
  const row = res.rows[0];
  const lastEntry: CooldownEntry | null =
    row && Number(row.expires_at) > now
      ? { direction, actual: Number(row.actual) }
      : null;
  if (shouldSuppress(lastEntry, anomaly)) return false;
  await getTurso().execute({
    sql: `INSERT INTO cooldowns (project_id, event_name, metric, direction, user_id, actual, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, event_name, metric, direction, user_id)
          DO UPDATE SET actual = excluded.actual, expires_at = excluded.expires_at;`,
    args: [
      anomaly.projectId,
      anomaly.eventName,
      anomaly.metric,
      direction,
      anomaly.userId ?? "_",
      anomaly.actual,
      now + cooldownTtlMs,
    ],
  });
  return true;
};

const mapAnomalyRow = (row: Record<string, unknown>): Anomaly => ({
  projectId: String(row.project_id),
  eventName: String(row.event_name),
  bucket: String(row.bucket),
  metric: row.metric as Metric,
  expected: Number(row.expected),
  actual: Number(row.actual),
  zScore: Number(row.z_score),
  detectedAt: String(row.detected_at),
  ...(row.user_id && row.user_id !== "_" ? { userId: String(row.user_id) } : {}),
  ...(row.trend ? { trend: String(row.trend) } : {}),
});

const getEventAnomalies = async (
  projectId: string,
  eventName: string,
): Promise<Anomaly[]> => {
  const res = await getTurso().execute({
    sql: `SELECT project_id, event_name, bucket, metric, user_id, expected, actual, z_score, detected_at, trend
          FROM anomalies
          WHERE project_id = ? AND event_name = ?;`,
    args: [projectId, eventName],
  });
  return res.rows.map((row) => mapAnomalyRow(row as Record<string, unknown>));
};

export const getTrendIndication = async (
  projectId: string,
  eventName: string,
  currentDirection: "high" | "low",
): Promise<string | null> => {
  const eventAnomalies = await getEventAnomalies(projectId, eventName);
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const recentSameEventAndDirection = eventAnomalies.filter((a) => {
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
  const trend = await getTrendIndication(
    anomaly.projectId,
    anomaly.eventName,
    direction,
  );
  return trend ? { ...anomaly, trend } : anomaly;
};

const storeAndFilter = async (anomalies: Anomaly[]): Promise<Anomaly[]> => {
  const anomaliesWithTrends = await Promise.all(
    anomalies.map(attachTrendToAnomaly),
  );
  const stored = await Promise.all(anomaliesWithTrends.map(storeAnomaly));
  const newAnomalies = anomaliesWithTrends.filter((_, i) => stored[i]);
  const unsuppressed = await Promise.all(
    newAnomalies.map(checkAndSetCooldown),
  );
  return newAnomalies.filter((_, i) => unsuppressed[i]);
};

const getOrInitStats = async (
  projectId: string,
  eventName: string,
  type: string,
  bucket: string,
): Promise<Stats> => {
  const res = await getTurso().execute({
    sql: `SELECT mean, m2, n, last_bucket FROM stats
          WHERE project_id = ? AND event_name = ? AND type = ?;`,
    args: [projectId, eventName, type],
  });
  const row = res.rows[0];
  if (row) {
    return {
      mean: Number(row.mean),
      m2: Number(row.m2),
      n: Number(row.n),
      lastBucket: String(row.last_bucket || bucket),
    };
  }
  const initial = emptyStats(bucket);
  await getTurso().execute({
    sql: `INSERT INTO stats (project_id, event_name, type, mean, m2, n, last_bucket)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, event_name, type) DO NOTHING;`,
    args: [
      projectId,
      eventName,
      type,
      initial.mean,
      initial.m2,
      initial.n,
      initial.lastBucket,
    ],
  });
  return initial;
};

const saveStats = (
  projectId: string,
  eventName: string,
  type: string,
  stats: Stats,
) =>
  getTurso().execute({
    sql: `INSERT INTO stats (project_id, event_name, type, mean, m2, n, last_bucket)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (project_id, event_name, type)
          DO UPDATE SET mean = excluded.mean, m2 = excluded.m2, n = excluded.n, last_bucket = excluded.last_bucket;`,
    args: [
      projectId,
      eventName,
      type,
      stats.mean,
      stats.m2,
      stats.n,
      stats.lastBucket,
    ],
  });

const incrementCount = async (
  projectId: string,
  eventName: string,
  bucket: string,
): Promise<number> => {
  const res = await getTurso().execute({
    sql: `INSERT INTO counts (project_id, event_name, bucket, count, created_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (project_id, event_name, bucket)
          DO UPDATE SET count = count + 1
          RETURNING count;`,
    args: [projectId, eventName, bucket, Date.now()],
  });
  return Number(res.rows[0].count);
};

const incrementUserCount = async (
  projectId: string,
  eventName: string,
  bucket: string,
  userId: string,
): Promise<number> => {
  const res = await getTurso().execute({
    sql: `INSERT INTO user_counts (project_id, event_name, bucket, user_id, count, created_at)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT (project_id, event_name, bucket, user_id)
          DO UPDATE SET count = count + 1
          RETURNING count;`,
    args: [projectId, eventName, bucket, userId, Date.now()],
  });
  return Number(res.rows[0].count);
};

const updateMaxUserCount = (
  projectId: string,
  eventName: string,
  bucket: string,
  count: number,
) =>
  getTurso().execute({
    sql: `INSERT INTO max_user_counts (project_id, event_name, bucket, count, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (project_id, event_name, bucket)
          DO UPDATE SET count = MAX(count, excluded.count);`,
    args: [projectId, eventName, bucket, count, Date.now()],
  });

const getCount = async (
  projectId: string,
  eventName: string,
  bucket: string,
): Promise<number> => {
  const res = await getTurso().execute({
    sql: `SELECT count FROM counts WHERE project_id = ? AND event_name = ? AND bucket = ?;`,
    args: [projectId, eventName, bucket],
  });
  return res.rows[0] ? Number(res.rows[0].count) : 0;
};

const getMaxUserCount = async (
  projectId: string,
  eventName: string,
  bucket: string,
): Promise<number> => {
  const res = await getTurso().execute({
    sql: `SELECT count FROM max_user_counts WHERE project_id = ? AND event_name = ? AND bucket = ?;`,
    args: [projectId, eventName, bucket],
  });
  return res.rows[0] ? Number(res.rows[0].count) : 0;
};

const checkUserSpike = async (
  projectId: string,
  eventName: string,
  bucket: string,
  userId: string,
  userCount: number,
): Promise<Anomaly | null> => {
  const perUserStats = await getOrInitStats(
    projectId,
    eventName,
    "perUser",
    bucket,
  );
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
  const prevTotalCount = await getCount(projectId, eventName, stats.lastBucket);

  const skippedHours = Math.max(0, hoursBetween(stats.lastBucket, bucket) - 1);
  const statsWithZeros = updateStatsWithZeros(stats, skippedHours, statsDecay);
  const updatedStats = updateStats(statsWithZeros, prevTotalCount, statsDecay);

  const prevHourOfDay = parseInt(stats.lastBucket.slice(-2), 10);
  const hourStats = await getOrInitStats(
    projectId,
    eventName,
    `byHour:${prevHourOfDay}`,
    stats.lastBucket,
  );

  const anomalies = detectBucketAnomalies(
    stats,
    hourStats,
    prevTotalCount,
    skippedHours,
    projectId,
    eventName,
    statsDecay,
  );

  const prevMaxUserCount = await getMaxUserCount(
    projectId,
    eventName,
    stats.lastBucket,
  );

  const perUserStats = await getOrInitStats(
    projectId,
    eventName,
    "perUser",
    bucket,
  );
  const perUserSkippedZeros = updateStatsWithZeros(
    perUserStats,
    skippedHours,
    statsDecay,
  );

  const [notifiable] = await Promise.all([
    storeAndFilter(anomalies),
    saveStats(projectId, eventName, "total", {
      ...updatedStats,
      lastBucket: bucket,
    }),
    saveStats(
      projectId,
      eventName,
      "perUser",
      {
        ...updateStats(perUserSkippedZeros, prevMaxUserCount, statsDecay),
        lastBucket: bucket,
      },
    ),
    saveStats(
      projectId,
      eventName,
      `byHour:${prevHourOfDay}`,
      updateStats(hourStats, prevTotalCount, statsDecay),
    ),
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
  const userCount = await incrementUserCount(
    projectId,
    eventName,
    bucket,
    userId,
  );

  await updateMaxUserCount(projectId, eventName, bucket, userCount);

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

  await incrementCount(projectId, eventName, bucket);

  const totalStats = await getOrInitStats(
    projectId,
    eventName,
    "total",
    bucket,
  );

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
  const res = await getTurso().execute({
    sql: `SELECT event_name, bucket, count FROM counts WHERE project_id = ? ORDER BY bucket ASC;`,
    args: [projectId],
  });
  const events: Record<string, Array<{ bucket: string; count: number }>> = {};
  res.rows.forEach((row) => {
    const eventName = String(row.event_name);
    const bucket = String(row.bucket);
    const count = Number(row.count);
    (events[eventName] ??= []).push({ bucket, count });
  });
  return events;
};

export const getMaxUserCounts = async (
  projectId: string,
): Promise<Record<string, Array<{ bucket: string; count: number }>>> => {
  const res = await getTurso().execute({
    sql: `SELECT event_name, bucket, count FROM max_user_counts WHERE project_id = ? ORDER BY bucket ASC;`,
    args: [projectId],
  });
  const events: Record<string, Array<{ bucket: string; count: number }>> = {};
  res.rows.forEach((row) => {
    const eventName = String(row.event_name);
    const bucket = String(row.bucket);
    const count = Number(row.count);
    (events[eventName] ??= []).push({ bucket, count });
  });
  return events;
};

export const getAnomalies = async (projectId: string): Promise<Anomaly[]> => {
  const res = await getTurso().execute({
    sql: `SELECT project_id, event_name, bucket, metric, user_id, expected, actual, z_score, detected_at, trend
          FROM anomalies
          WHERE project_id = ?
          ORDER BY detected_at DESC;`,
    args: [projectId],
  });
  return res.rows.map((row) => mapAnomalyRow(row as Record<string, unknown>));
};

export const checkAllEmptyBuckets = async (): Promise<
  Record<string, Anomaly[]>
> => {
  const currentBucket = getHourBucket();
  const res = await getTurso().execute(
    "SELECT project_id, event_name, mean, m2, n, last_bucket FROM stats WHERE type = 'total';",
  );

  const anomaliesByProject: Record<string, Anomaly[]> = {};
  for (const row of res.rows) {
    const projectId = String(row.project_id);
    const eventName = String(row.event_name);
    const lastBucket = String(row.last_bucket);
    if (lastBucket !== currentBucket) {
      const stats: Stats = {
        mean: Number(row.mean),
        m2: Number(row.m2),
        n: Number(row.n),
        lastBucket,
      };
      const anomalies = await handleBucketTransition(
        stats,
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

export const enqueueOutgoingAlerts = async (
  projectId: string,
  anomalies: Anomaly[],
): Promise<void> => {
  const now = Date.now();
  await getTurso().batch(
    anomalies.map((a, i) => ({
      sql:
        `INSERT INTO outgoing_alerts (id, project_id, payload, created_at) VALUES (?, ?, ?, ?);`,
      args: [`${projectId}-${now}-${i}`, projectId, JSON.stringify(a), now],
    })),
    "write",
  );
};

export const drainOutgoingAlerts = async (): Promise<
  Record<string, Anomaly[]>
> => {
  const res = await getTurso().execute(
    "SELECT id, project_id, payload FROM outgoing_alerts;",
  );
  if (res.rows.length === 0) return {};
  const ids = res.rows.map((r) => String(r.id));
  await getTurso().batch(
    ids.map((id) => ({
      sql: "DELETE FROM outgoing_alerts WHERE id = ?;",
      args: [id],
    })),
    "write",
  );
  const byProject: Record<string, Anomaly[]> = {};
  for (const row of res.rows) {
    const projectId = String(row.project_id);
    try {
      const anomaly = JSON.parse(String(row.payload)) as Anomaly;
      (byProject[projectId] ??= []).push(anomaly);
    } catch {
      // ignore
    }
  }
  return byProject;
};

export const cleanExpiredData = async () => {
  const now = Date.now();
  await getTurso().batch(
    [
      {
        sql: "DELETE FROM counts WHERE created_at < ?;",
        args: [now - countTtlMs],
      },
      {
        sql: "DELETE FROM user_counts WHERE created_at < ?;",
        args: [now - countTtlMs],
      },
      {
        sql: "DELETE FROM max_user_counts WHERE created_at < ?;",
        args: [now - countTtlMs],
      },
      {
        sql: "DELETE FROM anomalies WHERE created_at < ?;",
        args: [now - anomalyTtlMs],
      },
      {
        sql: "DELETE FROM cooldowns WHERE expires_at < ?;",
        args: [now],
      },
      {
        sql: "DELETE FROM email_rate_limits WHERE expires_at < ?;",
        args: [now],
      },
    ],
    "write",
  );
};
