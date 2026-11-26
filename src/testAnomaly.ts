import { z } from "zod/v4";
import type { ProjectWithOwner } from "./db.ts";
import { sendTestAnomalyAlert } from "./email.ts";

const testAnomalyBodySchema = z.object({
  token: z.string().min(1),
});

const parseJsonText = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

type TestAnomalyResult = {
  status: number;
  body: Record<string, string | boolean>;
};

const sendForProject = ({
  id,
  name,
  owner,
}: ProjectWithOwner): Promise<TestAnomalyResult> =>
  sendTestAnomalyAlert(owner.email, name, id)
    .then(() => ({
      status: 200,
      body: { ok: true, sentTo: owner.email },
    }))
    .catch((err) => ({
      status: 500,
      body: {
        error: err instanceof Error
          ? err.message
          : "Failed to send test anomaly",
      },
    }));

export const handleTestAnomalyRequest = async (
  bodyText: string,
  lookupProject: (token: string) => Promise<ProjectWithOwner | null>,
): Promise<TestAnomalyResult> => {
  const parsed = testAnomalyBodySchema.safeParse(parseJsonText(bodyText));
  if (!parsed.success) {
    return { status: 400, body: { error: "Invalid request" } };
  }
  const project = await lookupProject(parsed.data.token).catch(() => null);
  return project
    ? await sendForProject(project)
    : { status: 400, body: { error: "Invalid token" } };
};
