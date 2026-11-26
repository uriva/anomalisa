import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { httpHandler } from "../src/server.ts";

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
  assertStringIncludes(html, "npm i anomalisa");
  assertStringIncludes(html, "deno add npm:anomalisa");
  assertStringIncludes(html, "pnpm add anomalisa");
  assertStringIncludes(html, "bun add anomalisa");
  assertStringIncludes(html, "curl -X POST https://anomalisa.uriv.me");

  // SDK functions
  assertStringIncludes(html, "sendEvent");
  assertStringIncludes(html, "captureClientErrors");
});

Deno.test("web/index.html includes pricing section with generous free tier and active Pro upgrade", async () => {
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

  // Active Pro upgrade CTA
  assertStringIncludes(
    normalizedHtml,
    '<a href="/app?upgrade=pro" class="btn btn-primary pricing-btn">Upgrade to Pro</a>',
  );
  assertEquals(normalizedHtml.includes("Coming soon"), false);

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
  assertStringIncludes(html, 'href="https://www.npmjs.com/package/anomalisa"');
  assertStringIncludes(
    html,
    'href="https://uriv.me/blog/anomaly-detection-with-welford-and-kv"',
  );
});

Deno.test("web/index.html keeps green dot on logo and omits it on hero chip", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  assertStringIncludes(html, 'class="brand-dot"');
  assertEquals(html.includes("badge-status"), false);
  const chipMatch = html.match(
    /<div class="badge-pill">([\s\S]*?)<\/div>/,
  );
  assert(chipMatch, "Expected .badge-pill element");
  assertStringIncludes(
    chipMatch[1],
    "Zero-config statistical anomaly alerts via email",
  );
  assertEquals(chipMatch[1].includes("<div"), false);
});

Deno.test("web/index.html does not mention internal third-party services", async () => {
  const html = await Deno.readTextFile(
    new URL("./index.html", import.meta.url),
  );
  const normalized = html.toLowerCase();
  assertEquals(normalized.includes("forward email"), false);
  assertEquals(normalized.includes("forwardemail"), false);
  assertEquals(normalized.includes("turso"), false);
  assertEquals(normalized.includes("instantdb"), false);
  assertEquals(normalized.includes("deno deploy"), false);
});

Deno.test("GET /robots.txt returns text/plain with sitemap", async () => {
  const res = await httpHandler(
    new Request("https://anomalisa.uriv.me/robots.txt"),
  );
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/plain");
  assertEquals(
    (await res.text()).trim(),
    "User-agent: *\nAllow: /\nSitemap: https://anomalisa.uriv.me/sitemap.xml",
  );
});

Deno.test("GET /sitemap.xml returns application/xml with landing and docs URLs", async () => {
  const res = await httpHandler(
    new Request("https://anomalisa.uriv.me/sitemap.xml"),
  );
  assertEquals(res.status, 200);
  assertStringIncludes(
    res.headers.get("content-type") ?? "",
    "application/xml",
  );
  const body = await res.text();
  assertStringIncludes(body, "<loc>https://anomalisa.uriv.me/</loc>");
  assertStringIncludes(body, "<loc>https://anomalisa.uriv.me/docs</loc>");
});

Deno.test("web/docs.html documents captureClientErrors, curl JSON-RPC, and accurate thresholds in image alt", async () => {
  const html = await Deno.readTextFile(
    new URL("./docs.html", import.meta.url),
  );
  assertStringIncludes(html, "captureClientErrors");
  assertStringIncludes(html, "curl -X POST https://anomalisa.uriv.me");
  assertEquals(html.includes("2 sigma"), false);
  assertStringIncludes(html, "3σ/3.5σ and Poisson thresholds");
});

Deno.test("web/app.html only shows Welcome to Anomalisa Pro banner when plan is pro", async () => {
  const html = await Deno.readTextFile(
    new URL("./app.html", import.meta.url),
  );
  const syncBlock = html.match(
    /if \(syncRes\.ok\) \{[\s\S]*?Welcome to Anomalisa Pro!/,
  );
  assert(syncBlock, "Expected syncRes.ok block with Pro welcome banner");
  assertStringIncludes(syncBlock[0], 'billingStatus.plan === "pro"');
});
