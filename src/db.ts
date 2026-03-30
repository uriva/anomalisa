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
const getDb = () => {
  if (!_db) {
    _db = createDb();
  }
  return _db;
};

type ProjectWithOwner = {
  id: string;
  name: string;
  token: string;
  webhookUrl?: string;
  owner: { id: string; email: string };
};

export const lookupProjectByToken = async (
  token: string,
): Promise<ProjectWithOwner | null> => {
  const { query } = getDb();
  const { projects } = await query({
    projects: {
      $: { where: { token } },
      owner: {},
    },
  });
  const project = projects[0];
  if (!project || !project.owner) return null;
  // We assert it's an array with at least one element or just a single element based on relation
  // Wait, owner is probably a single entity or array of entities, assuming single for project.owner
  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner;

  if (!owner) return null;

  return {
    id: project.id,
    name: project.name,
    token: project.token,
    webhookUrl: project.webhookUrl,
    owner: { id: owner.id, email: owner.email as string },
  };
};

export const lookupProjectById = async (
  id: string,
): Promise<ProjectWithOwner | null> => {
  const { query } = getDb();
  const { projects } = await query({
    projects: {
      $: { where: { id } },
      owner: {},
    },
  });
  const project = projects[0];
  if (!project || !project.owner) return null;
  const owner = Array.isArray(project.owner) ? project.owner[0] : project.owner;
  if (!owner) return null;

  return {
    id: project.id,
    name: project.name,
    token: project.token,
    webhookUrl: project.webhookUrl,
    owner: { id: owner.id, email: owner.email as string },
  };
};
