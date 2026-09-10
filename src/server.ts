import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";
import {
  type Anomaly,
  checkAllEmptyBuckets,
  cleanExpiredData,
  drainOutgoingAlerts,
  enqueueOutgoingAlerts,
  getAnomalies,
  getEventCounts,
  getMaxUserCounts,
  recordAdminNotificationOnce,
  recordEvent,
} from "./anomaly.ts";
import { lookupProjectById, lookupProjectByToken } from "./db.ts";
import { sendAdminNotification, sendAnomalyAlerts } from "./email.ts";
import {
  captureServerEvent,
  defaultPosthogHost,
  defaultPosthogKey,
} from "./analytics.ts";
import { initTursoSchema } from "./turso.ts";
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

      const isFirstEvent = await recordAdminNotificationOnce(
        `first_event:${project.id}`,
      ).catch(() => false);
      if (isFirstEvent) {
        sendAdminNotification({
          subject:
            `[Anomalisa] First event received: ${project.name} (${project.owner.email})`,
          html:
            `<p>Project <strong>${project.name}</strong> (${project.owner.email}) received its very first event: <code>${eventName}</code>.</p><p>Token: <code>${project.token}</code><br>User ID: <code>${
              userId ?? "none"
            }</code></p>`,
          text:
            `Project '${project.name}' (${project.owner.email}) received its very first event: '${eventName}'. Token: ${project.token}, User ID: ${
              userId ?? "none"
            }`,
        }).catch(logError("send first event admin notification"));

        captureServerEvent(project.owner.email, "first_event_received", {
          projectId: project.id,
          projectName: project.name,
          eventName,
          userId,
        });
      }

      const isNewUser = await recordAdminNotificationOnce(
        `signup:${project.owner.email.toLowerCase()}`,
      ).catch(() => false);
      if (isNewUser) {
        sendAdminNotification({
          subject: `[Anomalisa] New user signup: ${project.owner.email}`,
          html:
            `<p>New user active on Anomalisa: <strong>${project.owner.email}</strong>.</p>`,
          text: `New user active on Anomalisa: ${project.owner.email}.`,
        }).catch(logError("send signup admin notification"));

        captureServerEvent(project.owner.email, "user_signup", {
          email: project.owner.email,
        });
      }

      captureServerEvent(project.owner.email, "send_event", {
        projectId: project.id,
        projectName: project.name,
        eventName,
      });

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
const posthogKey = Deno.env.get("POSTHOG_API_KEY") ??
  Deno.env.get("POSTHOG_KEY") ??
  defaultPosthogKey;
const posthogHost = Deno.env.get("POSTHOG_HOST") ?? defaultPosthogHost;

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
  if (url.pathname === "/config") {
    return jsonResponse({
      instantdbAppId,
      posthogKey,
      posthogHost,
    });
  }
  const htmlByPath = await getHtmlByPath();
  const { landingHtml } = await getHtml();
  return htmlResponse(
    (htmlByPath as Record<string, string>)[url.pathname] ?? landingHtml,
  );
};

const handlePost = async (req: Request, url: URL) => {
  const bodyText = await req.text();

  if (url.pathname === "/notify-signup") {
    try {
      const { email } = JSON.parse(bodyText);
      if (typeof email === "string" && email.includes("@")) {
        const isNew = await recordAdminNotificationOnce(
          `signup:${email.toLowerCase()}`,
        ).catch(() => false);
        if (isNew) {
          sendAdminNotification({
            subject: `[Anomalisa] New user signup: ${email}`,
            html:
              `<p>New user signed up on Anomalisa: <strong>${email}</strong> at ${
                new Date().toISOString()
              }.</p>`,
            text: `New user signed up on Anomalisa: ${email} at ${
              new Date().toISOString()
            }.`,
          }).catch(logError("send signup admin notification"));

          captureServerEvent(email, "user_signup", { email });
        }
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "Invalid email" }, 400);
    } catch (_) {
      return jsonResponse({ error: "Invalid JSON" }, 400);
    }
  }

  try {
    const json = JSON.parse(bodyText);
    try {
      return new Response(
        JSON.stringify(await apiHandler(apiDefinition, endpoints, json)),
        { headers: corsHeaders },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ValidationError" || error.message === "Invalid token")
      ) {
        return jsonResponse({ error: error.message }, 400);
      }
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
  return handlePost(req, url);
};

initTursoSchema().catch(logError("init turso schema"));

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
        const maxUserCounts = await getMaxUserCounts(projectId).catch(() =>
          undefined
        );
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

Deno.cron("Clean expired data", "0 3 * * *", () => {
  cleanExpiredData().catch(logError("clean expired data"));
});
