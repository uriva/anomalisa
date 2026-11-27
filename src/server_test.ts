import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { httpHandler } from "./server.ts";

const requestMethod = (method: string) => (path: string) =>
  httpHandler(new Request(`https://anomalisa.uriv.me${path}`, { method }));

const head = requestMethod("HEAD");
const get = requestMethod("GET");

const applyEnvEntry = ([key, value]: [string, string | undefined]) =>
  value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);

const withEnv =
  (overrides: Record<string, string | undefined>) =>
  async (fn: () => Promise<void>) => {
    const previous = Object.keys(overrides).map(
      (key): [string, string | undefined] => [key, Deno.env.get(key)],
    );
    Object.entries(overrides).forEach(applyEnvEntry);
    try {
      await fn();
    } finally {
      previous.forEach(applyEnvEntry);
    }
  };

Deno.test("HEAD / returns 200 with empty body and text/html content-type", async () => {
  const res = await head("/");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  assertEquals(await res.text(), "");
});

Deno.test("HEAD /docs returns 200 with empty body and text/html content-type", async () => {
  const res = await head("/docs");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  assertEquals(await res.text(), "");
});

Deno.test("HEAD /robots.txt returns 200 with empty body and text/plain content-type", async () => {
  const res = await head("/robots.txt");
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/plain");
  assertEquals(await res.text(), "");
});

Deno.test("PUT / returns 405 Method Not Allowed", async () => {
  const res = await requestMethod("PUT")("/");
  assertEquals(res.status, 405);
  assertEquals(await res.text(), "");
});

Deno.test("web/app.html does not hardcode production InstantDB appId or endpoint", async () => {
  const html = await Deno.readTextFile(
    new URL("../web/app.html", import.meta.url),
  );
  assertFalse(html.includes("6c54827f-212d-4e48-9e87-b57626726004"));
  assertFalse(html.includes("api.instantdb.uriv.me"));
});

Deno.test("GET /app injects INSTANTDB_APP_ID and omits apiURI/websocketURI when unset", () =>
  withEnv({
    INSTANTDB_APP_ID: "self-hosted-app-id",
    INSTANTDB_API_URI: undefined,
    INSTANTDB_WEBSOCKET_URI: undefined,
  })(async () => {
    const res = await get("/app");
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, '{"appId":"self-hosted-app-id"}');
    assertFalse(html.includes("api.instantdb.uriv.me"));
    assertFalse(html.includes("6c54827f-212d-4e48-9e87-b57626726004"));
  }));

Deno.test("GET /app injects apiURI and derived websocketURI when INSTANTDB_API_URI is set", () =>
  withEnv({
    INSTANTDB_APP_ID: "prod-app-id",
    INSTANTDB_API_URI: "https://api.instantdb.uriv.me/",
    INSTANTDB_WEBSOCKET_URI: undefined,
  })(async () => {
    const res = await get("/app");
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, '"appId":"prod-app-id"');
    assertStringIncludes(html, '"apiURI":"https://api.instantdb.uriv.me"');
    assertStringIncludes(
      html,
      '"websocketURI":"wss://api.instantdb.uriv.me/runtime/session"',
    );
  }));

Deno.test("GET /app honors explicit INSTANTDB_WEBSOCKET_URI override", () =>
  withEnv({
    INSTANTDB_APP_ID: "custom-app-id",
    INSTANTDB_API_URI: "https://api.example.com",
    INSTANTDB_WEBSOCKET_URI: "wss://ws.example.com/custom",
  })(async () => {
    const res = await get("/app");
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, '"appId":"custom-app-id"');
    assertStringIncludes(html, '"apiURI":"https://api.example.com"');
    assertStringIncludes(html, '"websocketURI":"wss://ws.example.com/custom"');
  }));

Deno.test("GET /config reflects InstantDB env vars with optional custom URIs", () =>
  withEnv({
    INSTANTDB_APP_ID: "cfg-app-id",
    INSTANTDB_API_URI: "https://api.instantdb.uriv.me",
    INSTANTDB_WEBSOCKET_URI: undefined,
  })(async () => {
    const res = await get("/config");
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.instantdbAppId, "cfg-app-id");
    assertEquals(json.instantdbApiUri, "https://api.instantdb.uriv.me");
    assertEquals(
      json.instantdbWebsocketUri,
      "wss://api.instantdb.uriv.me/runtime/session",
    );
  }));
