import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";
import {
  type Anomaly,
  checkAllEmptyBuckets,
  drainOutgoingAlerts,
  enqueueOutgoingAlerts,
  getAnomalies,
  getEventCounts,
  getMaxUserCounts,
  recordEvent,
} from "./anomaly.ts";
import { lookupProjectById, lookupProjectByToken } from "./db.ts";
import { sendAnomalyAlerts } from "./email.ts";
import { sendWebhook } from "./webhook.ts";

const resolveProject = async (token: string) => {
  const project = await lookupProjectByToken(token);
  if (!project) throw new Error("Invalid token");
  return project;
};

const logError = (label: string) => (err: unknown) =>
  console.error(`Failed to ${label}:`, err);

const maxAlertAgeMs = 24 * 60 * 60 * 1000;

const notifyAnomalies = (
  projectId: string,
  anomalies: Anomaly[],
) => {
  const now = Date.now();
  const freshAnomalies = anomalies.filter((a) => {
    try {
      const bucketMs = new Date(a.bucket + ":00:00Z").getTime();
      return now - bucketMs < maxAlertAgeMs;
    } catch {
      return true;
    }
  });
  if (freshAnomalies.length === 0) return;
  enqueueOutgoingAlerts(projectId, freshAnomalies).catch(
    logError("enqueue outgoing alerts"),
  );
};

const endpoints: ApiImplementation<null, Api> = {
  authenticate: () => Promise.resolve(null),
  handlers: {
    sendEvent: async ({ token, eventName, userId }) => {
      const project = await resolveProject(token);
      const anomalies = await recordEvent(
        project.id,
        eventName,
        userId ?? undefined,
      );
      notifyAnomalies(project.id, anomalies);
      return {};
    },
    getAnomalies: async ({ token }) => {
      const project = await resolveProject(token);
      return { anomalies: await getAnomalies(project.id) };
    },
    getEventCounts: async ({ token }) => {
      const project = await resolveProject(token);
      return { events: await getEventCounts(project.id) };
    },
  },
};

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const instantdbAppId = Deno.env.get("INSTANTDB_APP_ID") ?? "";

const readWebFile = (name: string) =>
  Deno.readTextFile(new URL(`../web/${name}`, import.meta.url));

let _htmlCachePromise:
  | Promise<
    { landingHtml: string; appHtml: string; docsHtml: string }
  >
  | null = null;
const getHtml = () =>
  _htmlCachePromise ??= Promise.all(
    ["index.html", "app.html", "docs.html"].map(readWebFile),
  ).then(([landingHtml, appHtml, docsHtml]) => ({
    landingHtml,
    appHtml,
    docsHtml,
  }));

const jsonResponse = (data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { ...corsHeaders, "Content-Type": "text/html" },
  });

const getHtmlByPath = async () => {
  const { landingHtml, appHtml, docsHtml } = await getHtml();
  return {
    "/": landingHtml,
    "/app": appHtml,
    "/docs": docsHtml,
  };
};

const handleGet = async (url: URL) => {
  if (url.pathname === "/config") return jsonResponse({ instantdbAppId });
  const htmlByPath = await getHtmlByPath();
  const { landingHtml } = await getHtml();
  return htmlResponse(
    (htmlByPath as Record<string, string>)[url.pathname] ?? landingHtml,
  );
};

const handlePost = async (req: Request) => {
  const bodyText = await req.text();
  try {
    const json = JSON.parse(bodyText);
    try {
      return new Response(
        JSON.stringify(await apiHandler(apiDefinition, endpoints, json)),
        { headers: corsHeaders },
      );
    } catch (error) {
      console.error(error, json);
      return new Response(null, { status: 500, headers: corsHeaders });
    }
  } catch (_) {
    return new Response(null, { status: 400, headers: corsHeaders });
  }
};

const httpHandler = async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === "GET") return await handleGet(url);
  return handlePost(req);
};

Deno.serve(httpHandler);
console.log("server.ts executing...");

Deno.cron("Check empty buckets", "5 * * * *", async () => {
  const anomaliesByProject = await checkAllEmptyBuckets();
  for (const [projectId, anomalies] of Object.entries(anomaliesByProject)) {
    notifyAnomalies(projectId, anomalies);
  }
});

Deno.cron("Drain outgoing alerts", "*/5 * * * *", async () => {
  const byProject = await drainOutgoingAlerts();
  for (const [projectId, anomalies] of Object.entries(byProject)) {
    try {
      const project = await lookupProjectById(projectId);
      if (project) {
        const counts = await getEventCounts(projectId).catch(() => undefined);
        const maxUserCounts = await getMaxUserCounts(projectId).catch(() => undefined);
        sendAnomalyAlerts(
          project.owner.email,
          project.name,
          anomalies,
          counts,
          maxUserCounts,
        ).catch(logError("send anomaly email"));
        if (project.webhookUrl) {
          const webhookUrl = project.webhookUrl;
          anomalies.forEach((a) =>
            sendWebhook(webhookUrl, a).catch(logError("send webhook"))
          );
        }
      }
    } catch (e) {
      console.error(`Failed to drain alerts for ${projectId}:`, e);
    }
  }
});
