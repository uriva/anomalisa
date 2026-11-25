import {
  callDecisionModel,
  type DecisionAnswer,
  isDecisionModelAvailable,
  type NoulDecisionQuestion,
} from "@uriv/chaff";
import { empty, filter, map } from "gamla";
import type { AlertFeedbackRecord } from "./feedback.ts";
import {
  type CreatedGithubIssue,
  createGithubIssue,
  getProjectGithubConfig,
  getRecentProjectGithubIssues,
  type ProjectGithubConfig,
  type RecentProjectGithubIssue,
  saveAlertGithubIssue,
} from "./github.ts";
import {
  buildAgentPrompt,
  buildIssueTitle,
  parseAnomalies,
  parseHistory,
} from "./investigate.ts";

export const autoGithubIssueDecisionThreshold = 0.6;
export const recentGithubIssueWindowMs = 24 * 60 * 60 * 1000;

const alertQuestionId = (idx: number) => `alert_${idx}`;

export const buildAutoIssueQuestion = (
  id: string,
  eventName: string,
): NoulDecisionQuestion => ({
  type: "noul",
  instructions:
    `Decide whether Anomalisa should automatically open a new GitHub engineering issue to investigate ${id} ("${eventName}").`,
  criteria: {
    true:
      `Open a new GitHub issue automatically: (1) ${id} is a spike (project_wide or single_user) in an error, exception, unhandled rejection, crash, failed action, blocked request, missing/empty result, or abnormal/oversized input or system warning event indicating a bug or broken workflow; OR (2) ${id} is a complete outage drop to actual = 0 on a core healthy product/delivery event (not an error event); AND (3) ${id} is not already covered by recentGithubIssuesLast24h, and if multiple alerts in alertsInBatch reflect the same incident, ${id} is the single best representative to file (for generic vs detailed error events, pick the one with the specific error detail; for simultaneous drops to 0 across multiple product events, pick the one with the highest expected baseline).`,
    false:
      `Do NOT open a new GitHub issue automatically: (1) ${id} is a spike in normal healthy product usage, user engagement, chat/search/message/API volume, active user usage of non-error features, or routine background jobs/summarization/stats; OR (2) ${id} is a partial/off-peak traffic drop where actual > 0 (proving the feature is still alive); OR (3) ${id} is a drop in an error/failure event; OR (4) ${id} is an expected policy/guardrail rejection (such as quota exceeded, rate limit, duplicate/already-exists check, or quiet-hours deferral) or routine connection/reconnection churn; OR (5) recentGithubIssuesLast24h already has an issue for the same event/incident, or another alert in alertsInBatch already represents the same incident more specifically (or with a higher expected baseline for simultaneous 0-count outages).`,
  },
});

const formatAlertForDecision = (record: AlertFeedbackRecord, idx: number) => {
  const trend = parseAnomalies(record.anomaliesJson)[0]?.trend;
  const recentHourlyCounts = parseHistory(record.historyJson).counts.slice(-12);
  return {
    id: alertQuestionId(idx),
    eventName: record.eventName,
    bucketUtc: record.bucket,
    direction: record.actual > record.expected ? "spike" : "drop",
    metrics: record.metric.split(","),
    scope: record.userId === "_" ? "project_wide" : "single_user",
    expected: record.expected,
    actual: record.actual,
    zScore: record.zScore,
    ...(trend ? { trend } : {}),
    recentHourlyCounts,
  };
};

const formatRecentIssueForDecision = ({
  eventName,
  bucket,
  issueNumber,
}: RecentProjectGithubIssue) => ({
  eventName,
  bucketUtc: bucket,
  issueNumber,
});

const isPositiveDecision = (answer: DecisionAnswer | undefined): boolean =>
  Boolean(
    answer &&
      answer.type === "noul" &&
      answer.noul >= autoGithubIssueDecisionThreshold,
  );

export const decideAutoGithubIssues = async ({
  projectName,
  records,
  recentIssues,
}: {
  projectName: string;
  records: AlertFeedbackRecord[];
  recentIssues: RecentProjectGithubIssue[];
}): Promise<AlertFeedbackRecord[]> => {
  if (empty(records) || !isDecisionModelAvailable()) return [];
  const alertsInBatch = records.map(formatAlertForDecision);
  const questions = Object.fromEntries(
    records.map((r, idx) => [
      alertQuestionId(idx),
      buildAutoIssueQuestion(alertQuestionId(idx), r.eventName),
    ]),
  );
  const answers = await callDecisionModel(
    {
      project: projectName,
      recentGithubIssuesLast24h: map(formatRecentIssueForDecision)(
        recentIssues,
      ),
      alertsInBatch,
    },
    questions,
  );
  return records.filter((_, idx) =>
    isPositiveDecision(answers[alertQuestionId(idx)])
  );
};

const openSingleAlertIssue = (
  config: ProjectGithubConfig,
  projectName: string,
) =>
async (
  record: AlertFeedbackRecord,
): Promise<[string, CreatedGithubIssue][]> => {
  const creation = await createGithubIssue({
    githubToken: config.githubToken,
    githubRepo: config.githubRepo,
    title: buildIssueTitle(record),
    body: buildAgentPrompt(record, projectName),
  });
  if (!creation.ok) {
    console.error(
      `Failed to auto-create GitHub issue for ${record.eventName}: ${creation.error}`,
    );
    return [];
  }
  await saveAlertGithubIssue(record.token, creation.issue);
  return [[`${record.eventName}|${record.bucket}`, creation.issue]];
};

export const autoCreateGithubIssues = async ({
  projectName,
  records,
}: {
  projectName: string;
  records: AlertFeedbackRecord[];
}): Promise<Record<string, CreatedGithubIssue>> => {
  if (empty(records) || !isDecisionModelAvailable()) return {};
  const projectId = records[0].projectId;
  const config = await getProjectGithubConfig(projectId);
  if (!config) return {};
  const recentIssues = await getRecentProjectGithubIssues(
    projectId,
    Date.now() - recentGithubIssueWindowMs,
  );
  const existingBuckets = new Set(
    filter(({ eventName }: RecentProjectGithubIssue) =>
      records.some((r) => r.eventName === eventName)
    )(recentIssues).map(({ eventName, bucket }) => `${eventName}|${bucket}`),
  );
  const candidates = filter((r: AlertFeedbackRecord) =>
    !existingBuckets.has(`${r.eventName}|${r.bucket}`)
  )(records);
  if (empty(candidates)) return {};
  const selected = await decideAutoGithubIssues({
    projectName,
    records: candidates,
    recentIssues,
  });
  if (empty(selected)) return {};
  const entries = (
    await Promise.all(selected.map(openSingleAlertIssue(config, projectName)))
  ).flat();
  return Object.fromEntries(entries);
};
