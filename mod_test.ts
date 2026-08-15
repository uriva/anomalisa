import { assertEquals } from "@std/assert";
import { captureClientErrors } from "./mod.ts";

Deno.test("captureClientErrors — filters out opaque cross-origin Script error and resource load errors", async () => {
  let reportedCount = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("sendEvent") || url.includes("anomalisa")) {
      reportedCount++;
    }
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

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

Deno.test("captureClientErrors — unhandledrejection ignores browser extensions, DOM events, null, and ResizeObserver", async () => {
  let reportedCount = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("sendEvent") || url.includes("anomalisa")) {
      reportedCount++;
    }
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

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

    const rejectionListener = listeners["unhandledrejection"]?.[0];
    assertEquals(typeof rejectionListener, "function");

    const fireRejection = async (reason: unknown) => {
      rejectionListener({ reason });
      await new Promise((r) => setTimeout(r, 20));
    };

    // 1. Chrome extension stack trace
    const chromeExtErr = new TypeError(
      "Cannot read properties of undefined (reading 'M_ID')",
    );
    chromeExtErr.stack =
      "TypeError: Cannot read properties of undefined (reading 'M_ID')\n    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)";
    await fireRejection(chromeExtErr);
    assertEquals(
      reportedCount,
      0,
      "Chrome extension rejection should be ignored",
    );

    // 2. Moz extension error
    const mozExtErr = new Error("moz failure");
    mozExtErr.stack =
      "Error: moz failure\n    at moz-extension://1234/content.js:1:1";
    await fireRejection(mozExtErr);
    assertEquals(reportedCount, 0, "Moz extension rejection should be ignored");

    // 3. Extension host object
    await fireRejection(
      "Object Not Found Matching Id:1, MethodName:update, ParamCount:4",
    );
    assertEquals(
      reportedCount,
      0,
      "Extension host object rejection should be ignored",
    );

    // 4. ResizeObserver error
    await fireRejection(
      new Error(
        "ResizeObserver loop completed with undelivered notifications.",
      ),
    );
    assertEquals(
      reportedCount,
      0,
      "ResizeObserver rejection should be ignored",
    );

    // 5. Null rejection
    await fireRejection(null);
    assertEquals(reportedCount, 0, "null rejection should be ignored");

    // 6. Undefined rejection
    await fireRejection(undefined);
    assertEquals(reportedCount, 0, "undefined rejection should be ignored");

    // 7. Raw DOM event rejection (e.g. IndexedDB error event)
    await fireRejection(new Event("error"));
    assertEquals(reportedCount, 0, "Event rejection should be ignored");

    // 8. Real application rejection
    await fireRejection(new Error("real app crash"));
    assertEquals(
      reportedCount,
      1,
      "Real application rejection should be captured",
    );
  } finally {
    globalThis.addEventListener = origAddEventListener;
    globalThis.fetch = origFetch;
  }
});

Deno.test("captureClientErrors — error listener ignores browser extensions and ResizeObserver", async () => {
  let reportedCount = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (url.includes("sendEvent") || url.includes("anomalisa")) {
      reportedCount++;
    }
    return new Response(JSON.stringify({ result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

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

    const fireError = async (event: Event) => {
      errorListener(event);
      await new Promise((r) => setTimeout(r, 20));
    };

    // 1. Chrome extension ErrorEvent filename
    await fireError(
      new ErrorEvent("error", {
        message: "Uncaught TypeError: bad",
        filename:
          "chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js",
      }),
    );
    assertEquals(
      reportedCount,
      0,
      "Chrome extension ErrorEvent should be ignored",
    );

    // 2. ResizeObserver ErrorEvent
    await fireError(
      new ErrorEvent("error", {
        message:
          "ResizeObserver loop completed with undelivered notifications.",
      }),
    );
    assertEquals(
      reportedCount,
      0,
      "ResizeObserver ErrorEvent should be ignored",
    );

    // 3. Real runtime error
    await fireError(
      new ErrorEvent("error", {
        message: "Uncaught ReferenceError: foo is not defined",
        filename: "https://example.com/app.js",
        error: new ReferenceError("foo is not defined"),
      }),
    );
    assertEquals(
      reportedCount,
      1,
      "Real runtime ErrorEvent should be captured",
    );
  } finally {
    globalThis.addEventListener = origAddEventListener;
    globalThis.fetch = origFetch;
  }
});
