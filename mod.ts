import { apiClient, httpCommunication } from "@uri/typed-api";
import { apiDefinition } from "./src/api.ts";
import type { Anomaly } from "./src/anomaly.ts";

const client = apiClient(
  httpCommunication("https://anomalisa.deno.dev"),
  apiDefinition,
);

type SendEventPayload = {
  token: string;
  userId: string;
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
