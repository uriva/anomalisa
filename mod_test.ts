import { assertEquals } from "@std/assert";

let reportedCount = 0;
const origFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("sendEvent") || url.includes("anomalisa")) {
    reportedCount++;
  }
  return new Response(JSON.stringify({ result: {} }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

const { captureClientErrors } = await import("./mod.ts");

Deno.test("captureClientErrors — filters out opaque cross-origin Script error and resource load errors", async () => {
  const listeners: Record<string, ((event: any) => void)[]> = {};

  const origAddEventListener = globalThis.addEventListener;
  (globalThis as any).addEventListener = (
    type: string,
    cb: (event: any) => void,
  ) => {
    listeners[type] = listeners[type] || [];
    listeners[type].push(cb);
  };

  try {
    captureClientErrors({ token: "test-token" });

    const errorListener = listeners["error"]?.[0];
    assertEquals(typeof errorListener, "function");

    // 1. Cross-origin "Script error." without error object
    const scriptErrorEvent = new ErrorEvent("error", {
      message: "Script error.",
      error: null,
    });
    errorListener(scriptErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 0, "Script error. should be ignored");

    // 2. Resource load error (e.g. <img> or <script> 404)
    const resourceErrorEvent = new Event("error");
    Object.defineProperty(resourceErrorEvent, "target", {
      value: { tagName: "IMG" },
    });
    errorListener(resourceErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 0, "Resource load error should be ignored");

    // 3. Real runtime error
    const realErrorEvent = new ErrorEvent("error", {
      message: "Uncaught TypeError: cannot read property of null",
      error: new TypeError("cannot read property of null"),
    });
    errorListener(realErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 1, "Real error should be captured");
  } finally {
    globalThis.addEventListener = origAddEventListener;
    globalThis.fetch = origFetch;
  }
});
