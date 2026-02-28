import { endpoint } from "@uri/typed-api";
import { z } from "zod/v4";

export const apiDefinition = {
  sendEvent: endpoint({
    authRequired: false,
    input: z.object({
      token: z.string(),
      userId: z.string(),
      eventName: z.string(),
    }),
    output: z.object({}),
  }),
  getAnomalies: endpoint({
    authRequired: false,
    input: z.object({
      token: z.string(),
    }),
    output: z.object({
      anomalies: z.array(
        z.object({
          projectId: z.string(),
          eventName: z.string(),
          bucket: z.string(),
          expected: z.number(),
          actual: z.number(),
          zScore: z.number(),
          detectedAt: z.string(),
          metric: z.enum(["totalCount", "userSpike", "percentageSpike"]),
          userId: z.string().optional(),
        }),
      ),
    }),
  }),
  getEventCounts: endpoint({
    authRequired: false,
    input: z.object({
      token: z.string(),
    }),
    output: z.object({
      events: z.record(
        z.string(),
        z.array(z.object({ bucket: z.string(), count: z.number() })),
      ),
    }),
  }),
} as const;

export type Api = typeof apiDefinition;
