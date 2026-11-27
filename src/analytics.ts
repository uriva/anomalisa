import { context } from "@uri/inject";

export const defaultPosthogKey =
  "phc_rjtFQTqewBSkcMXu7VwMPjzojSSLdxygumxwrxDcZVaU";
export const defaultPosthogHost = "https://us.i.posthog.com";

export type AnalyticsProperties = Record<
  string,
  string | number | boolean | undefined
>;

export const { inject: injectAnalyticsFetch, access: analyticsFetch } = context(
  (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
);

const getPosthogKey = () =>
  Deno.env.get("POSTHOG_API_KEY") ??
    Deno.env.get("POSTHOG_KEY") ??
    defaultPosthogKey;
const getPosthogHost = () => Deno.env.get("POSTHOG_HOST") ?? defaultPosthogHost;

const sendServerEvent = (
  distinctId: string,
  event: string,
  properties?: AnalyticsProperties,
): Promise<void> => {
  const key = getPosthogKey();
  if (!key) return Promise.resolve();
  return analyticsFetch(`${getPosthogHost()}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: distinctId,
      properties: {
        $lib: "anomalisa-server",
        ...(properties ?? {}),
      },
      timestamp: new Date().toISOString(),
    }),
  }).then(() => {}).catch((err) => {
    console.warn("PostHog capture failed:", err);
  });
};

export const {
  inject: injectCaptureServerEvent,
  access: captureServerEvent,
} = context(sendServerEvent);
