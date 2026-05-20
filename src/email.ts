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
  return `<span style="font-family:monospace;font-size:14px;">` +
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
      ? `[${sparkLevels[Math.round(((c - min) / range) * (sparkLevels.length - 1))]}]`
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
): Deno.KvKey => ["emailCount", toEmail, projectName, eventName, getDayBucket()];

const incrementEmailCounts = async (
  toEmail: string,
  projectName: string,
  eventNames: string[],
): Promise<boolean> => {
  const kv = await getKv();
  for (const eventName of eventNames) {
    const entry = await kv.get<number>(emailCountKey(toEmail, projectName, eventName));
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
  `${metricLabel(a.metric)}${a.userId ? ` (${truncate(a.userId, 20)})` : ""} (${
    a.zScore
  })`;

const labelsHtml = (a: Anomaly) =>
  `<span style="font-weight:600;">${metricLabel(a.metric)}</span>${
    a.userId ? ` (${truncate(a.userId, 20)})` : ""
  } (${a.zScore})`;

const groupByEventBucket = (anomalies: Anomaly[]) => {
  const map: Record<string, Anomaly[]> = {};
  for (const a of anomalies) {
    const key = `${a.eventName}|${a.bucket}`;
    (map[key] ??= []).push(a);
  }
  return Object.values(map);
};

const formatEventRow = (sparklines: Record<string, string>) =>
(groups: Anomaly[]) =>
  `<tr>
    <td>${groups[0].eventName}${
    sparklines[groups[0].eventName] ? ` ${sparklines[groups[0].eventName]}` : ""
  }</td>
    <td>${formatBucket(groups[0].bucket)}</td>
    <td>${groups[0].expected}</td>
    <td>${groups[0].actual}</td>
    <td>${groups.map(labelsHtml).join("<br>")}</td>
  </tr>`;

export const anomaliesHtml = (
  projectName: string,
  anomalies: Anomaly[],
  counts?: EventCounts,
) => {
  const sparklines = counts ? buildSparklines(anomalies, counts, sparkHtml) : {};
  const groups = groupByEventBucket(anomalies);
  return `<h2>${projectName}: ${
    anomalies.length === 1
      ? "Anomaly Detected"
      : `${anomalies.length} Anomalies Detected`
  }</h2>
  <table border="1" cellpadding="8" cellspacing="0">
    <tr><th>Event</th><th>Bucket</th><th>Expected</th><th>Actual</th><th>Anomalies</th></tr>
    ${groups.map(formatEventRow(sparklines)).join("\n    ")}
  </table>
  <p style="margin-top:1rem;font-size:0.85em;color:#888;">Expected = hourly average so far. Actual = this hour's count. Score = how many standard deviations from the mean.</p>`;
};

const buildSparklines = (
  anomalies: Anomaly[],
  counts: EventCounts,
  render: (counts: number[], anomalyIndex: number) => string,
): Record<string, string> => {
  const eventNames = [...new Set(anomalies.map(({ eventName }) => eventName))];
  const result: Record<string, string> = {};
  for (const eventName of eventNames) {
    const buckets = counts[eventName];
    if (!buckets || buckets.length < 2) continue;
    const anomaly = anomalies.find((a) => a.eventName === eventName);
    if (!anomaly) continue;
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
  } in ${
    formatBucket(groups[0].bucket)
  } — expected ${groups[0].expected}, got ${groups[0].actual}\n    ${
    groups.map(labels).join(", ")
  }`;

export const anomaliesText = (
  anomalies: Anomaly[],
  counts?: EventCounts,
) => {
  const sparklines = counts
    ? buildSparklines(anomalies, counts, sparkText)
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
    html: anomaliesHtml(projectName, anomalies, counts),
    text: anomaliesText(anomalies, counts),
  });
};
