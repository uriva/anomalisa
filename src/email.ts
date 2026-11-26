import { context } from "@uri/inject";
import { empty } from "gamla";
import { anomalyDirection } from "./anomaly.ts";
import type { Anomaly } from "./anomaly.ts";
import { autoCreateGithubIssues } from "./autoIssue.ts";
import {
  createAlertFeedbackRecords,
  feedbackUrl,
  groupByEventBucket,
  investigateUrl,
} from "./feedback.ts";
import { formatBucket, metricLabel } from "./format.ts";
import type { CreatedGithubIssue } from "./github.ts";
import { escapeHtml } from "./page.ts";
import { getTurso } from "./turso.ts";

export { formatBucket, metricLabel };

export const { inject: injectEmailFetch, access: emailFetch } = context(
  (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
);

type BucketCount = { bucket: string; count: number };
export type EventCounts = Record<string, BucketCount[]>;

const sparkLevels = "▁▂▃▄▅▆▇█";
const sparkWindowHours = 30;
const hourMs = 60 * 60 * 1000;

const bucketToMs = (bucket: string) => new Date(`${bucket}:00:00Z`).getTime();

const msToBucket = (ms: number) => new Date(ms).toISOString().slice(0, 13);

const sparkChars = (counts: number[]) => {
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const range = max - min || 1;
  return counts.map((c) =>
    sparkLevels[Math.round(((c - min) / range) * (sparkLevels.length - 1))]
  );
};

const sparkHtml = (counts: number[], anomalyIndex: number) => {
  const chars = sparkChars(counts);
  return `<span class="sparkline" style="font-family:monospace;font-size:11px;white-space:nowrap;display:inline-block;">` +
    `<span style="color:#cbd5e0;">${
      chars.slice(0, anomalyIndex).join("")
    }</span>` +
    `<span style="color:#e53e3e;">${chars[anomalyIndex] || ""}</span>` +
    `<span style="color:#cbd5e0;">${
      chars.slice(anomalyIndex + 1).join("")
    }</span>` +
    `</span>`;
};

const sparkText = (counts: number[], anomalyIndex: number) =>
  sparkChars(counts)
    .map((ch, i) => (i === anomalyIndex ? `[${ch}]` : ch))
    .join("");

const agentmailBaseUrl = "https://api.theagentmail.net/v1";
const getApiKey = () => Deno.env.get("AGENTMAIL_API_KEY") ?? "";
const getAccountId = () =>
  Deno.env.get("AGENTMAIL_ACCOUNT_ID") ??
    "12dece4a-771d-4bbf-b374-8bc2d8870c7b";
const maxEmailsPerDay = 5;

type Email = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
};

const getDayBucket = (): string => new Date().toISOString().slice(0, 10);

const incrementEmailCounts = async (
  toEmail: string,
  projectName: string,
  eventNames: string[],
): Promise<boolean> => {
  const dayBucket = getDayBucket();
  const now = Date.now();
  const turso = getTurso();

  for (const eventName of eventNames) {
    const res = await turso.execute({
      sql: `SELECT count, expires_at FROM email_rate_limits
            WHERE to_email = ? AND project_name = ? AND event_name = ? AND day_bucket = ?;`,
      args: [toEmail, projectName, eventName, dayBucket],
    });
    const row = res.rows[0];
    if (
      row && Number(row.expires_at) > now &&
      Number(row.count) >= maxEmailsPerDay
    ) {
      return false;
    }
  }

  await turso.batch(
    eventNames.map((eventName) => ({
      sql:
        `INSERT INTO email_rate_limits (to_email, project_name, event_name, day_bucket, count, expires_at)
            VALUES (?, ?, ?, ?, 1, ?)
            ON CONFLICT (to_email, project_name, event_name, day_bucket)
            DO UPDATE SET count = count + 1, expires_at = excluded.expires_at;`,
      args: [
        toEmail,
        projectName,
        eventName,
        dayBucket,
        now + 24 * 60 * 60 * 1000,
      ],
    })),
    "write",
  );
  return true;
};

const sendEmail = async ({ to, subject, html, text }: Email) => {
  const recipients = Array.isArray(to) ? to : [to];
  const response = await emailFetch(
    `${agentmailBaseUrl}/accounts/${getAccountId()}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        to: recipients,
        subject,
        html,
        text,
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Email send failed: ${response.status} ${response.statusText} ${body}`,
    );
  }
  return response;
};

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}...` : s;

const labels = (a: Anomaly) =>
  `${metricLabel(a.metric)}${
    a.userId ? ` (${truncate(a.userId, 20)})` : ""
  } (${a.zScore})`;

const labelsHtml = (a: Anomaly) => {
  const dir = anomalyDirection(a);
  const badge = dir === "high"
    ? `<span style="display: inline-block; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px; background-color: #ecfdf5; color: #047857; margin-right: 6px; vertical-align: middle;">▲ Uptick</span>`
    : `<span style="display: inline-block; padding: 2px 6px; font-size: 11px; font-weight: 600; border-radius: 4px; background-color: #fef2f2; color: #b91c1c; margin-right: 6px; vertical-align: middle;">▼ Drop</span>`;
  const trendMarkup = a.trend
    ? `<div style="margin-top: 4px; font-size: 11px; color: #475569; font-style: italic;">${a.trend}</div>`
    : "";
  return `
    <div style="margin-bottom: 8px; line-height: 1.5;">
      ${badge}
      <span style="font-weight:600; vertical-align: middle; color: #0f172a;">${
    metricLabel(a.metric)
  }</span>${
    a.userId
      ? `<span style="color: #64748b; vertical-align: middle;"> (${
        truncate(a.userId, 20)
      })</span>`
      : ""
  }<span style="color: #64748b; vertical-align: middle;"> (${a.zScore})</span>
      ${trendMarkup}
    </div>`;
};

const feedbackBtnStyle =
  "display: inline-block; padding: 5px 12px; font-size: 12px; font-weight: 600; line-height: 1.4; border-radius: 6px; text-decoration: none; white-space: nowrap; vertical-align: middle; box-sizing: border-box;";

const feedbackActionButton = (
  token: string,
  rating: "good" | "bad",
  label: string,
) =>
  `<a class="feedback-btn feedback-btn-${rating}" href="${
    feedbackUrl(token, rating)
  }" style="${feedbackBtnStyle} ${
    rating === "good"
      ? "color: #047857; background-color: #ecfdf5; border: 1px solid #a7f3d0; margin-right: 6px;"
      : "color: #b91c1c; background-color: #fef2f2; border: 1px solid #fecaca;"
  }">${label}</a>`;

export const createGithubIssueLabel = "Create GitHub issue";
export const autoOpenedGithubIssueLabel = "GitHub issue opened automatically";
export const viewGithubIssueLabel = (issueNumber: number) =>
  `View issue #${issueNumber}`;

const githubIssueActionButton = (token: string) =>
  `<a class="feedback-btn feedback-btn-agent" href="${
    investigateUrl(token)
  }" style="${feedbackBtnStyle} color: #1d4ed8; background-color: #eff6ff; border: 1px solid #bfdbfe;">${createGithubIssueLabel}</a>`;

const openedGithubIssueButton = ({
  issueUrl,
  issueNumber,
}: CreatedGithubIssue) =>
  `<a class="feedback-btn feedback-btn-agent" href="${
    escapeHtml(issueUrl)
  }" style="${feedbackBtnStyle} color: #047857; background-color: #ecfdf5; border: 1px solid #a7f3d0;">${
    viewGithubIssueLabel(issueNumber)
  }</a>`;

const formatActionBar = (label: string, actions: string) => `
      <div style="margin-top: 14px; padding-top: 12px; border-top: 1px solid #f1f5f9;">
        <table class="feedback-table" style="width: 100%; border-collapse: collapse;">
          <tr class="feedback-row">
            <td class="feedback-label" style="padding: 0; vertical-align: middle; font-size: 12px; color: #64748b; font-weight: 500;">${label}</td>
            <td class="feedback-actions" style="padding: 0; vertical-align: middle; text-align: right; white-space: nowrap;">${actions}</td>
          </tr>
        </table>
      </div>`;

const formatFeedbackBar = (token?: string) =>
  token
    ? formatActionBar(
      "Was this alert helpful?",
      feedbackActionButton(token, "good", "Good alert") +
        feedbackActionButton(token, "bad", "Bad alert"),
    )
    : "";

const formatGithubIssueBar = (
  token?: string,
  createdIssue?: CreatedGithubIssue,
) =>
  createdIssue
    ? formatActionBar(
      autoOpenedGithubIssueLabel,
      openedGithubIssueButton(createdIssue),
    )
    : token
    ? formatActionBar(
      "Track on GitHub",
      githubIssueActionButton(token),
    )
    : "";

const formatEventCard = (
  sparklines: Record<string, string>,
  feedbackTokens?: Record<string, string>,
  createdIssues?: Record<string, CreatedGithubIssue>,
) =>
(groups: Anomaly[]) => {
  const a = groups[0];
  const groupKey = `${a.eventName}|${a.bucket}`;
  const token = feedbackTokens?.[groupKey];
  const createdIssue = createdIssues?.[groupKey];
  const sparklineMarkup = sparklines[a.eventName]
    ? `
    <div style="margin-top: 6px; word-break: break-all; overflow-wrap: break-word;">
      <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 4px;">History (30h)</div>
      ${sparklines[a.eventName]}
    </div>`
    : "";
  return `
    <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; background-color: #ffffff; text-align: left;">
      <div style="margin-bottom: 12px;">
        <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 2px;">Event</div>
        <div style="font-size: 16px; font-weight: 600; color: #0f172a; word-break: break-all; overflow-wrap: break-word;">${a.eventName}</div>
        ${sparklineMarkup}
      </div>

      <div style="background-color: #f8fafc; border-radius: 6px; padding: 12px; margin-bottom: 12px;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 0; vertical-align: top;">
              <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 2px;">Bucket (UTC)</div>
              <div style="font-size: 13px; color: #334155; word-break: break-all; overflow-wrap: break-word;">${
    formatBucket(a.bucket)
  }</div>
            </td>
            <td style="padding: 0 8px; vertical-align: top; text-align: right; width: 70px;">
              <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 2px;">Expected</div>
              <div style="font-size: 13px; font-family: monospace; color: #475569;">${a.expected}</div>
            </td>
            <td style="padding: 0; vertical-align: top; text-align: right; width: 70px;">
              <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 2px;">Actual</div>
              <div style="font-size: 13px; font-family: monospace; font-weight: 600; color: #0f172a;">${a.actual}</div>
            </td>
          </tr>
        </table>
      </div>

      <div>
        <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #64748b; margin-bottom: 4px;">Alerts / Metrics</div>
        <div style="font-size: 13px; color: #334155; line-height: 1.4; word-break: break-all; overflow-wrap: break-word;">
          ${groups.map(labelsHtml).join("")}
        </div>
      </div>
      ${formatFeedbackBar(token)}
      ${formatGithubIssueBar(token, createdIssue)}
    </div>`;
};

export const anomaliesHtml = (
  projectName: string,
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
  feedbackTokens?: Record<string, string>,
  createdIssues?: Record<string, CreatedGithubIssue>,
) => {
  const sparklines = counts
    ? buildSparklines(anomalies, counts, maxUserCounts, sparkHtml)
    : {};
  const groups = groupByEventBucket(anomalies);
  return `
    <style>
      @media only screen and (max-width: 600px) {
        .email-container {
          padding: 12px !important;
        }
        .email-card {
          border-radius: 8px !important;
        }
        .email-header {
          padding: 16px !important;
        }
        .email-body {
          padding: 16px !important;
        }
        .sparkline {
          font-size: 11px !important;
        }
        .feedback-row {
          display: block !important;
        }
        .feedback-label {
          display: block !important;
          width: 100% !important;
          padding-bottom: 8px !important;
          text-align: left !important;
        }
        .feedback-actions {
          display: block !important;
          width: 100% !important;
          text-align: left !important;
          white-space: nowrap !important;
        }
        .feedback-btn {
          display: inline-block !important;
          text-align: center !important;
          vertical-align: middle !important;
        }
      }
    </style>
    <div class="email-container" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; padding: 24px; min-height: 100%;">
      <div class="email-card" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05);">
        <!-- Header -->
        <div class="email-header" style="background-color: #0f172a; padding: 24px; color: #ffffff; text-align: left;">
          <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: #94a3b8; margin-bottom: 4px;">anomalisa alert</div>
          <h1 style="margin: 0; font-size: 20px; font-weight: 700; color: #ffffff; line-height: 1.2;">
            ${projectName}: ${
    anomalies.length === 1
      ? "Anomaly Detected"
      : `${anomalies.length} Anomalies Detected`
  }
          </h1>
        </div>
        
        <!-- Body -->
        <div class="email-body" style="padding: 24px; background-color: #ffffff;">
          ${
    groups.map(formatEventCard(sparklines, feedbackTokens, createdIssues)).join(
      "",
    )
  }
          
          <!-- Footer info -->
          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #f1f5f9; font-size: 12px; color: #64748b; line-height: 1.5; text-align: left;">
            <p style="margin: 0 0 6px 0;"><strong>Expected</strong> is the hourly baseline calculated using running historical data.</p>
            <p style="margin: 0 0 6px 0;"><strong>Actual</strong> is the recorded count during this hour.</p>
            <p style="margin: 0;"><strong>Score (Z)</strong> indicates how many standard deviations the count is from the mean baseline.</p>
          </div>
        </div>
      </div>
    </div>`;
};

const sparkEndMs = (anomalyMs: number, buckets: BucketCount[]) => {
  const latestMs = Math.max(...buckets.map(({ bucket }) => bucketToMs(bucket)));
  return latestMs > anomalyMs &&
      latestMs - anomalyMs < sparkWindowHours * hourMs
    ? latestMs
    : anomalyMs;
};

const hourlySparkWindow = (anomalyBucket: string, buckets: BucketCount[]) => {
  const countByBucket = new Map(
    buckets.map(({ bucket, count }) => [bucket, count]),
  );
  const endMs = sparkEndMs(bucketToMs(anomalyBucket), buckets);
  const startMs = endMs - (sparkWindowHours - 1) * hourMs;
  const windowBuckets = Array.from(
    { length: sparkWindowHours },
    (_, i) => msToBucket(startMs + i * hourMs),
  );
  return {
    counts: windowBuckets.map((b) => countByBucket.get(b) ?? 0),
    anomalyIndex: windowBuckets.indexOf(anomalyBucket),
  };
};

const sparklineEntry = (
  anomalies: Anomaly[],
  counts: EventCounts,
  maxUserCounts: EventCounts | undefined,
  render: (counts: number[], anomalyIndex: number) => string,
) =>
(eventName: string): [string, string][] => {
  const anomaly = anomalies.find((a) => a.eventName === eventName);
  const buckets = anomaly
    ? (anomaly.metric === "userSpike" && maxUserCounts
      ? maxUserCounts[eventName]
      : counts[eventName])
    : undefined;
  if (!anomaly || !buckets || empty(buckets)) return [];
  const { counts: windowCounts, anomalyIndex } = hourlySparkWindow(
    anomaly.bucket,
    buckets,
  );
  return anomalyIndex < 0
    ? []
    : [[eventName, render(windowCounts, anomalyIndex)]];
};

const buildSparklines = (
  anomalies: Anomaly[],
  counts: EventCounts,
  maxUserCounts: EventCounts | undefined,
  render: (counts: number[], anomalyIndex: number) => string,
): Record<string, string> =>
  Object.fromEntries(
    [...new Set(anomalies.map(({ eventName }) => eventName))].flatMap(
      sparklineEntry(anomalies, counts, maxUserCounts, render),
    ),
  );

const eventText = (
  sparklines: Record<string, string>,
  feedbackTokens?: Record<string, string>,
  createdIssues?: Record<string, CreatedGithubIssue>,
) =>
(groups: Anomaly[]) => {
  const primary = groups[0];
  const groupKey = `${primary.eventName}|${primary.bucket}`;
  const token = feedbackTokens?.[groupKey];
  const createdIssue = createdIssues?.[groupKey];
  const feedbackLine = token
    ? `\n    Helpful? Good: ${feedbackUrl(token, "good")} | Bad: ${
      feedbackUrl(token, "bad")
    }`
    : "";
  const githubIssueLine = createdIssue
    ? `\n    ${autoOpenedGithubIssueLabel} (#${createdIssue.issueNumber}): ${createdIssue.issueUrl}`
    : token
    ? `\n    ${createGithubIssueLabel}: ${investigateUrl(token)}`
    : "";
  return `  ${primary.eventName}${
    sparklines[primary.eventName] ? ` ${sparklines[primary.eventName]}` : ""
  } in ${
    formatBucket(primary.bucket)
  } — expected ${primary.expected}, got ${primary.actual}\n    ${
    groups.map(labels).join(", ")
  }${feedbackLine}${githubIssueLine}`;
};

export const anomaliesText = (
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
  feedbackTokens?: Record<string, string>,
  createdIssues?: Record<string, CreatedGithubIssue>,
) => {
  const sparklines = counts
    ? buildSparklines(anomalies, counts, maxUserCounts, sparkText)
    : {};
  const groups = groupByEventBucket(anomalies);
  return `Anomalies:\n\n${
    groups.map(eventText(sparklines, feedbackTokens, createdIssues)).join(
      "\n\n",
    )
  }`;
};

const subjectLine = (
  projectName: string,
  { metric, eventName, userId }: Anomaly,
) =>
  `[${projectName}] ${metricLabel(metric)}: ${eventName}${
    userId ? ` (${truncate(userId, 20)})` : ""
  }`;

export const subjectGithubIssueOpenedSuffix = (issueNumber: number) =>
  ` (GitHub issue #${issueNumber} opened)`;

const subjectIssuesSuffix = (
  createdIssues?: Record<string, CreatedGithubIssue>,
) => {
  const issues = Object.values(createdIssues ?? {});
  return empty(issues)
    ? ""
    : issues.length === 1
    ? subjectGithubIssueOpenedSuffix(issues[0].issueNumber)
    : ` (${issues.length} GitHub issues opened)`;
};

export const batchSubject = (
  projectName: string,
  anomalies: Anomaly[],
  createdIssues?: Record<string, CreatedGithubIssue>,
) =>
  `${
    anomalies.length === 1
      ? subjectLine(projectName, anomalies[0])
      : `[${projectName}] ${anomalies.length} anomalies detected`
  }${subjectIssuesSuffix(createdIssues)}`;

export type SendAnomalyAlertOptions = {
  extraEmails?: string[];
  enableAutoGithubIssues?: boolean;
};

const uniqueRecipients = (primary: string, extra?: string[]): string[] => [
  ...new Set(
    [primary, ...(extra ?? [])].map((e) => e.trim()).filter(Boolean),
  ),
];

export const sendAnomalyAlerts = async (
  toEmail: string,
  projectName: string,
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
  options?: SendAnomalyAlertOptions,
) => {
  const eventNames = [...new Set(anomalies.map(({ eventName }) => eventName))];
  const canSend = await incrementEmailCounts(toEmail, projectName, eventNames);
  if (!canSend) {
    console.log(
      `Email limit reached for ${toEmail} / ${projectName}`,
    );
    return;
  }
  const records = await createAlertFeedbackRecords(
    anomalies,
    counts,
    maxUserCounts,
  ).catch(() => []);
  const feedbackTokens = Object.fromEntries(
    records.map(({ eventName, bucket, token }) => [
      `${eventName}|${bucket}`,
      token,
    ]),
  );
  const createdIssues = options?.enableAutoGithubIssues === false
    ? {}
    : await autoCreateGithubIssues({
      projectName,
      records,
    }).catch(() => ({}));
  return sendEmail({
    to: uniqueRecipients(toEmail, options?.extraEmails),
    subject: batchSubject(projectName, anomalies, createdIssues),
    html: anomaliesHtml(
      projectName,
      anomalies,
      counts,
      maxUserCounts,
      feedbackTokens,
      createdIssues,
    ),
    text: anomaliesText(
      anomalies,
      counts,
      maxUserCounts,
      feedbackTokens,
      createdIssues,
    ),
  });
};

export const sendQuotaNotification = ({
  to,
  plan,
  limit,
  reached,
}: {
  to: string;
  plan: string;
  limit: number;
  reached: boolean;
}) => {
  const key = getApiKey();
  if (!key) return Promise.resolve();
  const formattedLimit = limit.toLocaleString("en-US");
  const subject = reached
    ? `[Anomalisa] Monthly event limit reached (${formattedLimit} events)`
    : `[Anomalisa] You've used 80% of your monthly event limit (${formattedLimit} events)`;
  const upgradeLine = plan === "free"
    ? "Upgrade to Pro ($15/mo) for 1,000,000 events/month, team multi-email alerts, signed webhooks, and automated AI GitHub issue investigation: https://anomalisa.uriv.me/app?upgrade=pro"
    : "Manage your plan in the Anomalisa dashboard: https://anomalisa.uriv.me/app";
  const text = reached
    ? `Your Anomalisa ${plan} plan reached its monthly limit of ${formattedLimit} events. New events will be rejected with HTTP 429 until the next UTC month or until you upgrade.\n\n${upgradeLine}`
    : `Your Anomalisa ${plan} plan has used 80% of its ${formattedLimit} monthly events.\n\n${upgradeLine}`;
  const html = reached
    ? `<p>Your Anomalisa <strong>${
      escapeHtml(plan)
    }</strong> plan reached its monthly limit of <strong>${formattedLimit}</strong> events. New events will return HTTP 429 until next month or until you upgrade.</p><p><a href="https://anomalisa.uriv.me/app?upgrade=pro">Upgrade to Pro ($15/mo)</a> for 1,000,000 events/month, team multi-email alerts, signed webhooks, and automated AI GitHub issue investigation.</p>`
    : `<p>Your Anomalisa <strong>${
      escapeHtml(plan)
    }</strong> plan has used 80% of its <strong>${formattedLimit}</strong> monthly events.</p><p><a href="https://anomalisa.uriv.me/app?upgrade=pro">Upgrade to Pro ($15/mo)</a> anytime for 1,000,000 events/month.</p>`;
  return sendEmail({ to, subject, html, text });
};

export const sendAdminNotification = ({
  subject,
  html,
  text,
}: {
  subject: string;
  html: string;
  text: string;
}) => {
  const key = getApiKey();
  if (!key) {
    console.warn("AgentMail not configured, skipping admin notification");
    return Promise.resolve();
  }
  return sendEmail({
    to: "uri.valevski@gmail.com",
    subject,
    html,
    text,
  });
};

const sampleTestAnomaly = (
  projectId: string,
  bucket: string,
): Anomaly => ({
  projectId,
  eventName: "checkout_error",
  bucket,
  expected: 12,
  actual: 48,
  zScore: 4.5,
  detectedAt: new Date().toISOString(),
  metric: "totalCount",
});

const sampleTestCounts = (bucket: string): EventCounts => {
  const endMs = bucketToMs(bucket);
  const startMs = endMs - (sparkWindowHours - 1) * hourMs;
  return {
    checkout_error: Array.from({ length: sparkWindowHours }, (_, i) => ({
      bucket: msToBucket(startMs + i * hourMs),
      count: i === sparkWindowHours - 1 ? 48 : 10 + (i % 5),
    })),
  };
};

export const sendTestAnomalyAlert = (
  toEmail: string,
  projectName: string,
  projectId: string,
) => {
  const bucket = msToBucket(Date.now());
  const anomalies = [sampleTestAnomaly(projectId, bucket)];
  const counts = sampleTestCounts(bucket);
  const notice = "Sample test alert (no real anomaly occurred).";
  return sendEmail({
    to: toEmail,
    subject: `[Test] ${batchSubject(projectName, anomalies)}`,
    html:
      `<p style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; color: #475569; margin: 0 0 12px 0; text-align: center;">${notice}</p>${
        anomaliesHtml(projectName, anomalies, counts)
      }`,
    text: `${notice}\n\n${anomaliesText(anomalies, counts)}`,
  });
};
