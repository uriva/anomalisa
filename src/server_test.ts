import { assertEquals, assertStringIncludes } from "@std/assert";
import { httpHandler } from "./server.ts";

const requestMethod = (method: string) => (path: string) =>
  httpHandler(new Request(`https://anomalisa.uriv.me${path}`, { method }));

const head = requestMethod("HEAD");

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
