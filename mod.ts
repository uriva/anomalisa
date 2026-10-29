import { apiClient, httpCommunication } from "@uri/typed-api";
import { apiDefinition } from "./src/api.ts";
import type { Anomaly } from "./src/anomaly.ts";
import { withRetry } from "./src/retry.ts";

const communication = httpCommunication("https://anomalisa.uriv.me");

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

type SuppressibleEventLike = {
  reason?: unknown;
  message?: unknown;
  error?: unknown;
  filename?: unknown;
  preventDefault?: unknown;
  stopImmediatePropagation?: unknown;
};

type EventTargetLike = {
  addEventListener: (
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ) => void;
};

const extensionPrefixes = [
  "chrome-extension://",
  "moz-extension://",
  "safari-extension://",
  "safari-web-extension://",
  "ms-browser-extension://",
  "extension://",
  "webkit-masked-url://",
  "user-script:",
];

const extensionMessages = [
  "Object Not Found Matching Id",
  "The message port closed before a response was received",
  "message channel closed before a response was received",
  "Could not establish connection. Receiving end does not exist",
  "Extension context invalidated",
  "Invalid call to runtime.sendMessage()",
  "No Listener: tabs:",
  "Can't find variable: EmptyRanges",
  'Policy with name "default" already exists',
  "The provider is disconnected from all chains",
  "Failed to connect to MetaMask",
];

const abortMessages = [
  "The play() request was interrupted",
  "play() failed because the user didn't interact",
  "The operation was aborted",
  "Fetch is aborted",
  "The user aborted a request",
  "AbortError",
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource",
];

const translationMessages = [
  "String contained an illegal UTF-16 sequence",
];

const translationKeywords = [
  "translate",
];

const scriptExtensions = [
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
];

const litDomMethods = [
  "nextSibling",
  "insertBefore",
  "removeChild",
  "parentNode",
  "firstChild",
  "setting 'data'",
];

const hasExtensionPrefix = (text: string): boolean =>
  extensionPrefixes.some((prefix) => text.includes(prefix));

const hasScriptExtension = (text: string): boolean =>
  scriptExtensions.some((ext) => text.includes(ext));

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

const extractStrings = (input: unknown): string[] => {
  if (typeof input === "string") return [input];
  if (!isRecord(input)) return [];
  const keys = [
    "message",
    "stack",
    "filename",
    "fileName",
    "sourceURL",
    "name",
  ];
  return keys
    .map((k) => input[k])
    .filter((v): v is string => typeof v === "string");
};

const extractEventStrings = (event: unknown): string[] =>
  isRecord(event)
    ? [...extractStrings(event.error), ...extractStrings(event)]
    : extractStrings(event);

export const isBrowserExtensionError = (reason: unknown): boolean =>
  extractStrings(reason).some(
    (str) =>
      hasExtensionPrefix(str) ||
      extensionMessages.some((msg) => str.includes(msg)),
  );

export const isExtensionHostObjectRejection = (reason: unknown): boolean =>
  isBrowserExtensionError(reason);

export const isMediaOrNetworkAbortError = (reason: unknown): boolean =>
  extractStrings(reason).some((str) =>
    abortMessages.some((msg) => str.includes(msg))
  );

export const isResizeObserverError = (reason: unknown): boolean =>
  extractStrings(reason).some((str) => str.includes("ResizeObserver"));

export const isNullRejection = (reason: unknown): boolean =>
  reason === null || reason === undefined;

const matchesNextSiblingNullStrings = (strings: string[]): boolean => {
  const combined = strings.join("\n");
  return (
    litDomMethods.some((method) => combined.includes(method)) &&
    (combined.includes("null") || combined.includes("undefined"))
  );
};

export const isNextSiblingNullError = (reason: unknown): boolean =>
  matchesNextSiblingNullStrings(extractEventStrings(reason));

const matchesTranslationStrings = (strings: string[]): boolean => {
  const combined = strings.join("\n");
  const isInlineInjectedCallStackOverflow =
    combined.includes("Maximum call stack size exceeded") &&
    (combined.includes("http://") || combined.includes("https://")) &&
    !hasScriptExtension(combined);
  return (
    isInlineInjectedCallStackOverflow ||
    strings.some(
      (str) =>
        translationMessages.some((msg) => str.includes(msg)) ||
        (translationKeywords.some((kw) => str.includes(kw)) &&
          (str.includes("encodeURIComponent") ||
            str.includes("URI malformed") ||
            str.includes("URIError"))),
    )
  );
};

export const isBrowserTranslationError = (reason: unknown): boolean =>
  matchesTranslationStrings(extractEventStrings(reason));

const constructorName = (obj: Record<string, unknown>): string =>
  typeof obj.constructor === "function" ? obj.constructor.name : "";

export const isEventRejection = (reason: unknown): boolean => {
  if (!isRecord(reason)) return false;
  if (typeof Event !== "undefined" && reason instanceof Event) return true;
  if (typeof DOMException !== "undefined" && reason instanceof DOMException) {
    return true;
  }
  const tag = Object.prototype.toString.call(reason);
  if (tag.endsWith("Event]") || tag === "[object DOMException]") return true;
  const name = constructorName(reason);
  if (name === "Event" || name.endsWith("Event") || name === "DOMException") {
    return true;
  }
  if (typeof reason.isTrusted === "boolean") return true;
  if (
    typeof reason.message === "string" && reason.message.includes("IDBDatabase")
  ) {
    return true;
  }
  return false;
};

export const isScriptError = (event: unknown): boolean =>
  isRecord(event) && event.message === "Script error." && !event.error;

export const isNextSiblingNullErrorEvent = (event: unknown): boolean =>
  isNextSiblingNullError(event);

export const isBrowserExtensionErrorEvent = (event: unknown): boolean =>
  isRecord(event) &&
  (isBrowserExtensionError(event.error) ||
    isBrowserExtensionError(event.filename) ||
    isBrowserExtensionError(event.message));

export const isResizeObserverErrorEvent = (event: unknown): boolean =>
  isRecord(event) &&
  (isResizeObserverError(event.error) || isResizeObserverError(event.message));

export const isMediaOrNetworkAbortErrorEvent = (event: unknown): boolean =>
  isRecord(event) &&
  (isMediaOrNetworkAbortError(event.error) ||
    isMediaOrNetworkAbortError(event.message));

export const isBrowserTranslationErrorEvent = (event: unknown): boolean =>
  isBrowserTranslationError(event);

export const isIgnoredRejection = (reason: unknown): boolean =>
  isNullRejection(reason) ||
  isEventRejection(reason) ||
  isBrowserExtensionError(reason) ||
  isResizeObserverError(reason) ||
  isNextSiblingNullError(reason) ||
  isMediaOrNetworkAbortError(reason) ||
  isBrowserTranslationError(reason);

export const isIgnoredErrorEvent = (event: unknown): boolean =>
  isScriptError(event) ||
  isBrowserExtensionErrorEvent(event) ||
  isResizeObserverErrorEvent(event) ||
  isNextSiblingNullErrorEvent(event) ||
  isMediaOrNetworkAbortErrorEvent(event) ||
  isBrowserTranslationErrorEvent(event);

const stopEvent = (event: SuppressibleEventLike): void => {
  if (typeof event.preventDefault === "function") event.preventDefault();
  if (typeof event.stopImmediatePropagation === "function") {
    event.stopImmediatePropagation();
  }
};

export const suppressClientErrorEvent = (event: unknown): boolean => {
  if (!isRecord(event) || !isIgnoredErrorEvent(event)) return false;
  stopEvent(event);
  return true;
};

export const suppressClientRejectionEvent = (event: unknown): boolean => {
  if (!isRecord(event) || !isIgnoredRejection(event.reason)) return false;
  stopEvent(event);
  return true;
};

export const suppressEventRejection = suppressClientRejectionEvent;
export const suppressScriptError = suppressClientErrorEvent;

export const installClientErrorSuppression = (
  target: EventTargetLike,
): void => {
  target.addEventListener(
    "error",
    (event) => {
      suppressClientErrorEvent(event);
    },
    true,
  );
  target.addEventListener(
    "unhandledrejection",
    (event) => {
      suppressClientRejectionEvent(event);
    },
    true,
  );
};

export const installEventRejectionSuppression = installClientErrorSuppression;

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
    globalThis.addEventListener(
      "error",
      (event: Event) => {
        if (suppressClientErrorEvent(event)) return;
        if (!(event instanceof ErrorEvent)) return;
        capture(uncaughtErrorEvent);
      },
      true,
    );
    globalThis.addEventListener(
      "unhandledrejection",
      (event: Event) => {
        if (suppressClientRejectionEvent(event)) return;
        capture(unhandledRejectionEvent);
      },
      true,
    );
  }
  return capture;
};
