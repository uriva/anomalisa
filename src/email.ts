import type { Anomaly } from "./anomaly.ts";

const apiKey = Deno.env.get("FORWARD_EMAIL_API_KEY") ?? "";
const emailDomain = Deno.env.get("EMAIL_DOMAIN") ?? "";
const authHeader = `Basic ${btoa(apiKey + ":")}`;

type Email = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
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

const anomaliesHtml = (anomalies: Anomaly[]) =>
  `<h2>${anomalies.length} Anomal${anomalies.length === 1 ? "y" : "ies"} Detected</h2>
  <table border="1" cellpadding="8" cellspacing="0">
    <tr><th>Type</th><th>Event</th><th>User</th><th>Bucket</th><th>Expected</th><th>Actual</th><th>Score</th></tr>
    ${anomalies.map(formatAnomaly).join("\n    ")}
  </table>`;

const anomalyText = (
  { eventName, bucket, expected, actual, zScore, metric, userId }: Anomaly,
) =>
  `${metricLabel(metric)} Anomaly: ${eventName}${
    userId ? ` (user: ${userId})` : ""
  } in ${bucket} — expected ${expected}, got ${actual} (score=${zScore})`;

const anomaliesText = (anomalies: Anomaly[]) =>
  anomalies.map(anomalyText).join("\n");

const subjectLine = ({ metric, eventName, userId }: Anomaly) =>
  `[anomalisa] ${metricLabel(metric)}: ${eventName}${
    userId ? ` (${userId})` : ""
  }`;

const batchSubject = (anomalies: Anomaly[]) =>
  anomalies.length === 1
    ? subjectLine(anomalies[0])
    : `[anomalisa] ${anomalies.length} anomalies detected`;

export const sendAnomalyAlerts = (toEmail: string, anomalies: Anomaly[]) =>
  sendEmail({
    from: `alerts@${emailDomain}`,
    to: toEmail,
    subject: batchSubject(anomalies),
    html: anomaliesHtml(anomalies),
    text: anomaliesText(anomalies),
  });
