import { anomalyDirection } from "./anomaly.ts";
import type { Anomaly } from "./anomaly.ts";

type BucketCount = { bucket: string; count: number };
export type EventCounts = Record<string, BucketCount[]>;

const sparkLevels = "▁▂▃▄▅▆▇█";

const sparkHtml = (counts: number[], anomalyIndex: number) => {
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const range = max - min || 1;
  const chars = counts.map((c) =>
    sparkLevels[Math.round(((c - min) / range) * (sparkLevels.length - 1))]
  );
  const before = chars.slice(0, anomalyIndex).join("");
  const at = chars[anomalyIndex] || "";
  const after = chars.slice(anomalyIndex + 1).join("");
  return `<span class="sparkline" style="font-family:monospace;font-size:14px;white-space:nowrap;display:inline-block;">` +
    `<span style="color:#cbd5e0;">${before}</span>` +
    `<span style="color:#e53e3e;">${at}</span>` +
    `<span style="color:#cbd5e0;">${after}</span>` +
    `</span>`;
};

const sparkText = (counts: number[], anomalyIndex: number) => {
  const max = Math.max(...counts);
  const min = Math.min(...counts);
  const range = max - min || 1;
  return counts.map((c, i) =>
    i === anomalyIndex
      ? `[${
        sparkLevels[Math.round(((c - min) / range) * (sparkLevels.length - 1))]
      }]`
      : sparkLevels[Math.round(((c - min) / range) * (sparkLevels.length - 1))]
  ).join("");
};

const apiKey = Deno.env.get("FORWARD_EMAIL_API_KEY") ?? "";
const emailDomain = Deno.env.get("EMAIL_DOMAIN") ?? "";
const authHeader = `Basic ${btoa(apiKey + ":")}`;
let _kv: Deno.Kv | null = null;
const getKv = async () => _kv ??= await Deno.openKv();
const maxEmailsPerDay = 5;

type Email = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

const getDayBucket = (): string => new Date().toISOString().slice(0, 10);

const emailCountKey = (
  toEmail: string,
  projectName: string,
  eventName: string,
): Deno.KvKey => [
  "emailCount",
  toEmail,
  projectName,
  eventName,
  getDayBucket(),
];

const incrementEmailCounts = async (
  toEmail: string,
  projectName: string,
  eventNames: string[],
): Promise<boolean> => {
  const kv = await getKv();
  for (const eventName of eventNames) {
    const entry = await kv.get<number>(
      emailCountKey(toEmail, projectName, eventName),
    );
    if ((entry.value ?? 0) >= maxEmailsPerDay) return false;
  }
  for (const eventName of eventNames) {
    const key = emailCountKey(toEmail, projectName, eventName);
    const entry = await kv.get<number>(key);
    await kv.set(key, (entry.value ?? 0) + 1, {
      expireIn: 24 * 60 * 60 * 1000,
    });
  }
  return true;
};

const sendEmail = async (email: Email) => {
  const response = await fetch("https://api.forwardemail.net/v1/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ ...email, encoding: "utf-8" }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Email send failed: ${response.status} ${response.statusText} ${body}`,
    );
  }
  return response;
};

const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const months = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const hourLabel = (h: number) =>
  h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

export const formatBucket = (bucket: string) => {
  const d = new Date(`${bucket}:00:00Z`);
  const h = d.getUTCHours();
  return `${days[d.getUTCDay()]} ${
    months[d.getUTCMonth()]
  } ${d.getUTCDate()}, ${hourLabel(h)}–${hourLabel((h + 1) % 24)} UTC`;
};

const metricLabel = (metric: Anomaly["metric"]) =>
  metric === "userSpike"
    ? "User Spike"
    : metric === "percentageSpike"
    ? "Percentage Spike"
    : metric === "percentageDrop"
    ? "Percentage Drop"
    : "Total Count";

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

const groupByEventBucket = (anomalies: Anomaly[]) => {
  const map: Record<string, Anomaly[]> = {};
  for (const a of anomalies) {
    const key = `${a.eventName}|${a.bucket}`;
    (map[key] ??= []).push(a);
  }
  return Object.values(map);
};

const formatEventCard =
  (sparklines: Record<string, string>) => (groups: Anomaly[]) => {
    const a = groups[0];
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
    </div>`;
  };

export const anomaliesHtml = (
  projectName: string,
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
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
          ${groups.map(formatEventCard(sparklines)).join("")}
          
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

const buildSparklines = (
  anomalies: Anomaly[],
  counts: EventCounts,
  maxUserCounts: EventCounts | undefined,
  render: (counts: number[], anomalyIndex: number) => string,
): Record<string, string> => {
  const eventNames = [...new Set(anomalies.map(({ eventName }) => eventName))];
  const result: Record<string, string> = {};
  for (const eventName of eventNames) {
    const anomaly = anomalies.find((a) => a.eventName === eventName);
    if (!anomaly) continue;
    const isUserSpike = anomaly.metric === "userSpike";
    const buckets = (isUserSpike && maxUserCounts)
      ? maxUserCounts[eventName]
      : counts[eventName];
    if (!buckets || buckets.length < 2) continue;
    const sorted = [...buckets].sort((a, b) =>
      a.bucket.localeCompare(b.bucket)
    );
    const recent = sorted.slice(-30);
    const anomalyIndex = recent.findIndex(({ bucket }) =>
      bucket === anomaly.bucket
    );
    if (anomalyIndex < 0) continue;
    result[eventName] = render(
      recent.map(({ count }) => count),
      anomalyIndex,
    );
  }
  return result;
};

const eventText = (
  sparklines: Record<string, string>,
) =>
(groups: Anomaly[]) =>
  `  ${groups[0].eventName}${
    sparklines[groups[0].eventName] ? ` ${sparklines[groups[0].eventName]}` : ""
  } in ${formatBucket(groups[0].bucket)} — expected ${
    groups[0].expected
  }, got ${groups[0].actual}\n    ${groups.map(labels).join(", ")}`;

export const anomaliesText = (
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
) => {
  const sparklines = counts
    ? buildSparklines(anomalies, counts, maxUserCounts, sparkText)
    : {};
  const groups = groupByEventBucket(anomalies);
  return `Anomalies:\n\n${groups.map(eventText(sparklines)).join("\n\n")}`;
};

const subjectLine = (
  projectName: string,
  { metric, eventName, userId }: Anomaly,
) =>
  `[${projectName}] ${metricLabel(metric)}: ${eventName}${
    userId ? ` (${truncate(userId, 20)})` : ""
  }`;

export const batchSubject = (projectName: string, anomalies: Anomaly[]) =>
  anomalies.length === 1
    ? subjectLine(projectName, anomalies[0])
    : `[${projectName}] ${anomalies.length} anomalies detected`;

export const sendAnomalyAlerts = async (
  toEmail: string,
  projectName: string,
  anomalies: Anomaly[],
  counts?: EventCounts,
  maxUserCounts?: EventCounts,
) => {
  const eventNames = [...new Set(anomalies.map(({ eventName }) => eventName))];
  const canSend = await incrementEmailCounts(toEmail, projectName, eventNames);
  if (!canSend) {
    console.log(
      `Email limit reached for ${toEmail} / ${projectName}`,
    );
    return;
  }
  return sendEmail({
    from: `alerts@${emailDomain}`,
    to: toEmail,
    subject: batchSubject(projectName, anomalies),
    html: anomaliesHtml(projectName, anomalies, counts, maxUserCounts),
    text: anomaliesText(anomalies, counts, maxUserCounts),
  });
};
