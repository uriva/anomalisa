import { empty, join, map, nonempty, pipe } from "gamla";
import { z } from "zod/v4";
import type { Anomaly } from "./anomaly.ts";
import { formatBucket, metricLabel } from "./email.ts";
import {
  type AlertFeedbackRecord,
  getAlertFeedback,
  renderDetails,
} from "./feedback.ts";
import {
  createGithubIssue,
  getAlertGithubIssue,
  getProjectGithubConfig,
  resolveGithubRepo,
  saveAlertGithubIssue,
  saveProjectGithubConfig,
} from "./github.ts";
import { centerPageStyles, escapeHtml, renderPage } from "./page.ts";

export type InvestigateResponse =
  | { kind: "html"; html: string; status: number }
  | { kind: "redirect"; location: string };

const anomalySchema = z.object({
  projectId: z.string(),
  eventName: z.string(),
  bucket: z.string(),
  expected: z.number(),
  actual: z.number(),
  zScore: z.number(),
  metric: z.enum([
    "totalCount",
    "userSpike",
    "percentageSpike",
    "percentageDrop",
  ]),
  detectedAt: z.string(),
  userId: z.string().optional(),
  trend: z.string().optional(),
});

const historySchema = z.object({
  counts: z.array(z.number()).optional(),
  buckets: z.array(z.object({ bucket: z.string(), count: z.number() }))
    .optional(),
});

const parseJsonSafe = (raw: string) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const parseAnomalies = (raw: string): Anomaly[] => {
  const parsed = z.array(anomalySchema).safeParse(parseJsonSafe(raw));
  return parsed.success ? parsed.data : [];
};

const parseHistory = (raw: string) => {
  const parsed = historySchema.safeParse(parseJsonSafe(raw));
  return {
    counts: parsed.success ? parsed.data.counts ?? [] : [],
    buckets: parsed.success ? parsed.data.buckets ?? [] : [],
  };
};

const anomalyLine = (anomaly: Anomaly) =>
  `- ${
    metricLabel(anomaly.metric)
  }: expected ${anomaly.expected}, actual ${anomaly.actual}, z-score ${anomaly.zScore}${
    anomaly.userId ? `, user ${anomaly.userId}` : ""
  }${anomaly.trend ? `, trend: ${anomaly.trend}` : ""}`;

export const buildIssueTitle = (record: AlertFeedbackRecord): string =>
  `Anomaly in ${record.eventName}: expected ${record.expected}, got ${record.actual} (${
    formatBucket(record.bucket)
  })`;

export const buildAgentPrompt = (
  record: AlertFeedbackRecord,
  projectName: string,
): string => {
  const anomalies = parseAnomalies(record.anomaliesJson);
  const { counts, buckets } = parseHistory(record.historyJson);
  const anomalyLines = empty(anomalies)
    ? [
      `- ${record.metric}: expected ${record.expected}, actual ${record.actual}, z-score ${record.zScore}`,
    ]
    : map(anomalyLine)(anomalies);
  return `Investigate this Anomalisa anomaly and report the most likely cause, with evidence and next steps.

Project: ${projectName || record.projectId}
Project ID: ${record.projectId}
Event: ${record.eventName}
Bucket: ${record.bucket} (${formatBucket(record.bucket)})
Metric: ${record.metric}
Expected: ${record.expected}
Actual: ${record.actual}
Z-score: ${record.zScore}
User: ${record.userId === "_" ? "(none)" : record.userId}
Detected at: ${anomalies[0]?.detectedAt ?? "unknown"}

Recent hourly counts, oldest to newest:
${empty(counts) ? "(no history snapshot)" : counts.join(", ")}

Recent buckets:
${
    empty(buckets) ? "(no history snapshot)" : pipe(
      map(({ bucket, count }: { bucket: string; count: number }) =>
        `${bucket}: ${count}`
      ),
      join("\n"),
    )(buckets)
  }

Anomalies in this bucket:
${anomalyLines.join("\n")}

Running stats:
${record.statsJson ?? "(none)"}

What to check:
- Find where the "${record.eventName}" event is emitted and whether a recent deploy or config change affects that path.
- Check upstream services, databases, and third-party APIs used around this bucket.
- Check whether a single user, bot, or traffic source explains the change.
- Compare adjacent hours and the same hour on previous days.
`;
};

const investigateStyles = `
    ${centerPageStyles}
    .card { max-width: 520px; text-align: left; }
    .subtitle { font-size: 0.9rem; color: #a1a1aa; margin: 0 0 1.25rem 0; line-height: 1.45; }
    .error-box { background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(248, 113, 113, 0.35); color: #fca5a5; border-radius: 8px; padding: 0.7rem 0.9rem; font-size: 0.85rem; line-height: 1.4; margin-bottom: 1.1rem; }
    .field-group { margin-bottom: 1rem; }
    .field-label { display: block; font-size: 0.82rem; font-weight: 600; color: #d4d4d8; margin-bottom: 0.35rem; }
    .optional-tag { font-weight: 400; color: #71717a; }
    .field-input { width: 100%; background: #0f0f0f; border: 1px solid #27272a; border-radius: 6px; padding: 0.6rem 0.75rem; color: #f4f4f5; font-family: inherit; font-size: 0.9rem; }
    .field-input:focus { outline: none; border-color: #52525b; }
    .field-hint { font-size: 0.78rem; color: #71717a; line-height: 1.4; margin: 0.35rem 0 0 0; }
    .submit-btn { cursor: pointer; font-family: inherit; margin-top: 0.5rem; }
    .submit-btn:disabled { opacity: 0.6; cursor: wait; }
    .footer-links { text-align: center; margin-top: 1.1rem; }
`;

const disableOnSubmitScript = `<script>
  const form = document.getElementById("github-setup-form");
  const submitBtn = document.getElementById("submit-btn");
  if (form && submitBtn) {
    form.addEventListener("submit", () => {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating issue…";
    });
  }
</script>`;

const autoSubmitScript = `<script>
  const autoForm = document.getElementById("auto-create-form");
  const autoBtn = document.getElementById("submit-btn");
  if (autoForm) {
    if (autoBtn) {
      autoBtn.disabled = true;
      autoBtn.textContent = "Creating GitHub issue…";
    }
    autoForm.submit();
  }
</script>`;

export const renderNotFoundHtml = (): string =>
  renderPage({
    title: "Alert Details Not Found — Anomalisa",
    styles: centerPageStyles,
    body: `<div class="card">
    <h1>Alert Details Not Found</h1>
    <p>This alert link is invalid or has expired.</p>
    <p style="margin-top: 1.5rem;"><a href="/app">Go to Anomalisa Dashboard</a></p>
  </div>`,
  });

const renderRepoOption = (selectedRepo: string) => (repo: string) =>
  `<option value="${escapeHtml(repo)}"${
    repo === selectedRepo ? " selected" : ""
  }>${escapeHtml(repo)}</option>`;

const renderRepoField = (githubRepo: string, repos: string[]): string =>
  nonempty(repos)
    ? `<select class="field-input" id="github-repo" name="githubRepo">${
      pipe(map(renderRepoOption(githubRepo)), join(""))(repos)
    }</select>`
    : `<input class="field-input" id="github-repo" name="githubRepo" type="text" value="${
      escapeHtml(githubRepo)
    }" placeholder="owner/repo" autocomplete="off" />`;

export const renderTokenFormHtml = ({
  record,
  projectName,
  githubRepo,
  error,
  repos,
}: {
  record: AlertFeedbackRecord;
  projectName: string;
  githubRepo: string;
  error: string;
  repos: string[];
}): string => {
  const displayProject = projectName || record.projectId;
  return renderPage({
    title: `Create GitHub Issue — ${displayProject} — Anomalisa`,
    styles: investigateStyles,
    script: disableOnSubmitScript,
    body: `<div class="card">
    <div class="brand">Anomalisa · GitHub Issue</div>
    <h1>Connect GitHub for ${escapeHtml(displayProject)}</h1>
    <p class="subtitle">Enter a GitHub token for this project to open an issue for <code>${
      escapeHtml(record.eventName)
    }</code>. It will be saved for future alerts.</p>
    ${renderDetails(record)}
    ${error ? `<div class="error-box">${escapeHtml(error)}</div>` : ""}
    <form id="github-setup-form" method="POST" action="/investigate">
      <input type="hidden" name="token" value="${escapeHtml(record.token)}" />
      <div class="field-group">
        <label class="field-label" for="github-token">GitHub Personal Access Token</label>
        <input class="field-input" id="github-token" name="githubToken" type="password" placeholder="github_pat_... or ghp_..." required autocomplete="off" autofocus />
        <p class="field-hint"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a fine-grained token</a> with <strong>Issues: Read and write</strong> permission.</p>
      </div>
      <div class="field-group">
        <label class="field-label" for="github-repo">Repository <span class="optional-tag">(optional if token is scoped to one repo)</span></label>
        ${renderRepoField(githubRepo, repos)}
      </div>
      <button class="btn-primary submit-btn" id="submit-btn" type="submit">Save token &amp; create issue</button>
    </form>
    <div class="footer-links">
      <a class="home-link" href="/app">Go to Dashboard</a>
    </div>
  </div>`,
  });
};

export const renderAutoCreateHtml = (
  record: AlertFeedbackRecord,
  githubRepo: string,
): string =>
  renderPage({
    title: `Creating GitHub Issue — Anomalisa`,
    styles: investigateStyles,
    script: autoSubmitScript,
    body: `<div class="card">
    <div class="brand">Anomalisa · GitHub Issue</div>
    <h1>Creating GitHub issue…</h1>
    <p class="subtitle">Opening an issue in <code>${
      escapeHtml(githubRepo)
    }</code> for <code>${escapeHtml(record.eventName)}</code>.</p>
    ${renderDetails(record)}
    <form id="auto-create-form" method="POST" action="/investigate">
      <input type="hidden" name="token" value="${escapeHtml(record.token)}" />
      <button class="btn-primary submit-btn" id="submit-btn" type="submit">Create GitHub issue</button>
    </form>
  </div>`,
  });

const createAndSaveWithSubmittedToken = async ({
  record,
  projectName,
  submittedToken,
  rawRepo,
}: {
  record: AlertFeedbackRecord;
  projectName: string;
  submittedToken: string;
  rawRepo: string;
}): Promise<InvestigateResponse> => {
  const resolution = await resolveGithubRepo(
    submittedToken,
    rawRepo,
    projectName,
  );
  if (!resolution.ok) {
    return {
      kind: "html",
      html: renderTokenFormHtml({
        record,
        projectName,
        githubRepo: rawRepo,
        error: resolution.error,
        repos: resolution.repos,
      }),
      status: 400,
    };
  }
  const creation = await createGithubIssue({
    githubToken: submittedToken,
    githubRepo: resolution.githubRepo,
    title: buildIssueTitle(record),
    body: buildAgentPrompt(record, projectName),
  });
  if (!creation.ok) {
    return {
      kind: "html",
      html: renderTokenFormHtml({
        record,
        projectName,
        githubRepo: resolution.githubRepo,
        error: creation.error,
        repos: [],
      }),
      status: 400,
    };
  }
  await saveProjectGithubConfig({
    projectId: record.projectId,
    githubToken: submittedToken,
    githubRepo: resolution.githubRepo,
  });
  await saveAlertGithubIssue(record.token, creation.issue);
  return { kind: "redirect", location: creation.issue.issueUrl };
};

const createWithStoredConfig = async (
  record: AlertFeedbackRecord,
  projectName: string,
  fallbackRepo: string,
): Promise<InvestigateResponse> => {
  const config = await getProjectGithubConfig(record.projectId);
  if (!config) {
    return {
      kind: "html",
      html: renderTokenFormHtml({
        record,
        projectName,
        githubRepo: fallbackRepo,
        error: "Enter a GitHub token to create the issue.",
        repos: [],
      }),
      status: 400,
    };
  }
  const creation = await createGithubIssue({
    githubToken: config.githubToken,
    githubRepo: config.githubRepo,
    title: buildIssueTitle(record),
    body: buildAgentPrompt(record, projectName),
  });
  if (!creation.ok) {
    return {
      kind: "html",
      html: renderTokenFormHtml({
        record,
        projectName,
        githubRepo: config.githubRepo,
        error: creation.error,
        repos: [],
      }),
      status: 400,
    };
  }
  await saveAlertGithubIssue(record.token, creation.issue);
  return { kind: "redirect", location: creation.issue.issueUrl };
};

export const handleInvestigate = async (
  url: URL,
  resolveProjectName: (projectId: string) => Promise<string>,
): Promise<InvestigateResponse> => {
  const token = url.searchParams.get("token");
  if (!token) return { kind: "html", html: renderNotFoundHtml(), status: 404 };
  const record = await getAlertFeedback(token);
  if (!record) return { kind: "html", html: renderNotFoundHtml(), status: 404 };
  const existingIssue = await getAlertGithubIssue(token);
  if (existingIssue) {
    return { kind: "redirect", location: existingIssue.issueUrl };
  }
  const config = await getProjectGithubConfig(record.projectId);
  return config
    ? {
      kind: "html",
      html: renderAutoCreateHtml(record, config.githubRepo),
      status: 200,
    }
    : {
      kind: "html",
      html: renderTokenFormHtml({
        record,
        projectName: await resolveProjectName(record.projectId),
        githubRepo: "",
        error: "",
        repos: [],
      }),
      status: 200,
    };
};

export const handleInvestigatePost = async (
  bodyText: string,
  resolveProjectName: (projectId: string) => Promise<string>,
): Promise<InvestigateResponse> => {
  const params = new URLSearchParams(bodyText);
  const token = (params.get("token") ?? "").trim();
  if (!token) return { kind: "html", html: renderNotFoundHtml(), status: 404 };
  const record = await getAlertFeedback(token);
  if (!record) return { kind: "html", html: renderNotFoundHtml(), status: 404 };
  const existingIssue = await getAlertGithubIssue(token);
  if (existingIssue) {
    return { kind: "redirect", location: existingIssue.issueUrl };
  }
  const projectName = await resolveProjectName(record.projectId);
  const submittedToken = (params.get("githubToken") ?? "").trim();
  const rawRepo = (params.get("githubRepo") ?? "").trim();
  return submittedToken
    ? createAndSaveWithSubmittedToken({
      record,
      projectName,
      submittedToken,
      rawRepo,
    })
    : createWithStoredConfig(record, projectName, rawRepo);
};
