import { map, pipe } from "gamla";
import type { Plan } from "./billing.ts";

export type RetentionDays = {
  countsDays: number;
  anomaliesDays: number;
};

export type RetentionCutoffs = {
  countsCutoffMs: number;
  anomaliesCutoffMs: number;
};

export type ProjectRetention = {
  projectId: string;
  plan: Plan;
};

export type SqlStatement = {
  sql: string;
  args: Array<string | number>;
};

const msPerDay = 24 * 60 * 60 * 1000;

const planRetentionDays: Record<Plan, RetentionDays> = {
  free: { countsDays: 7, anomaliesDays: 30 },
  pro: { countsDays: 30, anomaliesDays: 90 },
};

const countTables: string[] = ["counts", "user_counts", "max_user_counts"];

export const retentionDaysForPlan = (plan: Plan): RetentionDays =>
  planRetentionDays[plan];

const toCutoffs =
  (nowMs: number) =>
  ({ countsDays, anomaliesDays }: RetentionDays): RetentionCutoffs => ({
    countsCutoffMs: nowMs - countsDays * msPerDay,
    anomaliesCutoffMs: nowMs - anomaliesDays * msPerDay,
  });

export const retentionCutoffsForPlan = (
  plan: Plan,
  nowMs: number,
): RetentionCutoffs => pipe(retentionDaysForPlan, toCutoffs(nowMs))(plan);

const deleteProjectTableBefore =
  (projectId: string, cutoffMs: number) => (table: string): SqlStatement => ({
    sql: `DELETE FROM ${table} WHERE project_id = ? AND created_at < ?;`,
    args: [projectId, cutoffMs],
  });

const projectRetentionStatements = (nowMs: number) =>
(
  { projectId, plan }: ProjectRetention,
): SqlStatement[] => {
  const { countsCutoffMs, anomaliesCutoffMs } = retentionCutoffsForPlan(
    plan,
    nowMs,
  );
  return [
    ...map(deleteProjectTableBefore(projectId, countsCutoffMs))(countTables),
    deleteProjectTableBefore(projectId, anomaliesCutoffMs)("anomalies"),
  ];
};

const globalRetentionStatements = (nowMs: number): SqlStatement[] => [
  { sql: "DELETE FROM cooldowns WHERE expires_at < ?;", args: [nowMs] },
  {
    sql: "DELETE FROM email_rate_limits WHERE expires_at < ?;",
    args: [nowMs],
  },
];

export const buildRetentionBatch =
  (nowMs: number) => (projects: ProjectRetention[]): SqlStatement[] => [
    ...projects.flatMap(projectRetentionStatements(nowMs)),
    ...globalRetentionStatements(nowMs),
  ];
