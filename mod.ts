import { apiClient, httpCommunication } from "@uri/typed-api";
import { apiDefinition } from "./src/api.ts";
import type { Anomaly } from "./src/anomaly.ts";
import { withRetry } from "./src/retry.ts";

const communication = httpCommunication("https://anomalisa.uriva.deno.net");

const client = apiClient(
  <input, output>(params: input) =>
    withRetry(2, 500, (p: input) => communication<input, output>(p))(params),
  apiDefinition,
);

type SendEventPayload = {
  token: string;
  userId?: string;
  eventName: string;
};

export type { Anomaly };

export const sendEvent: (
  payload: SendEventPayload,
) => Promise<Record<string, never>> = (payload) =>
  client({ endpoint: "sendEvent", payload });

export const getAnomalies: (
  payload: { token: string },
) => Promise<{ anomalies: Anomaly[] }> = (payload) =>
  client({ endpoint: "getAnomalies", payload });

export const getEventCounts: (
  payload: { token: string },
) => Promise<{
  events: Record<string, { bucket: string; count: number }[]>;
}> = (payload) => client({ endpoint: "getEventCounts", payload });

const uncaughtErrorEvent = "client_error";
const unhandledRejectionEvent = "unhandled_rejection";

const extensionPrefixes = [
  "chrome-extension://",
  "moz-extension://",
  "safari-extension://",
  "safari-web-extension://",
  "ms-browser-extension://",
  "extension://",
];

const hasExtensionPrefix = (text: string) =>
  extensionPrefixes.some((prefix) => text.includes(prefix));

const extractStrings = (input: unknown): string[] => {
  if (typeof input === "string") return [input];
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  const keys = ["message", "stack", "filename", "fileName", "sourceURL"];
  return keys
    .map((k) => record[k])
    .filter((v): v is string => typeof v === "string");
};

export const isBrowserExtensionError = (reason: unknown) =>
  extractStrings(reason).some(
    (str) =>
      hasExtensionPrefix(str) ||
      str.includes("Object Not Found Matching Id"),
  );

export const isResizeObserverError = (reason: unknown) =>
  extractStrings(reason).some((str) => str.includes("ResizeObserver"));

export const isNullRejection = (reason: unknown) =>
  reason === null || reason === undefined;

export const isEventRejection = (reason: unknown) => {
  if (!reason || typeof reason !== "object") return false;
  if (typeof Event !== "undefined" && reason instanceof Event) return true;
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return true;
  }
  const tag = Object.prototype.toString.call(reason);
  if (tag.endsWith("Event]") || tag === "[object DOMException]") return true;
  const name = (reason as { constructor?: { name?: string } }).constructor
    ?.name;
  if (
    typeof name === "string" &&
    (name === "Event" || name.endsWith("Event") || name === "DOMException")
  ) {
    return true;
  }
  if (
    "isTrusted" in reason &&
    typeof (reason as { isTrusted: unknown }).isTrusted === "boolean"
  ) {
    return true;
  }
  const message = (reason as { message?: unknown }).message;
  if (typeof message === "string" && message.includes("IDBDatabase")) {
    return true;
  }
  return false;
};

const isIgnoredRejection = (reason: unknown) =>
  isNullRejection(reason) ||
  isEventRejection(reason) ||
  isBrowserExtensionError(reason) ||
  isResizeObserverError(reason);

const isIgnoredErrorEvent = (event: Event) => {
  if (!(event instanceof ErrorEvent)) return true;
  if (event.message === "Script error." && !event.error) return true;
  if (
    isBrowserExtensionError(event.error) ||
    isBrowserExtensionError(event.filename) ||
    isBrowserExtensionError(event.message)
  ) {
    return true;
  }
  if (
    isResizeObserverError(event.error) ||
    isResizeObserverError(event.message)
  ) {
    return true;
  }
  return false;
};

const report = (token: string, userId: string | undefined) => {
  const state = { reporting: false };
  return (eventName: string) => {
    if (state.reporting) return;
    state.reporting = true;
    sendEvent({ token, eventName, ...(userId ? { userId } : {}) })
      .catch(() => {})
      .finally(() => {
        state.reporting = false;
      });
  };
};

export const captureClientErrors = (
  { token, userId }: { token: string; userId?: string },
): (eventName: string) => void => {
  const capture = report(token, userId);
  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("error", (event: Event) => {
      if (isIgnoredErrorEvent(event)) return;
      capture(uncaughtErrorEvent);
    });
    globalThis.addEventListener(
      "unhandledrejection",
      (event: Event) => {
        const reason = (event as { reason?: unknown }).reason;
        if (isIgnoredRejection(reason)) return;
        capture(unhandledRejectionEvent);
      },
    );
  }
  return capture;
};
