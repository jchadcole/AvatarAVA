const API_URL = "https://api.liveavatar.com";

export interface LiteSessionOptions {
  apiKey: string;
  avatarId: string;
  sandbox: boolean;
  quality: "very_high" | "high" | "medium" | "low";
  maxSessionSeconds?: number;
}

/**
 * Mints a LiveAvatar session token in LITE (Avatar Only) mode. The API key
 * stays on the server; the kiosk browser only ever sees the session token.
 */
export async function createLiteSessionToken(
  opts: LiteSessionOptions,
): Promise<{ sessionId: string; sessionToken: string }> {
  const res = await fetch(`${API_URL}/v1/sessions/token`, {
    method: "POST",
    headers: { "X-API-KEY": opts.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "LITE",
      avatar_id: opts.avatarId,
      is_sandbox: opts.sandbox,
      video_settings: { quality: opts.quality, encoding: "H264" },
      ...(opts.maxSessionSeconds ? { max_session_duration: opts.maxSessionSeconds } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LiveAvatar token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { session_id: string; session_token: string } };
  return { sessionId: body.data.session_id, sessionToken: body.data.session_token };
}
