import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("web/index.html includes PostHog script with exception capture", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assertStringIncludes(html, "posthog");
  assertStringIncludes(
    html,
    "phc_rjtFQTqewBSkcMXu7VwMPjzojSSLdxygumxwrxDcZVaU",
  );
  assertStringIncludes(html, "capture_exceptions: true");
  assertStringIncludes(html, "upgrade_clicked");
});

Deno.test("web/app.html includes PostHog with user identification and client error capture", async () => {
  const html = await Deno.readTextFile(
    new URL("./app.html", import.meta.url),
  );
  assertStringIncludes(html, "posthog");
  assertStringIncludes(
    html,
    "phc_rjtFQTqewBSkcMXu7VwMPjzojSSLdxygumxwrxDcZVaU",
  );
  assertStringIncludes(html, "capture_exceptions: true");
  assertStringIncludes(html, "posthog.identify");
  assertStringIncludes(html, "posthog.reset");
  assertStringIncludes(html, "app_authenticated");
  assertStringIncludes(html, "test_anomaly_clicked");
  assertStringIncludes(html, "upgrade_clicked");
});

Deno.test("web/docs.html includes PostHog script with exception capture", async () => {
  const html = await Deno.readTextFile(
    new URL("./docs.html", import.meta.url),
  );
  assertStringIncludes(html, "posthog");
  assertStringIncludes(
    html,
    "phc_rjtFQTqewBSkcMXu7VwMPjzojSSLdxygumxwrxDcZVaU",
  );
  assertStringIncludes(html, "capture_exceptions: true");
});
