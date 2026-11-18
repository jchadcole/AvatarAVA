const API_URL = "https://api.anam.ai";

export interface AnamSessionOptions {
  apiKey: string;
  avatarId: string;
  maxSessionSeconds?: number;
}

/**
 * Mints an Anam session token in audio passthrough mode: Anam only renders the
 * face, lip-synced to the audio we send. Our own speech-to-text, brain,
 * guardrails and voice stay in charge, the same as LiveAvatar's LITE mode.
 * The API key stays on the server; the kiosk browser only sees the token.
 */
export async function createAnamSessionToken(opts: AnamSessionOptions): Promise<{ sessionToken: string }> {
  const res = await fetch(`${API_URL}/v1/auth/session-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(anamSessionBody(opts)),
  });
  if (!res.ok) throw new Error(`Anam token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { sessionToken?: string };
  if (!body.sessionToken) throw new Error("Anam token response had no sessionToken.");
  return { sessionToken: body.sessionToken };
}

export function anamSessionBody(opts: Pick<AnamSessionOptions, "avatarId" | "maxSessionSeconds">): object {
  return {
    personaConfig: {
      avatarId: opts.avatarId,
      enableAudioPassthrough: true,
      ...(opts.maxSessionSeconds ? { maxSessionLengthSeconds: opts.maxSessionSeconds } : {}),
    },
  };
}
