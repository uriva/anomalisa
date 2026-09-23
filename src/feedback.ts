import { empty } from "gamla";
import type { Anomaly } from "./anomaly.ts";
import { getTurso } from "./turso.ts";

export type FeedbackRating = "good" | "bad";

type BucketCount = { bucket: string; count: number };
export type EventCounts = Record<string, BucketCount[]>;

export type AlertFeedbackRecord = {
  token: string;
  projectId: string;
  eventName: string;
  bucket: string;
  metric: string;
  userId: string;
  expected: number;
  actual: number;
  zScore: number;
  anomaliesJson: string;
  historyJson: string;
  statsJson: string | null;
  rating: FeedbackRating | null;
  feedbackAt: number | null;
  createdAt: number;
};

export const groupByEventBucket = (anomalies: Anomaly[]) => {
  const map: Record<string, Anomaly[]> = {};
  anomalies.forEach((a) => {
    const key = `${a.eventName}|${a.bucket}`;
    (map[key] ??= []).push(a);
  });
  return Object.values(map);
};

const getRelevantBuckets = (
  eventName: string,
  metric: string,
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
): BucketCount[] => {
  const buckets = (metric === "userSpike" && maxUserCounts)
    ? maxUserCounts[eventName]
    : counts?.[eventName];
  return buckets
    ? [...buckets].sort((a, b) => a.bucket.localeCompare(b.bucket))
    : [];
};

const extractHistorySnapshot = (
  eventName: string,
  metric: string,
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
): string => {
  const buckets = getRelevantBuckets(eventName, metric, counts, maxUserCounts);
  const recent = buckets.slice(-30);
  return JSON.stringify({
    counts: recent.map(({ count }) => count),
    buckets: recent,
  });
};

const fetchStatsSnapshot = async (
  projectId: string,
  eventName: string,
): Promise<string | null> => {
  const res = await getTurso().execute({
    sql:
      `SELECT type, mean, m2, n, last_bucket FROM stats WHERE project_id = ? AND event_name = ?;`,
    args: [projectId, eventName],
  });
  return empty(res.rows)
    ? null
    : JSON.stringify(
      res.rows.map((row) => ({
        type: String(row.type),
        mean: Number(row.mean),
        m2: Number(row.m2),
        n: Number(row.n),
        lastBucket: String(row.last_bucket),
      })),
    );
};

export const createAlertFeedbackTokens = async (
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
): Promise<Record<string, string>> => {
  if (empty(anomalies)) return {};
  const groups = groupByEventBucket(anomalies);
  const now = Date.now();
  const entries = await Promise.all(
    groups.map(async (group) => {
      const primary = group[0];
      const token = crypto.randomUUID();
      const statsJson = await fetchStatsSnapshot(
        primary.projectId,
        primary.eventName,
      );
      const historyJson = extractHistorySnapshot(
        primary.eventName,
        primary.metric,
        counts,
        maxUserCounts,
      );
      return {
        key: `${primary.eventName}|${primary.bucket}`,
        token,
        primary,
        group,
        historyJson,
        statsJson,
      };
    }),
  );

  await getTurso().batch(
    entries.map(({ token, primary, group, historyJson, statsJson }) => ({
      sql:
        `INSERT INTO alert_feedback (token, project_id, event_name, bucket, metric, user_id, expected, actual, z_score, anomalies_json, history_json, stats_json, rating, feedback_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?);`,
      args: [
        token,
        primary.projectId,
        primary.eventName,
        primary.bucket,
        group.map(({ metric }) => metric).join(","),
        primary.userId ?? "_",
        primary.expected,
        primary.actual,
        primary.zScore,
        JSON.stringify(group),
        historyJson,
        statsJson,
        now,
      ],
    })),
    "write",
  );

  return Object.fromEntries(entries.map(({ key, token }) => [key, token]));
};

export const updateAlertFeedback = async (
  token: string,
  rating: FeedbackRating,
): Promise<boolean> => {
  const res = await getTurso().execute({
    sql:
      `UPDATE alert_feedback SET rating = ?, feedback_at = ? WHERE token = ?;`,
    args: [rating, Date.now(), token],
  });
  return res.rowsAffected > 0;
};

const mapFeedbackRow = (
  row: Record<string, unknown>,
): AlertFeedbackRecord => ({
  token: String(row.token),
  projectId: String(row.project_id),
  eventName: String(row.event_name),
  bucket: String(row.bucket),
  metric: String(row.metric),
  userId: String(row.user_id),
  expected: Number(row.expected),
  actual: Number(row.actual),
  zScore: Number(row.z_score),
  anomaliesJson: String(row.anomalies_json),
  historyJson: String(row.history_json),
  statsJson: row.stats_json ? String(row.stats_json) : null,
  rating: row.rating === "good" ? "good" : row.rating === "bad" ? "bad" : null,
  feedbackAt: row.feedback_at ? Number(row.feedback_at) : null,
  createdAt: Number(row.created_at),
});

export const getAlertFeedback = async (
  token: string,
): Promise<AlertFeedbackRecord | null> => {
  const res = await getTurso().execute({
    sql:
      `SELECT token, project_id, event_name, bucket, metric, user_id, expected, actual, z_score, anomalies_json, history_json, stats_json, rating, feedback_at, created_at
       FROM alert_feedback WHERE token = ?;`,
    args: [token],
  });
  return empty(res.rows)
    ? null
    : mapFeedbackRow(res.rows[0] as Record<string, unknown>);
};

export const getBadAlertsForTesting = async (): Promise<
  AlertFeedbackRecord[]
> => {
  const res = await getTurso().execute(
    `SELECT token, project_id, event_name, bucket, metric, user_id, expected, actual, z_score, anomalies_json, history_json, stats_json, rating, feedback_at, created_at
     FROM alert_feedback WHERE rating = 'bad' ORDER BY created_at DESC;`,
  );
  return res.rows.map((row) => mapFeedbackRow(row as Record<string, unknown>));
};

const appBaseUrl = () =>
  Deno.env.get("APP_BASE_URL") ??
  Deno.env.get("BASE_URL") ??
  "https://anomalisa.uriva.deno.net";

export const feedbackUrl = (token: string, rating: FeedbackRating) =>
  `${appBaseUrl()}/feedback?token=${encodeURIComponent(token)}&vote=${rating}`;

export const renderFeedbackHtml = (
  record: AlertFeedbackRecord | null,
  currentRating: FeedbackRating | null,
): string => {
  if (!record) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback Not Found — Anomalisa</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 8px; max-width: 480px; width: 100%; padding: 2rem; text-align: center; }
    h1 { font-size: 1.25rem; color: #fff; margin-bottom: 0.5rem; }
    p { color: #888; font-size: 0.9rem; }
    a { color: #7eb8ff; text-decoration: none; }
    @media (max-width: 480px) {
      body { padding: 0.75rem; }
      .card { padding: 1.25rem 1rem; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Feedback Link Not Found</h1>
    <p>This feedback link is invalid or has expired.</p>
    <p style="margin-top: 1.5rem;"><a href="/app">Go to Anomalisa Dashboard</a></p>
  </div>
</body>
</html>`;
  }

  const isGood = currentRating === "good";
  const isBad = currentRating === "bad";
  const statusColor = isGood ? "#047857" : isBad ? "#b91c1c" : "#64748b";
  const statusBg = isGood ? "#ecfdf5" : isBad ? "#fef2f2" : "#1a1a1a";
  const statusBorder = isGood ? "#a7f3d0" : isBad ? "#fecaca" : "#333333";
  const statusText = isGood
    ? "Marked as Good alert (helpful)"
    : isBad
    ? "Marked as Bad alert (false alarm)"
    : "No feedback recorded yet";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alert Feedback — Anomalisa</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 12px; max-width: 480px; width: 100%; padding: 2rem; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    h1 { font-size: 1.2rem; color: #fff; margin-bottom: 0.25rem; word-break: break-word; }
    .subtitle { font-size: 0.85rem; color: #71717a; margin-bottom: 1.5rem; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
    .status-badge { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; font-weight: 600; font-size: 0.95rem; margin-bottom: 1.5rem; background: ${statusBg}; color: ${statusColor}; border: 1px solid ${statusBorder}; max-width: 100%; }
    .details { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 1rem; margin-bottom: 1.5rem; text-align: left; }
    .detail-row { display: flex; justify-content: space-between; font-size: 0.85rem; padding: 0.3rem 0; border-bottom: 1px solid #222; gap: 0.5rem; }
    .detail-row:last-child { border-bottom: none; }
    .label { color: #888; flex-shrink: 0; }
    .val { color: #eee; font-family: monospace; word-break: break-all; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
    .btn { flex: 1; padding: 0.6rem 1rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .btn-good { background: ${isGood ? "#047857" : "#1a2e22"}; color: ${isGood ? "#ffffff" : "#34d399"}; border: 1px solid ${isGood ? "#059669" : "#065f46"}; }
    .btn-good:hover { background: #047857; color: #fff; }
    .btn-bad { background: ${isBad ? "#b91c1c" : "#2f1b1b"}; color: ${isBad ? "#ffffff" : "#f87171"}; border: 1px solid ${isBad ? "#dc2626" : "#7f1d1d"}; }
    .btn-bad:hover { background: #b91c1c; color: #fff; }
    .note { margin-top: 1.5rem; font-size: 0.8rem; color: #71717a; text-align: center; line-height: 1.4; }
    .home-link { display: inline-block; margin-top: 1.25rem; font-size: 0.85rem; color: #7eb8ff; text-decoration: none; }
    .home-link:hover { text-decoration: underline; }
    @media (max-width: 480px) {
      body { padding: 0.75rem; }
      .card { padding: 1.25rem 1rem; border-radius: 8px; }
      .actions { gap: 0.5rem; }
      .btn { padding: 0.65rem 0.5rem; font-size: 0.8rem; }
      .status-badge { font-size: 0.85rem; padding: 0.4rem 0.75rem; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="subtitle">Anomalisa Alert Feedback</div>
    <h1>${record.eventName}</h1>
    
    <div style="margin: 1.25rem 0 0.5rem 0;">
      <div class="status-badge">${statusText}</div>
    </div>

    <div class="details">
      <div class="detail-row">
        <span class="label">Event</span>
        <span class="val">${record.eventName}</span>
      </div>
      <div class="detail-row">
        <span class="label">Bucket (UTC)</span>
        <span class="val">${record.bucket}</span>
      </div>
      <div class="detail-row">
        <span class="label">Expected</span>
        <span class="val">${record.expected}</span>
      </div>
      <div class="detail-row">
        <span class="label">Actual</span>
        <span class="val">${record.actual}</span>
      </div>
      <div class="detail-row">
        <span class="label">Score (Z)</span>
        <span class="val">${record.zScore}</span>
      </div>
      <div class="detail-row">
        <span class="label">Metric</span>
        <span class="val">${record.metric}</span>
      </div>
    </div>

    <div class="actions">
      <a class="btn btn-good" href="/feedback?token=${encodeURIComponent(record.token)}&vote=good">Good alert</a>
      <a class="btn btn-bad" href="/feedback?token=${encodeURIComponent(record.token)}&vote=bad">Bad alert</a>
    </div>

    <div class="note">
      Your rating is permanently saved and used to tune detection models and build regression test suites.
    </div>

    <div style="text-align: center;">
      <a class="home-link" href="/app">Go to Dashboard</a>
    </div>
  </div>
</body>
</html>`;
};

export const handleFeedback = async (
  url: URL,
  onFeedbackRecorded?: (
    projectId: string,
    eventName: string,
    bucket: string,
    vote: FeedbackRating,
  ) => void,
): Promise<{ html: string; status: number }> => {
  const token = url.searchParams.get("token");
  if (!token) return { html: renderFeedbackHtml(null, null), status: 404 };
  const record = await getAlertFeedback(token);
  if (!record) return { html: renderFeedbackHtml(null, null), status: 404 };
  const voteParam = url.searchParams.get("vote");
  const vote: FeedbackRating | null = voteParam === "good"
    ? "good"
    : voteParam === "bad"
    ? "bad"
    : null;
  if (vote) {
    await updateAlertFeedback(token, vote);
    onFeedbackRecorded?.(
      record.projectId,
      record.eventName,
      record.bucket,
      vote,
    );
  }
  return {
    html: renderFeedbackHtml(record, vote ?? record.rating),
    status: 200,
  };
};
