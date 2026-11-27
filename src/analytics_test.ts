import { assert, assertEquals } from "@std/assert";
import {
  captureServerEvent,
  defaultPosthogHost,
  defaultPosthogKey,
  injectPosthogFetch,
} from "./analytics.ts";

type CapturedPosthogCall = {
  url: string;
  method: string;
  body: {
    api_key: string;
    event: string;
    distinct_id: string;
    properties: Record<string, string | number | boolean | undefined>;
    timestamp: string;
  };
};

const makePosthogRecorder =
  (calls: CapturedPosthogCall[]) =>
  (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: JSON.parse(init?.body ? String(init.body) : "{}"),
    });
    return Promise.resolve(new Response(JSON.stringify({ status: 1 }), { status: 200 }));
  };

Deno.test("captureServerEvent posts expected PostHog /capture/ payload", async () => {
  const prevKey = Deno.env.get("POSTHOG_API_KEY");
  const prevHost = Deno.env.get("POSTHOG_HOST");
  Deno.env.delete("POSTHOG_API_KEY");
  Deno.env.delete("POSTHOG_HOST");
  const calls: CapturedPosthogCall[] = [];
  try {
    await injectPosthogFetch(makePosthogRecorder(calls))(() =>
      captureServerEvent("user@example.com", "checkout_started", {
        plan: "pro",
        projectId: "proj-1",
      })
    )();
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, `${defaultPosthogHost}/capture/`);
    assertEquals(calls[0].method, "POST");
    assertEquals(calls[0].body.api_key, defaultPosthogKey);
    assertEquals(calls[0].body.event, "checkout_started");
    assertEquals(calls[0].body.distinct_id, "user@example.com");
    assertEquals(calls[0].body.properties.$lib, "anomalisa-server");
    assertEquals(calls[0].body.properties.plan, "pro");
    assertEquals(calls[0].body.properties.projectId, "proj-1");
    assert(Boolean(calls[0].body.timestamp));
  } finally {
    if (prevKey !== undefined) Deno.env.set("POSTHOG_API_KEY", prevKey);
    if (prevHost !== undefined) Deno.env.set("POSTHOG_HOST", prevHost);
  }
});

Deno.test("captureServerEvent is a no-op when POSTHOG_API_KEY is empty", async () => {
  const prevKey = Deno.env.get("POSTHOG_API_KEY");
  Deno.env.set("POSTHOG_API_KEY", "");
  const calls: CapturedPosthogCall[] = [];
  try {
    await injectPosthogFetch(makePosthogRecorder(calls))(() =>
      captureServerEvent("user@example.com", "checkout_started", {
        plan: "pro",
      })
    )();
    assertEquals(calls.length, 0);
  } finally {
    if (prevKey !== undefined) {
      Deno.env.set("POSTHOG_API_KEY", prevKey);
    } else {
      Deno.env.delete("POSTHOG_API_KEY");
    }
  }
});
