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

type AnomalisaEvent = {
  projectId: string;
  eventName: string;
  endUser: string;
  properties: Record<string, unknown>;
};

export const sendToMona =
  ({ secret, clientId, tenantId }: MonaCredentials) =>
  async ({ projectId, eventName, endUser, properties }: AnomalisaEvent): Promise<void> => {
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
              message: { endUser, projectId, eventName, properties },
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
