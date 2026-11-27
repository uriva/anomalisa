import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  instantConfigPlaceholder,
  renderAppHtml,
  resolveInstantAdminConfig,
  resolveInstantClientConfig,
} from "./db.ts";

Deno.test("resolveInstantAdminConfig omits apiURI when unset or blank", () => {
  const unset = resolveInstantAdminConfig({
    appId: "app-1",
    adminToken: "tok-1",
  });
  assertEquals(unset, { appId: "app-1", adminToken: "tok-1" });
  assertFalse("apiURI" in unset);

  const blank = resolveInstantAdminConfig({
    appId: "app-1",
    adminToken: "tok-1",
    apiUri: "   ",
  });
  assertEquals(blank, { appId: "app-1", adminToken: "tok-1" });
  assertFalse("apiURI" in blank);
});

Deno.test("resolveInstantAdminConfig trims and strips trailing slashes from apiURI", () => {
  assertEquals(
    resolveInstantAdminConfig({
      appId: " app-1 ",
      adminToken: " tok-1 ",
      apiUri: " https://api.instantdb.uriv.me/// ",
    }),
    {
      appId: "app-1",
      adminToken: "tok-1",
      apiURI: "https://api.instantdb.uriv.me",
    },
  );
});

Deno.test("resolveInstantClientConfig omits apiURI and websocketURI when unset", () => {
  const config = resolveInstantClientConfig({ appId: "app-cloud" });
  assertEquals(config, { appId: "app-cloud" });
  assertFalse("apiURI" in config);
  assertFalse("websocketURI" in config);
});

Deno.test("resolveInstantClientConfig derives wss websocketURI and strips trailing slashes", () => {
  assertEquals(
    resolveInstantClientConfig({
      appId: "app-self",
      apiUri: "https://api.instantdb.uriv.me/",
    }),
    {
      appId: "app-self",
      apiURI: "https://api.instantdb.uriv.me",
      websocketURI: "wss://api.instantdb.uriv.me/runtime/session",
    },
  );
});

Deno.test("resolveInstantClientConfig derives ws websocketURI for http apiURI", () => {
  assertEquals(
    resolveInstantClientConfig({
      appId: "app-local",
      apiUri: "http://localhost:8888/",
    }),
    {
      appId: "app-local",
      apiURI: "http://localhost:8888",
      websocketURI: "ws://localhost:8888/runtime/session",
    },
  );
});

Deno.test("resolveInstantClientConfig honors explicit websocketURI override", () => {
  assertEquals(
    resolveInstantClientConfig({
      appId: "app-custom",
      apiUri: "https://api.example.com",
      websocketUri: "wss://ws.example.com/custom/",
    }),
    {
      appId: "app-custom",
      apiURI: "https://api.example.com",
      websocketURI: "wss://ws.example.com/custom",
    },
  );
});

Deno.test("renderAppHtml injects config safely and escapes script tags", () => {
  const rendered = renderAppHtml(`init(${instantConfigPlaceholder});`, {
    appId: "id</script>$'$&",
    apiURI: "https://api.instantdb.uriv.me",
    websocketURI: "wss://api.instantdb.uriv.me/runtime/session",
  });
  assertFalse(rendered.includes("</script>"));
  assertStringIncludes(rendered, "\\u003c/script\\u003e$'$\\u0026");
  assertEquals(
    JSON.parse(rendered.slice("init(".length, -");".length)),
    {
      appId: "id</script>$'$&",
      apiURI: "https://api.instantdb.uriv.me",
      websocketURI: "wss://api.instantdb.uriv.me/runtime/session",
    },
  );
});
