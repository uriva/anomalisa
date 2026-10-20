import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const readWebFile = (name: string) =>
  Deno.readTextFile(new URL(`./${name}`, import.meta.url));

const readOgImage = () => Deno.readFile(new URL("./og.png", import.meta.url));

const metaContent = (html: string, property: string) => {
  const tag = html.match(
    new RegExp(
      `<meta[^>]*(?:property|name)="${property}"[^>]*content="([^"]*)"`,
    ),
  );
  assert(tag, `Missing meta tag for ${property}`);
  return tag[1];
};

const readUint32 = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    offset,
  );

const pageMetaCases = [
  {
    file: "index.html",
    title: "anomalisa: anomaly detection for your events",
    description:
      "Send events, get emailed when something weird happens. No dashboards to stare at. No thresholds to configure. Just math and email.",
    url: "https://anomalisa.uriva.deno.net/",
  },
  {
    file: "docs.html",
    title: "anomalisa - docs",
    description:
      "Install the anomalisa SDK, send events from your app, and get emailed when something looks wrong. API reference for sendEvent and getAnomalies, plus how detection works.",
    url: "https://anomalisa.uriva.deno.net/docs",
  },
];

for (const { file, title, description, url } of pageMetaCases) {
  Deno.test(`web/${file} exposes Open Graph and Twitter card metadata`, async () => {
    const html = await readWebFile(file);

    assertEquals(metaContent(html, "og:type"), "website");
    assertEquals(metaContent(html, "og:site_name"), "anomalisa");
    assertEquals(metaContent(html, "og:title"), title);
    assertEquals(metaContent(html, "og:description"), description);
    assertEquals(metaContent(html, "og:url"), url);

    assertEquals(metaContent(html, "twitter:card"), "summary_large_image");
    assertEquals(metaContent(html, "twitter:title"), title);
    assertEquals(metaContent(html, "twitter:description"), description);

    const imageUrl = metaContent(html, "og:image");
    assertEquals(imageUrl, "https://anomalisa.uriva.deno.net/og.png");
    assertEquals(metaContent(html, "og:image:type"), "image/png");
    assertEquals(metaContent(html, "og:image:width"), "1200");
    assertEquals(metaContent(html, "og:image:height"), "630");
    assert(metaContent(html, "og:image:alt").length > 0);
    assertEquals(metaContent(html, "twitter:image"), imageUrl);
    assertEquals(metaContent(html, "twitter:image:alt"), metaContent(html, "og:image:alt"));

    assertStringIncludes(html, `<link rel="canonical" href="${url}" />`);
  });
}

Deno.test("web/og.png is a 1200x630 PNG", async () => {
  const image = await readOgImage();
  assertEquals(
    Array.from(image.slice(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "web/og.png is not a PNG",
  );
  assertEquals(readUint32(image, 16), 1200);
  assertEquals(readUint32(image, 20), 630);
});
