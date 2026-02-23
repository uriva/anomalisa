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

const sendEmail = (email: Email) =>
  fetch("https://api.forwardemail.net/v1/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify({ ...email, encoding: "utf-8" }),
  });

const metricLabel = (metric: Anomaly["metric"]) =>
  metric === "userSpike" ? "User Spike" : "Total Count";

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

const anomalyHtml = (anomaly: Anomaly) =>
  `<h2>Anomaly Detected</h2>
  <table border="1" cellpadding="8" cellspacing="0">
    <tr><th>Type</th><th>Event</th><th>User</th><th>Bucket</th><th>Expected</th><th>Actual</th><th>Z-Score</th></tr>
    ${formatAnomaly(anomaly)}
  </table>`;

const anomalyText = (
  { eventName, bucket, expected, actual, zScore, metric, userId }: Anomaly,
) =>
  `${metricLabel(metric)} Anomaly: ${eventName}${userId ? ` (user: ${userId})` : ""} in ${bucket} — expected ${expected}, got ${actual} (z=${zScore})`;

const subjectLine = ({ metric, eventName, userId }: Anomaly) =>
  `[anomalisa] ${metricLabel(metric)}: ${eventName}${userId ? ` (${userId})` : ""}`;

export const sendAnomalyAlert = (toEmail: string, anomaly: Anomaly) =>
  sendEmail({
    from: `alerts@${emailDomain}`,
    to: toEmail,
    subject: subjectLine(anomaly),
    html: anomalyHtml(anomaly),
    text: anomalyText(anomaly),
  });
