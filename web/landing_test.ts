import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("web/index.html has zero em dashes", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const emDashes = html.match(/[—–]/g);
  assertEquals(
    emDashes,
    null,
    "Found em dashes or en dashes in web/index.html",
  );
});

Deno.test("web/index.html contains core copy and value propositions", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const normalizedHtml = html.replace(/\s+/g, " ");

  // Brand and tagline
  assertStringIncludes(normalizedHtml, "anomalisa");
  assertStringIncludes(
    normalizedHtml,
    "Send events, get emailed when something weird happens. No dashboards to stare at. No thresholds to configure. Just statistics and email.",
  );
  assertStringIncludes(
    normalizedHtml,
    "You're shipping fast. Multiple projects, lots of moving parts.",
  );

  // Core features
  assertStringIncludes(normalizedHtml, "Event spike detection");
  assertStringIncludes(normalizedHtml, "Per-user anomalies");
  assertStringIncludes(normalizedHtml, "Zero configuration");
  assertStringIncludes(normalizedHtml, "Open source");

  // Detection modes
  assertStringIncludes(normalizedHtml, "totalCount");
  assertStringIncludes(normalizedHtml, "percentageSpike");
  assertStringIncludes(normalizedHtml, "userSpike");

  // Welford algorithm
  assertStringIncludes(normalizedHtml, "Welford's online algorithm");
  assertStringIncludes(
    normalizedHtml,
    "Three numbers in memory: count, mean, and sum of squared deviations",
  );

  // Honest reality
  assertStringIncludes(normalizedHtml, "The honest engineering reality");
  assertStringIncludes(
    normalizedHtml,
    "It won't catch everything. If your system fails in a way that doesn't affect event counts, you're on your own.",
  );
});

Deno.test("web/index.html contains developer quickstarts and SDK methods", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );

  // Package managers
  assertStringIncludes(html, "npx jsr add @uri/anomalisa");
  assertStringIncludes(html, "deno add jsr:@uri/anomalisa");
  assertStringIncludes(html, "pnpm dlx jsr add @uri/anomalisa");
  assertStringIncludes(html, "bunx jsr add @uri/anomalisa");
  assertStringIncludes(html, "curl -X POST https://anomalisa.uriva.deno.net");

  // SDK functions
  assertStringIncludes(html, "sendEvent");
  assertStringIncludes(html, "captureClientErrors");
});

Deno.test("web/index.html includes pricing section with generous free tier and disabled upgrade", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const normalizedHtml = html.replace(/\s+/g, " ");

  // Pricing header and tiers
  assertStringIncludes(normalizedHtml, 'id="pricing"');
  assertStringIncludes(normalizedHtml, "Simple, transparent pricing");
  assertStringIncludes(normalizedHtml, "100,000");
  assertStringIncludes(normalizedHtml, "1,000,000");
  assertStringIncludes(normalizedHtml, "Self-Hosted");

  // Upgrade button disabled
  assertStringIncludes(
    normalizedHtml,
    '<button class="btn btn-disabled pricing-btn" disabled>Coming soon</button>',
  );

  // 48px CTA touch targets
  assertStringIncludes(normalizedHtml, "height: 48px");
  assertStringIncludes(normalizedHtml, "min-height: 48px");
});

Deno.test("web/index.html includes all key outbound and navigation links", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );

  assertStringIncludes(html, 'href="/app"');
  assertStringIncludes(html, 'href="/docs"');
  assertStringIncludes(html, 'href="https://github.com/uriva/anomalisa"');
  assertStringIncludes(html, 'href="https://jsr.io/@uri/anomalisa"');
  assertStringIncludes(
    html,
    'href="https://uriv.me/blog/anomaly-detection-with-welford-and-kv"',
  );
});
