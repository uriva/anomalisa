import { apiClient, httpCommunication } from "@uri/typed-api";
import type { z } from "zod/v4";
import { apiDefinition } from "./src/api.ts";

const client = apiClient(
  httpCommunication("http://localhost:8080/api"),
  apiDefinition,
);

type sendEventPayload = z.infer<typeof apiDefinition["sendEvent"]["input"]>;

export const sendEvent = (payload: sendEventPayload) =>
  client({ endpoint: "sendEvent", payload });
