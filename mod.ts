import { apiClient, httpCommunication } from "@uri/typed-api";
import { apiDefinition } from "./src/api.ts";

const client = apiClient(
  httpCommunication("https://anomalisa.deno.dev"),
  apiDefinition,
);

type sendEventPayload = {
  projectId: string;
  userId: string;
  eventName: string;
  // deno-lint-ignore no-explicit-any
  properties: Record<string, any>;
};

export const sendEvent: (
  payload: sendEventPayload,
) => Promise<Record<string, never>> = (payload: sendEventPayload) =>
  client({ endpoint: "sendEvent", payload });
