const posthogKey = Deno.env.get("POSTHOG_API_KEY") ??
  Deno.env.get("POSTHOG_KEY") ??
  "";
const posthogHost = Deno.env.get("POSTHOG_HOST") ?? "https://us.i.posthog.com";

export const captureServerEvent = (
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
) => {
  if (!posthogKey) return;
  fetch(`${posthogHost}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: posthogKey,
      event,
      distinct_id: distinctId,
      properties: {
        $lib: "anomalisa-server",
        ...properties,
      },
      timestamp: new Date().toISOString(),
    }),
  }).catch((err) => {
    console.warn("PostHog capture failed:", err);
  });
};
