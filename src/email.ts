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

const incrementEmailCount = async (to: string): Promise<number> => {
  const key = ["emailCount", to, getDayBucket()];
  const entry = await (await getKv()).get<number>(key);
  const count = (entry.value ?? 0) + 1;
  await (await getKv()).atomic().check(entry).set(key, count, {
    expireIn: 24 * 60 * 60 * 1000,
  }).commit();
  return count;
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

const metricLabel = (metric: Anomaly["metric"]) =>
  metric === "userSpike"
    ? "User Spike"
    : metric === "percentageSpike"
    ? "Percentage Spike"
    : "Total Count";

const metricExplanation = (metric: Anomaly["metric"]) =>
  metric === "userSpike"
    ? "A single user sent way more events than usual for this hour."
    : metric === "percentageSpike"
    ? "Event count jumped by an unusually large percentage compared to the hourly average."
    : "The total event count for this hour is statistically unusual (z-score > 2).";

const uniqueMetrics = (
  anomalies: Anomaly[],
) => [...new Set(anomalies.map(({ metric }) => metric))];

const legendHtml = (metrics: Anomaly["metric"][]) =>
  `<div style="margin-top:1rem;padding:0.75rem 1rem;background:#f8f8f8;border-radius:6px;font-size:0.9em;color:#444;">
    <strong>What do these mean?</strong>
    <ul style="margin:0.5rem 0 0;padding-left:1.2rem;">
      ${
    metrics.map((m) =>
      `<li><strong>${metricLabel(m)}</strong> — ${metricExplanation(m)}</li>`
    ).join("\n      ")
  }
    </ul>
    <p style="margin:0.5rem 0 0;font-size:0.85em;color:#888;">Expected = hourly average so far. Actual = this hour's count. Score = how many standard deviations from the mean.</p>
  </div>`;

const userIdCell = (userId?: string) =>
  userId ? `<td>${userId}</td>` : `<td class="muted">-</td>`;

const formatAnomaly = (
  { eventName, bucket, expected, actual, zScore, metric, userId }: Anomaly,
) =>
  `<tr>
    <td>${metricLabel(metric)}</td>
    <td>${eventName}</td>
    ${userIdCell(userId)}
    <td>${bucket}</td>
    <td>${expected}</td>
    <td>${actual}</td>
    <td>${zScore}</td>
  </tr>`;

const anomaliesHtml = (projectName: string, anomalies: Anomaly[]) =>
  `<h2>${projectName}: ${anomalies.length} Anomal${
    anomalies.length === 1 ? "y" : "ies"
  } Detected</h2>
  <table border="1" cellpadding="8" cellspacing="0">
    <tr><th>Type</th><th>Event</th><th>User</th><th>Bucket</th><th>Expected</th><th>Actual</th><th>Score</th></tr>
    ${anomalies.map(formatAnomaly).join("\n    ")}
  </table>
  ${legendHtml(uniqueMetrics(anomalies))}`;

const anomalyText = (
  { eventName, bucket, expected, actual, zScore, metric, userId }: Anomaly,
) =>
  `${metricLabel(metric)} Anomaly: ${eventName}${
    userId ? ` (user: ${userId})` : ""
  } in ${bucket} — expected ${expected}, got ${actual} (score=${zScore})`;

const anomaliesText = (anomalies: Anomaly[]) =>
  anomalies.map(anomalyText).join("\n");

const subjectLine = (
  projectName: string,
  { metric, eventName, userId }: Anomaly,
) =>
  `[${projectName}] ${metricLabel(metric)}: ${eventName}${
    userId ? ` (${userId})` : ""
  }`;

const batchSubject = (projectName: string, anomalies: Anomaly[]) =>
  anomalies.length === 1
    ? subjectLine(projectName, anomalies[0])
    : `[${projectName}] ${anomalies.length} anomalies detected`;

export const sendAnomalyAlerts = async (
  toEmail: string,
  projectName: string,
  anomalies: Anomaly[],
) => {
  const count = await incrementEmailCount(toEmail);
  if (count > maxEmailsPerDay) {
    console.log(
      `Email limit reached for ${toEmail} (${count}/${maxEmailsPerDay})`,
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
