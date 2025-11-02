import { apiHandler, type ApiImplementation } from "@uri/typed-api";
import { type Api, apiDefinition } from "./api.ts";

const endpoints: ApiImplementation<null, Api> = {
  authenticate: () => Promise.resolve(null),
  handlers: {
    sendEvent: (input) => {
      console.log(input);
      return Promise.resolve({});
    },
  },
};

const corsHeaders = {
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Origin": "*",
};

const httpHandler = async (req: Request) => {
  if (req.method === "GET") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const bodyText = await req.text(); // Read body once
  try {
    const json = JSON.parse(bodyText);
    try {
      return new Response(
        JSON.stringify(await apiHandler(apiDefinition, endpoints, json)),
        { headers: corsHeaders },
      );
    } catch (error) {
      console.error(error, json);
      console.log(
        "returning 500 for request with body:",
        bodyText,
        "and url:",
        req.url,
      );
      return new Response(null, { status: 500, headers: corsHeaders });
    }
  } catch (_) {
    console.log(
      "returning 400 for request with body:",
      bodyText,
      "and url:",
      req.url,
    );
    return new Response(null, { status: 400, headers: corsHeaders });
  }
};

Deno.serve(httpHandler);
