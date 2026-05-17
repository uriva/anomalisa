import type { Anomaly } from "./anomaly.ts";

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

const metricExplanation = (metric: Anomaly["metric"]) =>
  metric === "userSpike"
    ? "A single user sent way more events than usual for this hour."
    : metric === "percentageSpike"
    ? "Event count jumped by an unusually large percentage compared to the hourly average."
    : metric === "percentageDrop"
    ? "Event count dropped by an unusually large percentage compared to the hourly average."
    : "The total event count for this hour is statistically unusual (z-score > 2).";

const uniqueMetrics = (
  anomalies: Anomaly[],
) => [...new Set(anomalies.map(({ metric }) => metric))];

const hasUserId = (anomalies: Anomaly[]) =>
  anomalies.some(({ userId }) => userId);

const truncate = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, max)}...` : s;

const formatAnomaly = (showUser: boolean) =>
(
  { eventName, bucket, expected, actual, zScore, userId }: Anomaly,
) =>
  `<tr>
    <td>${eventName}</td>
    ${showUser ? `<td>${userId ? truncate(userId, 20) : "-"}</td>` : ""}
    <td>${formatBucket(bucket)}</td>
    <td>${expected}</td>
    <td>${actual}</td>
    <td>${zScore}</td>
  </tr>`;

const sectionHtml = (metric: Anomaly["metric"], anomalies: Anomaly[]) => {
  const showUser = hasUserId(anomalies);
  return `<h3 style="margin-top:1.5rem;">${metricLabel(metric)}</h3>
  <p style="margin:0.25rem 0 0.5rem;font-size:0.9em;color:#666;">${
    metricExplanation(metric)
  }</p>
  <table border="1" cellpadding="8" cellspacing="0">
    <tr><th>Event</th>${
    showUser ? "<th>User</th>" : ""
  }<th>Bucket</th><th>Expected</th><th>Actual</th><th>Score</th></tr>
    ${anomalies.map(formatAnomaly(showUser)).join("\n    ")}
  </table>`;
};

const groupByMetric = (anomalies: Anomaly[]) =>
  uniqueMetrics(anomalies).map((metric) =>
    [
      metric,
      anomalies.filter((a) => a.metric === metric),
    ] as const
  );

export const anomaliesHtml = (projectName: string, anomalies: Anomaly[]) =>
  `<h2>${projectName}: ${
    anomalies.length === 1
      ? "Anomaly Detected"
      : `${anomalies.length} Anomalies Detected`
  }</h2>
  ${
    groupByMetric(anomalies).map(([metric, group]) =>
      sectionHtml(metric, group)
    ).join("\n  ")
  }
  <p style="margin-top:1rem;font-size:0.85em;color:#888;">Expected = hourly average so far. Actual = this hour's count. Score = how many standard deviations from the mean.</p>`;

const anomalyText = (
  { eventName, bucket, expected, actual, zScore, userId }: Anomaly,
) =>
  `  ${eventName}${userId ? ` (user: ${truncate(userId, 20)})` : ""} in ${
    formatBucket(bucket)
  } — expected ${expected}, got ${actual} (score=${zScore})`;

export const anomaliesText = (anomalies: Anomaly[]) =>
  groupByMetric(anomalies).map(([metric, group]) =>
    `${metricLabel(metric)}:\n${group.map(anomalyText).join("\n")}`
  ).join("\n\n");

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
    html: anomaliesHtml(projectName, anomalies),
    text: anomaliesText(anomalies),
  });
};
