import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";
import { type Anomaly, getAnomalies, getEventCounts, recordEvent } from "./anomaly.ts";
import { lookupProjectByToken } from "./db.ts";
import { sendAnomalyAlert } from "./email.ts";
import { sendWebhook } from "./webhook.ts";

const resolveProject = async (token: string) => {
  const project = await lookupProjectByToken(token);
  if (!project) throw new Error("Invalid token");
  return project;
};

const logError = (label: string) => (err: unknown) =>
  console.error(`Failed to ${label}:`, err);

const notifyAnomaly = (
  email: string,
  webhookUrl: string | undefined,
  anomaly: Anomaly,
) => {
  sendAnomalyAlert(email, anomaly).catch(logError("send anomaly email"));
  if (webhookUrl) sendWebhook(webhookUrl, anomaly).catch(logError("send webhook"));
};

const endpoints: ApiImplementation<null, Api> = {
  authenticate: () => Promise.resolve(null),
  handlers: {
    sendEvent: async ({ token, eventName, userId }) => {
      const project = await resolveProject(token);
      const anomalies = await recordEvent(project.id, eventName, userId);
      anomalies.forEach((anomaly) =>
        notifyAnomaly(project.owner.email, project.webhookUrl, anomaly)
      );
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

const [landingHtml, appHtml, docsHtml] = await Promise.all(
  ["index.html", "app.html", "docs.html"].map(readWebFile),
);

const jsonResponse = (data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const htmlResponse = (html: string) =>
  new Response(html, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/html" },
  });

const htmlByPath: Record<string, string> = {
  "/": landingHtml,
  "/app": appHtml,
  "/docs": docsHtml,
};

const handleGet = (url: URL) =>
  url.pathname === "/config"
    ? jsonResponse({ instantdbAppId })
    : htmlResponse(htmlByPath[url.pathname] ?? landingHtml);

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

const httpHandler = (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === "GET") return handleGet(url);
  return handlePost(req);
};

Deno.serve(httpHandler);
