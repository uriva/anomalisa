import { endpoint } from "@uri/typed-api";
import { z } from "zod/v4";

export const apiDefinition = {
  sendEvent: endpoint({
    authRequired: false,
    input: z.object({
      projectId: z.string(),
      userId: z.string(),
      eventName: z.string(),
      properties: z.object(),
    }),
    output: z.object({}),
  }),
} as const;

export type Api = typeof apiDefinition;
