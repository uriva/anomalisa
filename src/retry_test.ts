import { assertEquals, assertRejects } from "@std/assert";
import { withRetry } from "./retry.ts";

Deno.test("withRetry passes through successful result", async () => {
  const fn = (x: string) => Promise.resolve(x);
  const wrapped = withRetry(2, 1, fn);
  assertEquals(await wrapped("success"), "success");
});

Deno.test("withRetry retries and succeeds", async () => {
  let attempts = 0;
  const fn = (x: string) => {
    attempts++;
    return attempts < 3
      ? Promise.reject(new Error("fail"))
      : Promise.resolve(x);
  };
  const wrapped = withRetry(2, 1, fn);
  assertEquals(await wrapped("success"), "success");
  assertEquals(attempts, 3);
});

Deno.test("withRetry fails after max retries", async () => {
  let attempts = 0;
  const fn = (x: string) => {
    attempts++;
    return Promise.reject(new Error("fail " + x));
  };
  const wrapped = withRetry(2, 1, fn);
  await assertRejects(() => wrapped("x"), Error, "fail x");
  assertEquals(attempts, 3);
});
