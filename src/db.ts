import { init } from "@instantdb/admin";
import schema from "../instant.schema.ts";

const createDb = () => {
  const appId = Deno.env.get("INSTANTDB_APP_ID") ?? "";
  const adminToken = Deno.env.get("INSTANTDB_ADMIN_TOKEN") ?? "";
  return init({
    appId,
    adminToken,
    schema,
  });
};

let _db: ReturnType<typeof createDb> | null = null;
const getDb = () => _db ??= createDb();

type ProjectWithOwner = {
  id: string;
  name: string;
  token: string;
  webhookUrl?: string;
  owner: { id: string; email: string };
};

type CacheEntry = { value: ProjectWithOwner; expiresAt: number };

const cacheTtlMs = 5 * 60 * 1000;
const tokenCache = new Map<string, CacheEntry>();
const idCache = new Map<string, CacheEntry>();

const cacheSet = (project: ProjectWithOwner) => {
  const entry = { value: project, expiresAt: Date.now() + cacheTtlMs };
  tokenCache.set(project.token, entry);
  idCache.set(project.id, entry);
};

const cacheGet = (cache: Map<string, CacheEntry>, key: string) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
};

const parseProject = (
  project: {
    id: string;
    name: string;
    token: string;
    webhookUrl?: string;
    owner?: unknown;
  },
): ProjectWithOwner | null => {
  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner;
  return owner
    ? {
      id: project.id,
      name: project.name,
      token: project.token,
      webhookUrl: project.webhookUrl,
      owner: {
        id: (owner as { id: string }).id,
        email: (owner as { email: string }).email,
      },
    }
    : null;
};

const queryProject = async (
  where: { token: string } | { id: string },
): Promise<ProjectWithOwner | null> => {
  const { projects } = await getDb().query({
    projects: { $: { where }, owner: {} },
  });
  const project = projects?.[0];
  if (!project?.owner) return null;
  const parsed = parseProject(project);
  if (parsed) cacheSet(parsed);
  return parsed;
};

export const lookupProjectByToken = async (
  token: string,
): Promise<ProjectWithOwner | null> =>
  cacheGet(tokenCache, token) ?? await queryProject({ token });

export const lookupProjectById = async (
  id: string,
): Promise<ProjectWithOwner | null> =>
  cacheGet(idCache, id) ?? await queryProject({ id });
