import { init } from "@instantdb/admin";
import schema from "../instant.schema.ts";

const appId = Deno.env.get("INSTANTDB_APP_ID") ?? "";
const adminToken = Deno.env.get("INSTANTDB_ADMIN_TOKEN") ?? "";

export const { transact, tx, query, auth } = init({
  appId,
  adminToken,
  schema,
});

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
  const { projects } = await query({
    projects: {
      $: { where: { token } },
      owner: {},
    },
  });
  const project = projects[0];
  return project?.owner
    ? {
      id: project.id,
      name: project.name,
      token: project.token,
      webhookUrl: project.webhookUrl,
      owner: project.owner,
    }
    : null;
};
