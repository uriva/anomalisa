import { assertEquals } from "@std/assert";
import { ogImageResponse } from "./og.ts";

Deno.test("ogImageResponse serves the social card as a cacheable PNG", async () => {
  const response = await ogImageResponse();

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("content-type"), "image/png");
  assertEquals(response.headers.get("cache-control"), "public, max-age=86400");

  const bytes = new Uint8Array(await response.arrayBuffer());
  assertEquals(Array.from(bytes.slice(0, 8)), [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
});
