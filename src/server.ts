import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";
import {
  type Anomaly,
  adaptBaseline,
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
  if (url.pathname === "/suppress") {
    const projectId = url.searchParams.get("projectId");
    const eventName = url.searchParams.get("eventName");
    const actualStr = url.searchParams.get("actual");
    if (!projectId || !eventName || !actualStr) {
      return htmlResponse("<h3>Missing parameters</h3>", 400);
    }
    const actual = parseFloat(actualStr);
    if (isNaN(actual)) {
      return htmlResponse("<h3>Invalid actual count</h3>", 400);
    }
    await adaptBaseline(projectId, eventName, actual);
    if (url.searchParams.get("json") === "true") {
      return jsonResponse({ success: true });
    }
    return htmlResponse(`
      <div style="font-family: system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; padding: 1rem;">
        <div style="background: #141414; border: 1px solid #222; border-radius: 12px; padding: 2.5rem; max-width: 480px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);">
          <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
          <h2 style="color: #fff; margin-bottom: 0.75rem;">Baseline Suppressed &amp; Adapted</h2>
          <p style="color: #aaa; line-height: 1.5; margin-bottom: 1.5rem;">The expected baseline for event <strong style="color: #7eb8ff;">"${eventName}"</strong> has been set to <strong>${actual}</strong> events/hour.</p>
          <p style="color: #666; font-size: 0.9rem;">Anomalisa will now consider this the new norm and will only alert you if the traffic significantly changes from this level.</p>
          <div style="margin-top: 2rem;">
            <a href="/app" style="color: #7eb8ff; text-decoration: none; font-weight: 500;">Go to Dashboard &rarr;</a>
          </div>
        </div>
      </div>
    `);
  }
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
