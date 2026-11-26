import { assertEquals } from "@std/assert";
import {
  buildRetentionBatch,
  retentionCutoffsForPlan,
  retentionDaysForPlan,
} from "./retention.ts";

const dayMs = 24 * 60 * 60 * 1000;
const fixedNowMs = Date.UTC(2026, 10, 26, 3, 0, 0);

Deno.test("retentionDaysForPlan returns 7d counts and 30d anomalies for free plan", () => {
  assertEquals(retentionDaysForPlan("free"), {
    countsDays: 7,
    anomaliesDays: 30,
  });
});

Deno.test("retentionDaysForPlan returns 30d counts and 90d anomalies for pro plan", () => {
  assertEquals(retentionDaysForPlan("pro"), {
    countsDays: 30,
    anomaliesDays: 90,
  });
});

Deno.test("retentionCutoffsForPlan computes millisecond cutoffs for free and pro plans", () => {
  assertEquals(retentionCutoffsForPlan("free", fixedNowMs), {
    countsCutoffMs: fixedNowMs - 7 * dayMs,
    anomaliesCutoffMs: fixedNowMs - 30 * dayMs,
  });
  assertEquals(retentionCutoffsForPlan("pro", fixedNowMs), {
    countsCutoffMs: fixedNowMs - 30 * dayMs,
    anomaliesCutoffMs: fixedNowMs - 90 * dayMs,
  });
});

Deno.test("buildRetentionBatch generates per-plan project deletes and global ttl deletes", () => {
  const statements = buildRetentionBatch(fixedNowMs)([
    { projectId: "proj_free", plan: "free" },
    { projectId: "proj_pro", plan: "pro" },
  ]);
  assertEquals(statements, [
    {
      sql: "DELETE FROM counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_free", fixedNowMs - 7 * dayMs],
    },
    {
      sql: "DELETE FROM user_counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_free", fixedNowMs - 7 * dayMs],
    },
    {
      sql:
        "DELETE FROM max_user_counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_free", fixedNowMs - 7 * dayMs],
    },
    {
      sql: "DELETE FROM anomalies WHERE project_id = ? AND created_at < ?;",
      args: ["proj_free", fixedNowMs - 30 * dayMs],
    },
    {
      sql: "DELETE FROM counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_pro", fixedNowMs - 30 * dayMs],
    },
    {
      sql: "DELETE FROM user_counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_pro", fixedNowMs - 30 * dayMs],
    },
    {
      sql:
        "DELETE FROM max_user_counts WHERE project_id = ? AND created_at < ?;",
      args: ["proj_pro", fixedNowMs - 30 * dayMs],
    },
    {
      sql: "DELETE FROM anomalies WHERE project_id = ? AND created_at < ?;",
      args: ["proj_pro", fixedNowMs - 90 * dayMs],
    },
    {
      sql: "DELETE FROM cooldowns WHERE expires_at < ?;",
      args: [fixedNowMs],
    },
    {
      sql: "DELETE FROM email_rate_limits WHERE expires_at < ?;",
      args: [fixedNowMs],
    },
  ]);
});

Deno.test("buildRetentionBatch still emits global deletes when no projects have expired rows", () => {
  assertEquals(buildRetentionBatch(fixedNowMs)([]), [
    {
      sql: "DELETE FROM cooldowns WHERE expires_at < ?;",
      args: [fixedNowMs],
    },
    {
      sql: "DELETE FROM email_rate_limits WHERE expires_at < ?;",
      args: [fixedNowMs],
    },
  ]);
});
