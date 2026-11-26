import { context } from "@uri/inject";
import type { Anomaly } from "./anomaly.ts";
import { hmacSha256Hex } from "./billing.ts";
import { withRetry } from "./retry.ts";

export const {
  inject: injectWebhookFetch,
  access: webhookFetch,
} = context(
  (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
);

export type WebhookOptions = {
  secret?: string;
  retries?: number;
  retryDelayMs?: number;
  timestampSeconds?: number;
};

export const signWebhookPayload = async (
  body: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<string> =>
  `t=${timestampSeconds},v1=${
    await hmacSha256Hex(secret, `${timestampSeconds}.${body}`)
  }`;

const postWebhookOnce = async ({
  url,
  headers,
  body,
}: {
  url: string;
  headers: Record<string, string>;
  body: string;
}): Promise<Response> => {
  const res = await webhookFetch(url, { method: "POST", headers, body });
  return res.ok
    ? res
    : Promise.reject(new Error(`Webhook HTTP ${res.status}`));
};

export const sendWebhook = async (
  url: string,
  anomaly: Anomaly,
  options?: WebhookOptions,
): Promise<Response> => {
  const body = JSON.stringify(anomaly);
  const secret = options?.secret?.trim();
  if (!secret) {
    return webhookFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  const signature = await signWebhookPayload(
    body,
    secret,
    options?.timestampSeconds,
  );
  const headers = {
    "Content-Type": "application/json",
    "X-Anomalisa-Signature": signature,
  };
  return withRetry(
    options?.retries ?? 2,
    options?.retryDelayMs ?? 500,
    postWebhookOnce,
  )({ url, headers, body });
};
