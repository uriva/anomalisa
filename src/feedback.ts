import { empty } from "gamla";
import type { Anomaly } from "./anomaly.ts";
import { centerPageStyles, escapeHtml, renderPage } from "./page.ts";
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

export const investigateUrl = (token: string) =>
  `${appBaseUrl()}/investigate?token=${encodeURIComponent(token)}`;

const feedbackHeaderContent = (
  rating: FeedbackRating | null,
  eventName: string,
) =>
  rating === "good"
    ? {
      icon: "✓",
      iconClass: "icon-good",
      title: "Marked as Good alert",
      desc: `Recorded as a helpful alert for <code>${eventName}</code>.`,
    }
    : rating === "bad"
    ? {
      icon: "✕",
      iconClass: "icon-bad",
      title: "Marked as Bad alert",
      desc: `Recorded as a false alarm for <code>${eventName}</code>.`,
    }
    : {
      icon: "⚡",
      iconClass: "icon-neutral",
      title: `Rate alert: ${eventName}`,
      desc: "Was this anomaly alert helpful or a false alarm?",
    };

const renderFeedbackHeader = (
  rating: FeedbackRating | null,
  eventName: string,
) => {
  const { icon, iconClass, title, desc } = feedbackHeaderContent(
    rating,
    eventName,
  );
  return `
    <div class="status-hero">
      <div class="status-icon ${iconClass}">${icon}</div>
      <h1>${title}</h1>
      <p class="status-desc">${desc}</p>
    </div>`;
};

const renderFeedbackActions = (
  token: string,
  rating: FeedbackRating | null,
) =>
  rating === "good"
    ? `
    <div class="confirmed-actions">
      <a class="btn-primary" href="/app">Go to Dashboard</a>
      <p class="switch-hint">Marked by mistake? <a class="switch-link" href="/feedback?token=${encodeURIComponent(token)}&vote=bad">Switch to Bad alert</a></p>
    </div>`
    : rating === "bad"
    ? `
    <div class="confirmed-actions">
      <a class="btn-primary" href="/app">Go to Dashboard</a>
      <p class="switch-hint">Marked by mistake? <a class="switch-link" href="/feedback?token=${encodeURIComponent(token)}&vote=good">Switch to Good alert</a></p>
    </div>`
    : `
    <div class="actions">
      <a class="btn btn-good" href="/feedback?token=${encodeURIComponent(token)}&vote=good">Good alert</a>
      <a class="btn btn-bad" href="/feedback?token=${encodeURIComponent(token)}&vote=bad">Bad alert</a>
    </div>
    <div style="text-align: center; margin-top: 1rem;">
      <a class="home-link" href="/app">Go to Dashboard</a>
    </div>`;

export const renderDetailRow = (label: string, val: string | number) => `
      <div class="detail-row">
        <span class="label">${label}</span>
        <span class="val">${escapeHtml(val)}</span>
      </div>`;

export const renderDetails = ({
  eventName,
  bucket,
  expected,
  actual,
  zScore,
  metric,
}: AlertFeedbackRecord) => `
    <div class="details">
      ${renderDetailRow("Event", eventName)}
      ${renderDetailRow("Bucket (UTC)", bucket)}
      ${renderDetailRow("Expected", expected)}
      ${renderDetailRow("Actual", actual)}
      ${renderDetailRow("Score (Z)", zScore)}
      ${renderDetailRow("Metric", metric)}
    </div>`;

const feedbackPageTitle = (rating: FeedbackRating | null) =>
  rating === "good"
    ? "Marked as Good alert — Anomalisa"
    : rating === "bad"
    ? "Marked as Bad alert — Anomalisa"
    : "Alert Feedback — Anomalisa";

const feedbackStyles = `
    ${centerPageStyles}
    .status-hero { display: flex; flex-direction: column; align-items: center; margin-bottom: 1.5rem; }
    .status-icon { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.35rem; margin-bottom: 0.75rem; }
    .icon-good { background: rgba(16, 185, 129, 0.12); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.35); }
    .icon-bad { background: rgba(239, 68, 68, 0.12); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.35); }
    .icon-neutral { background: rgba(113, 113, 122, 0.15); color: #a1a1aa; border: 1px solid rgba(113, 113, 122, 0.35); }
    .status-desc { font-size: 0.88rem; color: #a1a1aa; margin: 0; line-height: 1.4; }
    .confirmed-actions { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.5rem; }
    .switch-hint { margin: 0; font-size: 0.82rem; color: #71717a; }
    .switch-link { color: #7eb8ff; text-decoration: none; font-weight: 500; }
    .switch-link:hover { text-decoration: underline; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
    .btn { flex: 1; padding: 0.65rem 1rem; border-radius: 6px; font-size: 0.85rem; font-weight: 600; text-align: center; text-decoration: none; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .btn-good { background: #047857; color: #ffffff; border: 1px solid #059669; }
    .btn-good:hover { background: #059669; }
    .btn-bad { background: #b91c1c; color: #ffffff; border: 1px solid #dc2626; }
    .btn-bad:hover { background: #dc2626; }
    .note { margin-top: 1.5rem; font-size: 0.8rem; color: #71717a; text-align: center; line-height: 1.4; }
    @media (max-width: 480px) {
      .actions { gap: 0.5rem; }
      .btn { padding: 0.65rem 0.5rem; font-size: 0.8rem; }
    }
`;

export const renderFeedbackHtml = (
  record: AlertFeedbackRecord | null,
  currentRating: FeedbackRating | null,
): string =>
  !record
    ? renderPage({
      title: "Feedback Not Found — Anomalisa",
      styles: centerPageStyles,
      body: `<div class="card">
    <h1>Feedback Link Not Found</h1>
    <p>This feedback link is invalid or has expired.</p>
    <p style="margin-top: 1.5rem;"><a href="/app">Go to Anomalisa Dashboard</a></p>
  </div>`,
    })
    : renderPage({
      title: feedbackPageTitle(currentRating),
      styles: feedbackStyles,
      body: `<div class="card">
    <div class="brand">Anomalisa Alert Feedback</div>
    ${renderFeedbackHeader(currentRating, record.eventName)}
    ${renderDetails(record)}
    ${renderFeedbackActions(record.token, currentRating)}
    <div class="note">
      Your rating is permanently saved and used to tune detection models and build regression test suites.
    </div>
  </div>`,
    });

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
