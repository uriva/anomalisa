import { postJson } from "gamla";

type MonaTokenResponse = {
  expires: string;
  expiresIn: number;
  accessToken: string;
  refreshToken: string;
};

type MonaCredentials = {
  secret: string;
  clientId: string;
  tenantId: string;
};

type MonaEvent = {
  projectId: string;
  eventName: string;
  distinctId: string;
  properties: Record<string, unknown>;
};

export const sendToMona =
  ({ secret, clientId, tenantId }: MonaCredentials) =>
  async ({ projectId, eventName, distinctId, properties }: MonaEvent) => {
    try {
      const tokenResponse = await postJson(
        "https://monalabs.frontegg.com/identity/resources/auth/v1/api-token",
        { clientId, secret },
      );
      const { accessToken } = await tokenResponse.json() as MonaTokenResponse;
      const response = await fetch(
        `https://incoming${tenantId}.monalabs.io/export`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: tenantId,
            messages: [{
              arcClass: "main",
              message: { distinctId, projectId, eventName, properties },
            }],
          }),
        },
      );
      if (!response.ok) {
        console.error(
          "Mona report failed",
          response.status,
          await response.text(),
        );
      }
    } catch (e) {
      console.error("Mona report error", e);
    }
  };
