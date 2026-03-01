import type { Anomaly } from "./anomaly.ts";

export const sendWebhook = (url: string, anomaly: Anomaly) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(anomaly),
  });
