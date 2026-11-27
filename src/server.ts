import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { isBotUserAgent } from "../mod.ts";
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
import { lookupProjectById, lookupProjectByToken, verifyUserToken } from "./db.ts";
import {
  sendAdminNotification,
  sendAnomalyAlerts,
  sendQuotaNotification,
  sendTestAnomalyAlert,
} from "./email.ts";
import { handleTestAnomalyRequest } from "./testAnomaly.ts";
import {
  createBillingPortalSession,
  createCheckoutSession,
  extractBearerToken,
  getBillingStatus,
  getProjectAlertSettings,
  handleProjectSettingsRequest,
  handleStripeWebhook,
  incrementAndCheckMonthlyQuota,
  makeQuotaExceededError,
  quotaExceededErrorName,
  resolveEffectivePlan,
  syncCheckoutSession,
} from "./billing.ts";
import {
  captureServerEvent,
  defaultPosthogHost,
  defaultPosthogKey,
} from "./analytics.ts";
import { initTursoSchema } from "./turso.ts";
import { sendWebhook } from "./webhook.ts";
import { handleFeedback } from "./feedback.ts";
import { handleProjectGithubRequest } from "./github.ts";
import {
  handleInvestigate,
  handleInvestigatePost,
  type InvestigateResponse,
} from "./investigate.ts";
import { ogImageResponse } from "./og.ts";

const resolveProject = async (token: string) => {
  const project = await lookupProjectByToken(token);
  if (!project) throw new Error("Invalid token");
  return project;
};

const lookupProjectName = (projectId: string) =>
  lookupProjectById(projectId)
    .then((project) => project?.name ?? "")
    .catch(() => "");

const logError = (label: string) => (err: unknown) =>
  console.error(`Failed to ${label}:`, err);

const maxAlertAgeMs = 24 * 60 * 60 * 1000;

const notifyAnomalies = async (
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
  await enqueueOutgoingAlerts(projectId, freshAnomalies).catch(
    logError("enqueue outgoing alerts"),
  );
};

const endpoints: ApiImplementation<null, Api> = {
  authenticate: () => Promise.resolve(null),
  handlers: {
    sendEvent: async ({ token, eventName, userId }) => {
      const project = await resolveProject(token);
      const quota = await incrementAndCheckMonthlyQuota(
        project.owner.id,
        project.owner.email,
      );
      if (!quota.allowed) {
        const shouldNotifyQuota = await recordAdminNotificationOnce(
          `quota_exceeded:${project.owner.id}:${quota.monthBucket}`,
        ).catch(() => false);
        if (shouldNotifyQuota) {
          await sendQuotaNotification({
            to: project.owner.email,
            plan: quota.plan,
            limit: quota.limit,
            reached: true,
          }).catch(logError("send quota exceeded email"));
        }
        throw makeQuotaExceededError(quota.plan, quota.limit);
      }
      if (quota.count === Math.floor(quota.limit * 0.8)) {
        const shouldWarnQuota = await recordAdminNotificationOnce(
          `quota_warning_80:${project.owner.id}:${quota.monthBucket}`,
        ).catch(() => false);
        if (shouldWarnQuota) {
          await sendQuotaNotification({
            to: project.owner.email,
            plan: quota.plan,
            limit: quota.limit,
            reached: false,
          }).catch(logError("send quota warning email"));
        }
      }
      const anomalies = await recordEvent(
        project.id,
        eventName,
        userId ?? undefined,
      );
      await notifyAnomalies(project.id, anomalies);

      const isFirstEvent = await recordAdminNotificationOnce(
        `first_event:${project.id}`,
      ).catch(() => false);
      if (isFirstEvent) {
        await Promise.all([
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
          }).catch(logError("send first event admin notification")),
          captureServerEvent(project.owner.email, "first_event_received", {
            projectId: project.id,
            projectName: project.name,
            eventName,
            userId,
          }),
        ]);
      }

      const isNewUser = await recordAdminNotificationOnce(
        `signup:${project.owner.email.toLowerCase()}`,
      ).catch(() => false);
      if (isNewUser) {
        await Promise.all([
          sendAdminNotification({
            subject: `[Anomalisa] New user signup: ${project.owner.email}`,
            html:
              `<p>New user active on Anomalisa: <strong>${project.owner.email}</strong>.</p>`,
            text: `New user active on Anomalisa: ${project.owner.email}.`,
          }).catch(logError("send signup admin notification")),
          captureServerEvent(project.owner.email, "user_signup", {
            email: project.owner.email,
          }),
        ]);
      }

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
    sendTestAnomaly: async ({ token }) => {
      const project = await resolveProject(token);
      await sendTestAnomalyAlert(project.owner.email, project.name, project.id);
      return { ok: true, sentTo: project.owner.email };
    },
  },
};

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const readWebFile = (name: string) =>
  Deno.readTextFile(
    import.meta.url
      ? new URL(`../web/${name}`, import.meta.url)
      : `../web/${name}`,
  );

let _htmlCachePromise:
  | Promise<
    {
      landingHtml: string;
      appHtml: string;
      docsHtml: string;
      privacyHtml: string;
      termsHtml: string;
    }
  >
  | null = null;
const getHtml = () =>
  _htmlCachePromise ??= Promise.all(
    ["index.html", "app.html", "docs.html", "privacy.html", "terms.html"].map(
      readWebFile,
    ),
  ).then(([landingHtml, appHtml, docsHtml, privacyHtml, termsHtml]) => ({
    landingHtml,
    appHtml,
    docsHtml,
    privacyHtml,
    termsHtml,
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

const investigateHttpResponse = (res: InvestigateResponse) =>
  res.kind === "redirect"
    ? new Response(null, {
      status: 303,
      headers: { ...corsHeaders, Location: res.location },
    })
    : htmlResponse(res.html, res.status);

const getHtmlByPath = async () => {
  const { landingHtml, appHtml, docsHtml, privacyHtml, termsHtml } =
    await getHtml();
  return {
    "/": landingHtml,
    "/app": appHtml,
    "/docs": docsHtml,
    "/privacy": privacyHtml,
    "/terms": termsHtml,
  };
};

const authenticateRequest = (req: Request) =>
  verifyUserToken(extractBearerToken(req));

const handleBillingGet = async (req: Request) => {
  const user = await authenticateRequest(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
  return jsonResponse(await getBillingStatus(user.id, user.email));
};

const handleBillingPost = async (
  req: Request,
  url: URL,
  bodyText: string,
) => {
  const user = await authenticateRequest(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);
  try {
    if (url.pathname === "/api/billing/checkout") {
      return jsonResponse(
        await createCheckoutSession({
          userId: user.id,
          email: user.email,
          origin: url.origin,
        }),
      );
    }
    if (url.pathname === "/api/billing/portal") {
      return jsonResponse(
        await createBillingPortalSession({
          userId: user.id,
          origin: url.origin,
        }),
      );
    }
    if (url.pathname === "/api/billing/sync") {
      const parsed = JSON.parse(bodyText || "{}");
      const sessionId = typeof parsed?.sessionId === "string"
        ? parsed.sessionId.trim()
        : "";
      if (!sessionId) return jsonResponse({ error: "Missing sessionId" }, 400);
      return jsonResponse(
        await syncCheckoutSession({
          userId: user.id,
          email: user.email,
          sessionId,
        }),
      );
    }
    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Billing error";
    return jsonResponse({ error: message }, 400);
  }
};

const robotsTxt = [
  "User-agent: *",
  "Allow: /",
  "Sitemap: https://anomalisa.uriv.me/sitemap.xml",
].join("\n");

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://anomalisa.uriv.me/</loc>
  </url>
  <url>
    <loc>https://anomalisa.uriv.me/docs</loc>
  </url>
</urlset>`;

const textResponse = (body: string, contentType: string, status = 200) =>
  new Response(body, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType },
  });

const handleGet = async (req: Request, url: URL) => {
  if (url.pathname === "/og.png") return await ogImageResponse();
  if (url.pathname === "/robots.txt") {
    return textResponse(robotsTxt, "text/plain");
  }
  if (url.pathname === "/sitemap.xml") {
    return textResponse(sitemapXml, "application/xml");
  }
  if (url.pathname === "/api/billing/status") return handleBillingGet(req);
  if (url.pathname === "/config") {
    return jsonResponse({
      instantdbAppId: Deno.env.get("INSTANTDB_APP_ID") ?? "",
      posthogKey: Deno.env.get("POSTHOG_API_KEY") ??
        Deno.env.get("POSTHOG_KEY") ??
        defaultPosthogKey,
      posthogHost: Deno.env.get("POSTHOG_HOST") ?? defaultPosthogHost,
    });
  }
  if (url.pathname === "/feedback") {
    const { html, status } = await handleFeedback(
      url,
      (projectId, eventName, bucket, vote) => {
        captureServerEvent(projectId, "alert_feedback", {
          projectId,
          eventName,
          bucket,
          rating: vote,
        });
      },
    );
    return htmlResponse(html, status);
  }
  if (url.pathname === "/investigate") {
    return investigateHttpResponse(
      await handleInvestigate(url, lookupProjectName),
    );
  }
  const htmlByPath = await getHtmlByPath();
  const { landingHtml } = await getHtml();
  return htmlResponse(
    (htmlByPath as Record<string, string>)[url.pathname] ?? landingHtml,
  );
};

const handlePost = async (req: Request, url: URL) => {
  const bodyText = await req.text();

  if (url.pathname === "/api/stripe/webhook") {
    const { status, body } = await handleStripeWebhook(
      bodyText,
      req.headers.get("stripe-signature"),
    );
    return jsonResponse(body, status);
  }

  if (
    url.pathname === "/api/billing/checkout" ||
    url.pathname === "/api/billing/portal" ||
    url.pathname === "/api/billing/sync"
  ) {
    return handleBillingPost(req, url, bodyText);
  }

  if (url.pathname === "/project-settings") {
    const { status, body } = await handleProjectSettingsRequest(
      bodyText,
      resolveProject,
    );
    return jsonResponse(body, status);
  }

  if (url.pathname === "/investigate") {
    return investigateHttpResponse(
      await handleInvestigatePost(bodyText, lookupProjectName),
    );
  }

  if (url.pathname === "/project-github") {
    const { status, body } = await handleProjectGithubRequest(
      bodyText,
      resolveProject,
    );
    return jsonResponse(body, status);
  }

  if (url.pathname === "/api/test-anomaly") {
    const { status, body } = await handleTestAnomalyRequest(
      bodyText,
      lookupProjectByToken,
    );
    return jsonResponse(body, status);
  }

  if (url.pathname === "/notify-signup") {
    try {
      const { email } = JSON.parse(bodyText);
      if (typeof email === "string" && email.includes("@")) {
        const isNew = await recordAdminNotificationOnce(
          `signup:${email.toLowerCase()}`,
        ).catch(() => false);
        if (isNew) {
          await Promise.all([
            sendAdminNotification({
              subject: `[Anomalisa] New user signup: ${email}`,
              html:
                `<p>New user signed up on Anomalisa: <strong>${email}</strong> at ${
                  new Date().toISOString()
                }.</p>`,
              text: `New user signed up on Anomalisa: ${email} at ${
                new Date().toISOString()
              }.`,
            }).catch(logError("send signup admin notification")),
            captureServerEvent(email, "user_signup", { email }),
          ]);
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
    if (
      json?.endpoint === "sendEvent" &&
      isBotUserAgent(req.headers.get("user-agent") ?? "")
    ) {
      return new Response(JSON.stringify({}), { headers: corsHeaders });
    }
    try {
      return new Response(
        JSON.stringify(await apiHandler(apiDefinition, endpoints, json)),
        { headers: corsHeaders },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === quotaExceededErrorName
      ) {
        return jsonResponse({ error: error.message }, 429);
      }
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

const handleHead = async (req: Request, url: URL) => {
  const { status, headers } = await handleGet(req, url);
  return new Response(null, { status, headers });
};

export const httpHandler = async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === "GET") return await handleGet(req, url);
  if (req.method === "HEAD") return await handleHead(req, url);
  if (req.method === "POST") return await handlePost(req, url);
  return new Response(null, { status: 405, headers: corsHeaders });
};

export const checkEmptyBucketsCron = async () => {
  const anomaliesByProject = await checkAllEmptyBuckets();
  for (const [projectId, anomalies] of Object.entries(anomaliesByProject)) {
    await notifyAnomalies(projectId, anomalies);
  }
};

export const drainOutgoingAlertsCron = async () => {
  const byProject = await drainOutgoingAlerts();
  for (const [projectId, anomalies] of Object.entries(byProject)) {
    try {
      const project = await lookupProjectById(projectId);
      if (project) {
        const [counts, maxUserCounts, plan] = await Promise.all([
          getEventCounts(projectId).catch(() => undefined),
          getMaxUserCounts(projectId).catch(() => undefined),
          resolveEffectivePlan(project.owner.id, project.owner.email).catch(
            () => "free" as const,
          ),
        ]);
        const isPro = plan === "pro";
        const alertSettings = isPro
          ? await getProjectAlertSettings(projectId).catch(() => ({
            alertEmails: [],
            webhookSecret: "",
          }))
          : { alertEmails: [], webhookSecret: "" };
        await sendAnomalyAlerts(
          project.owner.email,
          project.name,
          anomalies,
          counts,
          maxUserCounts,
          {
            extraEmails: alertSettings.alertEmails,
            enableAutoGithubIssues: isPro,
          },
        ).catch(logError("send anomaly email"));
        if (project.webhookUrl) {
          const webhookUrl = project.webhookUrl;
          const webhookOptions = isPro && alertSettings.webhookSecret
            ? { secret: alertSettings.webhookSecret }
            : undefined;
          await Promise.all(
            anomalies.map((a) =>
              sendWebhook(webhookUrl, a, webhookOptions).catch(
                logError("send webhook"),
              )
            ),
          );
        }
      }
    } catch (e) {
      console.error(`Failed to drain alerts for ${projectId}:`, e);
    }
  }
};

export const cleanExpiredDataCron = () =>
  cleanExpiredData().catch(logError("clean expired data"));

if (import.meta.main) {
  initTursoSchema().catch(logError("init turso schema"));
  Deno.serve(httpHandler);
  console.log("server.ts executing...");
}
