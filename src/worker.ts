import {
  checkEmptyBucketsCron,
  cleanExpiredDataCron,
  drainOutgoingAlertsCron,
  httpHandler,
} from "./server.ts";

const syncEnv = (env: Record<string, string>) => {
  Object.entries(env).forEach(([k, v]) => {
    if (typeof v === "string") {
      Deno.env.set(k, v);
    }
  });
};

type ExecutionContext = {
  waitUntil?: (promise: Promise<void>) => void;
};

type ScheduledController = {
  cron?: string;
};

const runScheduledJob = async (cron?: string): Promise<void> => {
  if (cron === "5 * * * *") {
    await checkEmptyBucketsCron();
    return;
  }
  if (cron === "*/5 * * * *") {
    await drainOutgoingAlertsCron();
    return;
  }
  if (cron === "0 3 * * *") {
    await cleanExpiredDataCron();
    return;
  }
  await drainOutgoingAlertsCron();
};

export const worker = {
  fetch: (
    req: Request,
    env: Record<string, string>,
    _ctx?: ExecutionContext,
  ) => {
    syncEnv(env);
    return httpHandler(req);
  },
  scheduled: async (
    controller: ScheduledController,
    env: Record<string, string>,
    ctx?: ExecutionContext,
  ) => {
    syncEnv(env);
    const job = runScheduledJob(controller?.cron);
    ctx?.waitUntil?.(job);
    await job;
  },
};

export default worker;
