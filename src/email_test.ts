import { assertEquals } from "@std/assert";
import type { Anomaly } from "./anomaly.ts";
import {
  anomaliesHtml,
  anomaliesText,
  batchSubject,
  formatBucket,
  sendAnomalyAlerts,
} from "./email.ts";

const mockFetch = (
  _input: string | Request | URL,
  _init?: RequestInit,
): Promise<Response> => Promise.resolve(new Response("OK", { status: 200 }));

const withMockFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = mockFetch as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const clearEmailCounts = async () => {
  const kv = await Deno.openKv();
  const entries = kv.list<number>({ prefix: ["emailCount"] });
  for await (const entry of entries) {
    await kv.delete(entry.key);
  }
  kv.close();
};

const singleAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "login",
  bucket: "2026-04-06T23",
  expected: 10,
  actual: 30,
  zScore: 3.5,
  metric: "totalCount",
  detectedAt: "2026-04-06T23:30:00Z",
};

const twoAnomalies: Anomaly[] = [
  singleAnomaly,
  {
    projectId: "proj1",
    eventName: "signup",
    bucket: "2026-04-07T09",
    expected: 5,
    actual: 20,
    zScore: 4.1,
    metric: "percentageSpike",
    detectedAt: "2026-04-07T09:15:00Z",
    userId: "user123",
  },
];

const longUserAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "click",
  bucket: "2026-04-07T09",
  expected: 5,
  actual: 20,
  zScore: 4.1,
  metric: "userSpike",
  detectedAt: "2026-04-07T09:15:00Z",
  userId: "this_is_a_very_long_user_id_that_should_be_truncated",
};

const dropAnomaly: Anomaly = {
  projectId: "proj1",
  eventName: "Chat Message",
  bucket: "2026-04-17T09",
  expected: 66,
  actual: 0,
  zScore: 1,
  metric: "percentageDrop",
  detectedAt: "2026-04-17T10:05:00Z",
};

Deno.test("batchSubject uses specific subject for single anomaly", () => {
  assertEquals(
    batchSubject("myapp", [singleAnomaly]),
    "[myapp] Total Count: login",
  );
});

Deno.test("batchSubject labels percentageDrop as Percentage Drop", () => {
  assertEquals(
    batchSubject("myapp", [dropAnomaly]),
    "[myapp] Percentage Drop: Chat Message",
  );
});

Deno.test("anomaliesHtml renders percentageDrop section", () => {
  const html = anomaliesHtml("myapp", [dropAnomaly]);
  assertEquals(html.includes("Percentage Drop"), true);
  assertEquals(html.includes("dropped"), true);
});

Deno.test("batchSubject shows count for multiple anomalies", () => {
  assertEquals(
    batchSubject("myapp", twoAnomalies),
    "[myapp] 2 anomalies detected",
  );
});

Deno.test("batchSubject truncates long user id", () => {
  assertEquals(
    batchSubject("myapp", [longUserAnomaly]),
    "[myapp] User Spike: click (this_is_a_very_long_...)",
  );
});

Deno.test("anomaliesHtml says 'Anomaly Detected' without count for single anomaly", () => {
  const html = anomaliesHtml("myapp", [singleAnomaly]);
  assertEquals(html.includes("1 Anomaly"), false);
  assertEquals(html.includes("Anomaly Detected"), true);
});

Deno.test("anomaliesHtml shows count for multiple anomalies", () => {
  const html = anomaliesHtml("myapp", twoAnomalies);
  assertEquals(html.includes("2 Anomalies Detected"), true);
});

Deno.test("anomaliesHtml truncates long user id", () => {
  const html = anomaliesHtml("myapp", [longUserAnomaly]);
  assertEquals(html.includes("this_is_a_very_long_user_id"), false);
  assertEquals(html.includes("this_is_a_very_long_..."), true);
});

Deno.test("formatBucket renders human-readable date", () => {
  assertEquals(formatBucket("2026-04-06T23"), "Mon Apr 6, 11pm–12am UTC");
});

Deno.test("formatBucket renders midnight as 12am", () => {
  assertEquals(formatBucket("2026-04-07T00"), "Tue Apr 7, 12am–1am UTC");
});

Deno.test("formatBucket renders hour as range e.g. 12am–1am", () => {
  assertEquals(formatBucket("2026-04-20T00"), "Mon Apr 20, 12am–1am UTC");
});

Deno.test("formatBucket renders noon as 12pm", () => {
  assertEquals(formatBucket("2026-04-07T12"), "Tue Apr 7, 12pm–1pm UTC");
});

Deno.test("formatBucket renders morning hour", () => {
  assertEquals(formatBucket("2026-04-07T09"), "Tue Apr 7, 9am–10am UTC");
});

Deno.test("anomaliesHtml uses formatted bucket not raw ISO", () => {
  const html = anomaliesHtml("myapp", [singleAnomaly]);
  assertEquals(html.includes("2026-04-06T23"), false);
  assertEquals(html.includes("Mon Apr 6, 11pm–12am UTC"), true);
});

Deno.test("anomaliesText uses formatted bucket not raw ISO", () => {
  const text = anomaliesText([singleAnomaly]);
  assertEquals(text.includes("2026-04-06T23"), false);
  assertEquals(text.includes("Mon Apr 6, 11pm–12am UTC"), true);
});

Deno.test("anomaliesText truncates long user id", () => {
  const text = anomaliesText([longUserAnomaly]);
  assertEquals(text.includes("this_is_a_very_long_user_id"), false);
  assertEquals(text.includes("this_is_a_very_long_..."), true);
});

Deno.test({
  name: "sendAnomalyAlerts — rate limits per project+event",
  sanitizeResources: false,
  fn: async () => {
  const kv = await Deno.openKv();
  const clear = async () => {
    const entries = kv.list<number>({ prefix: ["emailCount"] });
    for await (const entry of entries) {
      await kv.delete(entry.key);
    }
  };
  await clear();

  const anomaly = (
    eventName: string,
    projectName: string,
    day: string,
  ): Anomaly => ({
    projectId: "p1",
    eventName,
    bucket: `${day}T00`,
    expected: 1,
    actual: 5,
    zScore: 3,
    metric: "totalCount",
    detectedAt: `${day}T00:00:00Z`,
  });

  await withMockFetch(async () => {
    // allows up to 5 for same project+event
    const errA = anomaly("error", "proj", "2026-01-01");
    for (let i = 0; i < 5; i++) {
      await sendAnomalyAlerts("a@b.com", "proj", [errA]);
    }

    // blocks 6th for same project+event
    let blocked = false;
    const errB = anomaly("error", "proj", "2026-01-02");
    for (let i = 0; i < 6; i++) {
      const result = await sendAnomalyAlerts("a2@b.com", "proj", [errB]);
      if (result === undefined && i === 5) blocked = true;
    }
    assertEquals(blocked, true);

    // different event type has its own quota
    let sixthAllowed = false;
    const errC = anomaly("error", "proj", "2026-01-03");
    const signupC = anomaly("signup", "proj", "2026-01-03");
    for (let i = 0; i < 5; i++) {
      await sendAnomalyAlerts("a3@b.com", "proj", [errC]);
    }
    sixthAllowed =
      (await sendAnomalyAlerts("a3@b.com", "proj", [signupC])) !== undefined;
    assertEquals(sixthAllowed, true);

    // different project has its own quota
    let sixthAllowedProj = false;
    const errD = anomaly("error", "projA", "2026-01-04");
    for (let i = 0; i < 5; i++) {
      await sendAnomalyAlerts("a4@b.com", "projA", [errD]);
    }
    sixthAllowedProj =
      (await sendAnomalyAlerts("a4@b.com", "projB", [errD])) !== undefined;
    assertEquals(sixthAllowedProj, true);
  });

  kv.close();
  },
});
