import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";
import { getAnomalies, recordEvent } from "./anomaly.ts";
import { lookupProjectByToken } from "./db.ts";
import { sendAnomalyAlert } from "./email.ts";

const resolveProject = async (token: string) => {
  const project = await lookupProjectByToken(token);
  if (!project) throw new Error("Invalid token");
  return project;
};

const endpoints: ApiImplementation<null, Api> = {
  authenticate: () => Promise.resolve(null),
  handlers: {
    sendEvent: async ({ token, eventName, userId }) => {
      const project = await resolveProject(token);
      const anomalies = await recordEvent(project.id, eventName, userId);
      anomalies.forEach((anomaly) =>
        sendAnomalyAlert(project.owner.email, anomaly).catch((err) =>
          console.error("Failed to send anomaly alert:", err)
        )
      );
      return {};
    },
    getAnomalies: async ({ token }) => {
      const project = await resolveProject(token);
      return { anomalies: await getAnomalies(project.id) };
    },
  },
};

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const instantdbAppId = Deno.env.get("INSTANTDB_APP_ID") ?? "";

const webAppHtml = await Deno.readTextFile(
  new URL("../web/index.html", import.meta.url),
);

const jsonResponse = (data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const handleGet = (url: URL) => {
  if (url.pathname === "/config") {
    return jsonResponse({ instantdbAppId });
  }
  return new Response(webAppHtml, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/html" },
  });
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

const httpHandler = (req: Request) => {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method === "GET") return handleGet(url);
  return handlePost(req);
};

Deno.serve(httpHandler);
