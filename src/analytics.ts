export const defaultPosthogKey =
  "phc_rjtFQTqewBSkcMXu7VwMPjzojSSLdxygumxwrxDcZVaU";
export const defaultPosthogHost = "https://us.i.posthog.com";

const getPosthogKey = () =>
  Deno.env.get("POSTHOG_API_KEY") ??
    Deno.env.get("POSTHOG_KEY") ??
    defaultPosthogKey;
const getPosthogHost = () => Deno.env.get("POSTHOG_HOST") ?? defaultPosthogHost;

export const captureServerEvent = (
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
) => {
  const key = getPosthogKey();
  if (!key) return Promise.resolve();
  return fetch(`${getPosthogHost()}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event,
      distinct_id: distinctId,
      properties: {
        $lib: "anomalisa-server",
        ...properties,
      },
      timestamp: new Date().toISOString(),
    }),
  }).then(() => {}).catch((err) => {
    console.warn("PostHog capture failed:", err);
  });
};
