import { assertEquals } from "@std/assert";
import {
  captureClientErrors,
  errorEventNames,
  isIgnorable,
  messageOf,
} from "./mod.ts";

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
    let scriptPrevented = false;
    let scriptStopped = false;
    const scriptErrorEvent = new ErrorEvent("error", {
      message: "Script error.",
      error: null,
    });
    scriptErrorEvent.preventDefault = () => {
      scriptPrevented = true;
    };
    scriptErrorEvent.stopImmediatePropagation = () => {
      scriptStopped = true;
    };
    errorListener(scriptErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 0, "Script error. should be ignored");
    assertEquals(scriptPrevented, true, "Script error. should preventDefault");
    assertEquals(
      scriptStopped,
      true,
      "Script error. should stopImmediatePropagation",
    );

    // 2. Resource load error (e.g. <img> or <script> 404)
    let resourceStopped = false;
    const resourceErrorEvent = new Event("error");
    Object.defineProperty(resourceErrorEvent, "target", {
      value: { tagName: "IMG" },
    });
    resourceErrorEvent.stopImmediatePropagation = () => {
      resourceStopped = true;
    };
    errorListener(resourceErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 0, "Resource load error should be ignored");
    assertEquals(
      resourceStopped,
      false,
      "Resource load error should not stopImmediatePropagation",
    );

    // 3. Real runtime error
    let realStopped = false;
    const realErrorEvent = new ErrorEvent("error", {
      message: "Uncaught TypeError: cannot read property of null",
      error: new TypeError("cannot read property of null"),
    });
    realErrorEvent.stopImmediatePropagation = () => {
      realStopped = true;
    };
    errorListener(realErrorEvent);
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(reportedCount, 1, "Real error should be captured");
    assertEquals(
      realStopped,
      false,
      "Real error should not stopImmediatePropagation",
    );
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
      let prevented = false;
      let stopped = false;
      rejectionListener({
        reason,
        preventDefault: () => {
          prevented = true;
        },
        stopImmediatePropagation: () => {
          stopped = true;
        },
      });
      await new Promise((r) => setTimeout(r, 20));
      return { prevented, stopped };
    };

    // 1. Chrome extension stack trace
    const chromeExtErr = new TypeError(
      "Cannot read properties of undefined (reading 'M_ID')",
    );
    chromeExtErr.stack =
      "TypeError: Cannot read properties of undefined (reading 'M_ID')\n    at Z (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:1:761)";
    const extRes = await fireRejection(chromeExtErr);
    assertEquals(
      reportedCount,
      0,
      "Chrome extension rejection should be ignored",
    );
    assertEquals(extRes.prevented, true);
    assertEquals(extRes.stopped, true);

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

    // 8. Browser translation UTF-16 URIError rejection
    const translationErr = new URIError(
      "String contained an illegal UTF-16 sequence.",
    );
    translationErr.stack =
      "?@https://aliceandbot.com/chat:843:22039\ntranslate@https://aliceandbot.com/chat:843:40210";
    await fireRejection(translationErr);
    assertEquals(
      reportedCount,
      0,
      "Browser translation URIError should be ignored",
    );

    // 9. Lit-html DOM mutation null error (e.g. setting 'data' or nextSibling)
    await fireRejection(
      new TypeError("Cannot set properties of null (setting 'data')"),
    );
    assertEquals(
      reportedCount,
      0,
      "Lit-html setting 'data' on null should be ignored",
    );
    await fireRejection(
      new TypeError("Cannot read properties of null (reading 'nextSibling')"),
    );
    assertEquals(
      reportedCount,
      0,
      "Lit-html reading 'nextSibling' on null should be ignored",
    );

    // 10. Media / network abort errors
    await fireRejection(
      new Error("The play() request was interrupted by a call to pause()."),
    );
    await fireRejection(new TypeError("Failed to fetch"));
    await fireRejection(new TypeError("Load failed"));
    assertEquals(
      reportedCount,
      0,
      "Media and network abort rejections should be ignored",
    );

    // 11. Web3 / extension disconnect error
    await fireRejection(
      new Error("The provider is disconnected from all chains."),
    );
    assertEquals(
      reportedCount,
      0,
      "Web3 provider disconnect rejection should be ignored",
    );

    // 12. Real application rejection
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

Deno.test("messageOf extracts detailed error messages from various structures", () => {
  assertEquals(messageOf(new Error("Network failed")), "Network failed");
  assertEquals(messageOf(new Error("")), "Error");
  assertEquals(messageOf("Direct error string"), "Direct error string");
  assertEquals(messageOf({ error: "API key invalid" }), "API key invalid");
  assertEquals(
    messageOf({ error: new Error("Nested error") }),
    "Nested error",
  );
  assertEquals(messageOf({ reason: "Session expired" }), "Session expired");
  assertEquals(
    messageOf({ status: 500, statusText: "Internal Server Error" }),
    "500: Internal Server Error",
  );
  assertEquals(messageOf({ status: 404 }), "404");
  assertEquals(
    messageOf({ details: "Quota limit exceeded" }),
    "Quota limit exceeded",
  );
  assertEquals(
    messageOf({ body: { message: "Record not found: app-user-magic-code" } }),
    "Record not found: app-user-magic-code",
  );
  assertEquals(messageOf(null), "null");
  assertEquals(messageOf(undefined), "undefined");
  assertEquals(messageOf(404), "404");
  assertEquals(messageOf(false), "false");
  assertEquals(messageOf({ customField: 123 }), '{"customField":123}');
  assertEquals(messageOf({}), "{}");

  const circular: Record<string, unknown> = { name: "Circular" };
  circular.self = circular;
  assertEquals(messageOf(circular).includes("Circular"), true);
});

Deno.test("isIgnorable identifies browser-level, storage, WebView, and expected auth noise", () => {
  assertEquals(
    isIgnorable(
      new Error(
        "ResizeObserver loop completed with undelivered notifications.",
      ),
    ),
    true,
  );
  assertEquals(isIgnorable("Script error."), true);
  assertEquals(isIgnorable(null), true);
  assertEquals(isIgnorable(undefined), true);
  assertEquals(isIgnorable("Not found"), true);
  assertEquals(
    isIgnorable("AbortError: signal is aborted without reason"),
    true,
  );
  assertEquals(isIgnorable("Unknown rejection"), true);
  assertEquals(isIgnorable("unknown rejection"), true);
  assertEquals(isIgnorable("error"), true);
  assertEquals(isIgnorable("ERROR"), true);
  assertEquals(isIgnorable({}), true);
  assertEquals(isIgnorable("{}"), true);
  assertEquals(isIgnorable("[object Object]"), true);
  assertEquals(isIgnorable("unhandledrejection"), true);
  assertEquals(isIgnorable("Unknown error"), true);
  assertEquals(
    isIgnorable("Error invoking postMessage: Java object is gone"),
    true,
  );
  assertEquals(isIgnorable("Object Not Found Matching Id: 1"), true);
  assertEquals(
    isIgnorable(
      new Error(
        "Failed to read the 'localStorage' property from 'Window': Access is denied for this document.",
      ),
    ),
    true,
  );
  assertEquals(
    isIgnorable(
      new TypeError("Cannot read properties of null (reading 'getItem')"),
    ),
    true,
  );
  assertEquals(
    isIgnorable(
      "UnknownError: Attempt to get records from database without an in-progress transaction",
    ),
    true,
  );
  assertEquals(isIgnorable(new TypeError("Failed to fetch")), true);
  assertEquals(isIgnorable("Load failed"), true);
  assertEquals(
    isIgnorable("NetworkError when attempting to fetch resource"),
    true,
  );
  assertEquals(isIgnorable(new Error("Failed to connect to MetaMask")), true);
  assertEquals(
    isIgnorable(
      new TypeError("Cannot read properties of undefined (reading 'M_ID')"),
    ),
    true,
  );
  assertEquals(isIgnorable("Cannot redefine property: web3"), true);
  assertEquals(
    isIgnorable("The provider is disconnected from all chains."),
    true,
  );
  assertEquals(isIgnorable("xbrowser is not defined"), true);
  assertEquals(
    isIgnorable(
      "Error invoking postMessage: Java exception was raised during method invocation",
    ),
    true,
  );
  assertEquals(
    isIgnorable(
      "The transaction was aborted, so the request cannot be fulfilled.",
    ),
    true,
  );
  assertEquals(isIgnorable("Transaction timed out due to inactivity."), true);
  assertEquals(
    isIgnorable(new Error("Operation timed out: handle-receive")),
    true,
  );
  assertEquals(isIgnorable(new Error("Query timed out")), true);
  assertEquals(
    isIgnorable(
      new Error("Cannot read properties of undefined (reading 'buffer')"),
    ),
    true,
  );
  assertEquals(
    isIgnorable(new Error("Record not found: app-user-magic-code")),
    true,
  );
  assertEquals(
    isIgnorable(
      "Failed to execute 'createObjectStore' on 'IDBDatabase': The database is not running a version change trans",
    ),
    true,
  );
  assertEquals(isIgnorable({ isTrusted: true, type: "error" }), true);
  assertEquals(isIgnorable({ error: "API failure" }), false);
  assertEquals(
    isIgnorable(new Error("Cannot read properties of null (reading 'map')")),
    false,
  );
});

Deno.test("errorEventNames returns base + detail for actionable errors and empty array for noise", () => {
  assertEquals(
    errorEventNames("client_render_error")(
      new Error("Object.hasOwn is not a function"),
    ),
    [
      "client_render_error",
      "client_render_error: Object.hasOwn is not a function",
    ],
  );
  assertEquals(errorEventNames("client_render_error")(null), []);
  assertEquals(
    errorEventNames("client_render_error")(new TypeError("Failed to fetch")),
    [],
  );
  const events = errorEventNames("client_render_error")(
    new Error("x".repeat(200)),
  );
  assertEquals(events[1].length, 120);
  assertEquals(events[1].startsWith("client_render_error: "), true);
});
