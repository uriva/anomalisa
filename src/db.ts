import { init } from "@instantdb/admin";
import { context } from "@uri/inject";
import schema from "../instant.schema.ts";

export type AuthenticatedUser = {
  id: string;
  email: string;
};

export type ProjectWithOwner = {
  id: string;
  name: string;
  token: string;
  webhookUrl?: string;
  owner: AuthenticatedUser;
};

export type InstantClientConfig = {
  appId: string;
  apiURI?: string;
  websocketURI?: string;
};

export type InstantClientEnv = {
  appId?: string;
  apiUri?: string;
  websocketUri?: string;
};

export type InstantAdminEnv = {
  appId?: string;
  adminToken?: string;
  apiUri?: string;
};

export const instantConfigPlaceholder = "__ANOMALISA_INSTANT_CONFIG__";

const stripTrailingSlashes = (value: string) =>
  value.trim().replace(/\/+$/, "");

const deriveWebsocketUri = (apiUri: string) =>
  apiUri.startsWith("https://")
    ? `wss://${apiUri.slice("https://".length)}/runtime/session`
    : apiUri.startsWith("http://")
    ? `ws://${apiUri.slice("http://".length)}/runtime/session`
    : "";

export const resolveInstantAdminConfig = (
  { appId, adminToken, apiUri }: InstantAdminEnv,
) => {
  const normalizedApiUri = stripTrailingSlashes(apiUri ?? "");
  return {
    appId: (appId ?? "").trim(),
    adminToken: (adminToken ?? "").trim(),
    ...(normalizedApiUri ? { apiURI: normalizedApiUri } : {}),
  };
};

export const resolveInstantClientConfig = (
  { appId, apiUri, websocketUri }: InstantClientEnv,
): InstantClientConfig => {
  const normalizedApiUri = stripTrailingSlashes(apiUri ?? "");
  const normalizedWebsocketUri = stripTrailingSlashes(websocketUri ?? "") ||
    deriveWebsocketUri(normalizedApiUri);
  return {
    appId: (appId ?? "").trim(),
    ...(normalizedApiUri ? { apiURI: normalizedApiUri } : {}),
    ...(normalizedWebsocketUri ? { websocketURI: normalizedWebsocketUri } : {}),
  };
};

export const getInstantClientConfig = (): InstantClientConfig =>
  resolveInstantClientConfig({
    appId: Deno.env.get("INSTANTDB_APP_ID"),
    apiUri: Deno.env.get("INSTANTDB_API_URI"),
    websocketUri: Deno.env.get("INSTANTDB_WEBSOCKET_URI"),
  });

const serializeInlineJson = (value: InstantClientConfig) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");

export const renderAppHtml = (
  template: string,
  config: InstantClientConfig,
) =>
  template.replaceAll(
    instantConfigPlaceholder,
    () => serializeInlineJson(config),
  );

const createDb = () =>
  init({
    ...resolveInstantAdminConfig({
      appId: Deno.env.get("INSTANTDB_APP_ID"),
      adminToken: Deno.env.get("INSTANTDB_ADMIN_TOKEN"),
      apiUri: Deno.env.get("INSTANTDB_API_URI"),
    }),
    schema,
  });

let _db: ReturnType<typeof createDb> | null = null;
const getDb = () => _db ??= createDb();

const verifyInstantToken = async (
  token: string,
): Promise<AuthenticatedUser | null> => {
  if (!token) return null;
  try {
    const user = await getDb().auth.verifyToken(token);
    return user?.id && user?.email ? { id: user.id, email: user.email } : null;
  } catch {
    return null;
  }
};

export const {
  inject: injectVerifyUserToken,
  access: verifyUserToken,
} = context(verifyInstantToken);

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

export const { inject: injectProjectLookup, access: projectLookup } = context(
  async (token: string): Promise<ProjectWithOwner | null> =>
    cacheGet(tokenCache, token) ?? await queryProject({ token }),
);

export const lookupProjectByToken = (
  token: string,
): Promise<ProjectWithOwner | null> => projectLookup(token);

export const lookupProjectById = async (
  id: string,
): Promise<ProjectWithOwner | null> =>
  cacheGet(idCache, id) ?? await queryProject({ id });
