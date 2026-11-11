import { empty, filter, map } from "gamla";
import { z } from "zod/v4";
import { getTurso } from "./turso.ts";

export type ProjectGithubConfig = {
  projectId: string;
  githubToken: string;
  githubRepo: string;
};

export type CreatedGithubIssue = {
  issueUrl: string;
  issueNumber: number;
};

export type RepoResolution =
  | { ok: true; githubRepo: string }
  | { ok: false; error: string; repos: string[] };

export type CreateIssueResult =
  | { ok: true; issue: CreatedGithubIssue }
  | { ok: false; error: string };

const githubApiBase = "https://api.github.com";
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const normalizeGithubRepo = (raw: string): string => {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return repoPattern.test(cleaned) ? cleaned : "";
};

export const getProjectGithubConfig = async (
  projectId: string,
): Promise<ProjectGithubConfig | null> => {
  const res = await getTurso().execute({
    sql:
      "SELECT project_id, github_token, github_repo FROM project_github WHERE project_id = ?;",
    args: [projectId],
  });
  return empty(res.rows) ? null : {
    projectId: String(res.rows[0].project_id),
    githubToken: String(res.rows[0].github_token),
    githubRepo: String(res.rows[0].github_repo),
  };
};

export const saveProjectGithubConfig = async ({
  projectId,
  githubToken,
  githubRepo,
}: ProjectGithubConfig): Promise<void> => {
  await getTurso().execute({
    sql:
      `INSERT INTO project_github (project_id, github_token, github_repo, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id)
       DO UPDATE SET github_token = excluded.github_token, github_repo = excluded.github_repo, updated_at = excluded.updated_at;`,
    args: [projectId, githubToken, githubRepo, Date.now()],
  });
};

export const deleteProjectGithubConfig = async (
  projectId: string,
): Promise<void> => {
  await getTurso().execute({
    sql: "DELETE FROM project_github WHERE project_id = ?;",
    args: [projectId],
  });
};

export const getAlertGithubIssue = async (
  token: string,
): Promise<CreatedGithubIssue | null> => {
  const res = await getTurso().execute({
    sql:
      "SELECT issue_url, issue_number FROM alert_github_issues WHERE token = ?;",
    args: [token],
  });
  return empty(res.rows) ? null : {
    issueUrl: String(res.rows[0].issue_url),
    issueNumber: Number(res.rows[0].issue_number),
  };
};

export const saveAlertGithubIssue = async (
  token: string,
  { issueUrl, issueNumber }: CreatedGithubIssue,
): Promise<void> => {
  await getTurso().execute({
    sql:
      `INSERT INTO alert_github_issues (token, issue_url, issue_number, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (token) DO NOTHING;`,
    args: [token, issueUrl, issueNumber, Date.now()],
  });
};

const githubHeaders = (githubToken: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "anomalisa",
  "X-GitHub-Api-Version": "2022-11-28",
});

const repoItemSchema = z.object({
  name: z.string(),
  full_name: z.string(),
});

const repoListSchema = z.array(repoItemSchema);

const createdIssueSchema = z.object({
  html_url: z.string(),
  number: z.number(),
});

const githubErrorSchema = z.object({
  message: z.string(),
});

type RepoItem = z.infer<typeof repoItemSchema>;

const parseJsonText = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const extractGithubMessage = (text: string): string => {
  const parsed = githubErrorSchema.safeParse(parseJsonText(text));
  return parsed.success ? parsed.data.message : "";
};

const matchesProjectName = (projectName: string) => ({ name }: RepoItem) =>
  name.toLowerCase() === projectName.trim().toLowerCase();

const pickRepoFromList = (
  repos: RepoItem[],
  projectName: string,
): RepoResolution => {
  if (repos.length === 1) return { ok: true, githubRepo: repos[0].full_name };
  const nameMatches = filter(matchesProjectName(projectName))(repos);
  return nameMatches.length === 1
    ? { ok: true, githubRepo: nameMatches[0].full_name }
    : empty(repos)
    ? {
      ok: false,
      error:
        "No repositories accessible with this token. Grant repository access or enter owner/repo.",
      repos: [],
    }
    : {
      ok: false,
      error:
        "Multiple repositories are accessible with this token. Select or enter owner/repo.",
      repos: map(({ full_name }: RepoItem) => full_name)(repos),
    };
};

const fetchAccessibleRepos = async (
  githubToken: string,
  projectName: string,
): Promise<RepoResolution> => {
  const res = await fetch(
    `${githubApiBase}/user/repos?per_page=100&sort=updated`,
    { headers: githubHeaders(githubToken) },
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.status === 401 || res.status === 403
        ? "Invalid GitHub token. Check the token and try again."
        : `GitHub API error (${res.status}). Enter owner/repo manually.`,
      repos: [],
    };
  }
  const parsed = repoListSchema.safeParse(parseJsonText(await res.text()));
  return parsed.success ? pickRepoFromList(parsed.data, projectName) : {
    ok: false,
    error: "Unexpected response from GitHub. Enter owner/repo manually.",
    repos: [],
  };
};

export const resolveGithubRepo = (
  githubToken: string,
  rawRepo: string,
  projectName: string,
): Promise<RepoResolution> => {
  if (!rawRepo.trim()) return fetchAccessibleRepos(githubToken, projectName);
  const normalized = normalizeGithubRepo(rawRepo);
  return Promise.resolve(
    normalized ? { ok: true, githubRepo: normalized } : {
      ok: false,
      error: "Invalid repository format. Expected owner/repo.",
      repos: [],
    },
  );
};

const repoAccessError = (
  status: number,
  githubRepo: string,
  detail: string,
): string =>
  status === 401
    ? "GitHub token is invalid or expired."
    : status === 403
    ? `GitHub token lacks Issues write permission for ${githubRepo}.`
    : status === 404
    ? `Repository ${githubRepo} was not found or this token lacks access to it.`
    : status === 410
    ? `Issues are disabled on ${githubRepo}.`
    : `GitHub error (${status})${detail ? `: ${detail}` : "."}`;

export const createGithubIssue = async ({
  githubToken,
  githubRepo,
  title,
  body,
}: {
  githubToken: string;
  githubRepo: string;
  title: string;
  body: string;
}): Promise<CreateIssueResult> => {
  const res = await fetch(`${githubApiBase}/repos/${githubRepo}/issues`, {
    method: "POST",
    headers: {
      ...githubHeaders(githubToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      error: repoAccessError(
        res.status,
        githubRepo,
        extractGithubMessage(text),
      ),
    };
  }
  const parsed = createdIssueSchema.safeParse(parseJsonText(text));
  return parsed.success
    ? {
      ok: true,
      issue: {
        issueUrl: parsed.data.html_url,
        issueNumber: parsed.data.number,
      },
    }
    : { ok: false, error: "Unexpected response from GitHub issue creation." };
};

export const verifyGithubRepoAccess = async (
  githubToken: string,
  githubRepo: string,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  const res = await fetch(`${githubApiBase}/repos/${githubRepo}`, {
    headers: githubHeaders(githubToken),
  });
  return res.ok ? { ok: true } : {
    ok: false,
    error: repoAccessError(
      res.status,
      githubRepo,
      extractGithubMessage(await res.text()),
    ),
  };
};

const projectGithubBodySchema = z.discriminatedUnion("action", [
  z.object({ token: z.string(), action: z.literal("get") }),
  z.object({
    token: z.string(),
    action: z.literal("set"),
    githubToken: z.string().optional(),
    githubRepo: z.string().optional(),
  }),
  z.object({ token: z.string(), action: z.literal("delete") }),
]);

const updateProjectGithub = async (
  project: { id: string; name: string },
  submittedToken: string,
  rawRepo: string,
): Promise<
  { status: number; body: Record<string, string | boolean | string[]> }
> => {
  const existing = await getProjectGithubConfig(project.id);
  const githubToken = submittedToken.trim() || existing?.githubToken || "";
  if (!githubToken) {
    return { status: 400, body: { error: "Enter a GitHub token." } };
  }
  const resolution = await resolveGithubRepo(
    githubToken,
    rawRepo,
    project.name,
  );
  if (!resolution.ok) {
    return {
      status: 400,
      body: { error: resolution.error, repos: resolution.repos },
    };
  }
  const access = await verifyGithubRepoAccess(
    githubToken,
    resolution.githubRepo,
  );
  if (!access.ok) return { status: 400, body: { error: access.error } };
  await saveProjectGithubConfig({
    projectId: project.id,
    githubToken,
    githubRepo: resolution.githubRepo,
  });
  return {
    status: 200,
    body: { ok: true, configured: true, githubRepo: resolution.githubRepo },
  };
};

export const handleProjectGithubRequest = async (
  bodyText: string,
  resolveProject: (token: string) => Promise<{ id: string; name: string }>,
): Promise<
  { status: number; body: Record<string, string | boolean | string[]> }
> => {
  const parsed = projectGithubBodySchema.safeParse(parseJsonText(bodyText));
  if (!parsed.success) {
    return { status: 400, body: { error: "Invalid request" } };
  }
  const project = await resolveProject(parsed.data.token).catch(() => null);
  if (!project) return { status: 400, body: { error: "Invalid token" } };
  if (parsed.data.action === "get") {
    const cfg = await getProjectGithubConfig(project.id);
    return {
      status: 200,
      body: { configured: Boolean(cfg), githubRepo: cfg?.githubRepo ?? "" },
    };
  }
  if (parsed.data.action === "delete") {
    await deleteProjectGithubConfig(project.id);
    return {
      status: 200,
      body: { ok: true, configured: false, githubRepo: "" },
    };
  }
  return updateProjectGithub(
    project,
    parsed.data.githubToken ?? "",
    parsed.data.githubRepo ?? "",
  );
};
