import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const CannedLines = z.object({
  didNotCatch: z.string(),
  suggest: z.string(),
  deflectAbuse: z.string(),
  endSession: z.string(),
  deflectInjection: z.string(),
  safeFallback: z.string(),
  error: z.string(),
  goodbye: z.string(),
});

const ShowFile = z.object({
  id: z.string(),
  eventName: z.string(),
  company: z.string(),
  avatarName: z.string(),
  language: z.string().default("en"),
  greeting: z.string(),
  suggestedQuestions: z.array(z.string()).default([]),
  keyterms: z.array(z.string()).default([]),
  blockedTerms: z.array(z.string()).default([]),
  competitors: z.array(z.string()).default([]),
  idleResetSeconds: z.number().int().positive().default(45),
  maxStrikes: z.number().int().positive().default(2),
  maxTurnsInMemory: z.number().int().positive().default(8),
  maxVisitorChars: z.number().int().positive().default(600),
  cannedLines: CannedLines,
});

export type CannedLineKey = keyof z.infer<typeof CannedLines>;

export type ShowConfig = z.infer<typeof ShowFile> & {
  /** Persona prompt with {{placeholders}} filled in. */
  persona: string;
  /** Booth knowledge the avatar may answer from. */
  knowledge: string;
};

/** Loads shows/<name>/{show.json,persona.md,knowledge.md}. */
export function loadShow(showsDir: string, name: string): ShowConfig {
  const dir = path.join(showsDir, name);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "show.json"), "utf8"));
  const show = ShowFile.parse(raw);
  const fill = (text: string) =>
    text
      .replaceAll("{{avatarName}}", show.avatarName)
      .replaceAll("{{company}}", show.company)
      .replaceAll("{{eventName}}", show.eventName)
      .replaceAll("{{competitors}}", show.competitors.join(", ") || "none listed");
  return {
    ...show,
    persona: fill(fs.readFileSync(path.join(dir, "persona.md"), "utf8")),
    knowledge: fs.readFileSync(path.join(dir, "knowledge.md"), "utf8"),
  };
}

export interface Env {
  port: number;
  kioskId: string;
  showName: string;
  logDir: string;
  claudeModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  liveAvatarApiKey?: string;
  liveAvatarSandbox: boolean;
  liveAvatarAvatarId: string;
  liveAvatarVideoQuality: "very_high" | "high" | "medium" | "low";
  deepgramApiKey?: string;
  deepgramSttModel: string;
  deepgramTtsModel: string;
}

/** The only avatar LiveAvatar allows in sandbox mode ("Wayne"). */
export const SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const effort = env.CLAUDE_EFFORT ?? "low";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`CLAUDE_EFFORT must be low, medium, high, xhigh or max (got "${effort}")`);
  }
  const quality = env.LIVEAVATAR_VIDEO_QUALITY ?? "high";
  if (!["very_high", "high", "medium", "low"].includes(quality)) {
    throw new Error(`LIVEAVATAR_VIDEO_QUALITY must be very_high, high, medium or low (got "${quality}")`);
  }
  const sandbox = (env.LIVEAVATAR_SANDBOX ?? "true").toLowerCase() !== "false";
  return {
    port: Number(env.PORT ?? 3000),
    kioskId: env.KIOSK_ID ?? "booth-1",
    showName: env.SHOW ?? "demo",
    logDir: env.LOG_DIR ?? "logs",
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    claudeEffort: effort as Env["claudeEffort"],
    liveAvatarApiKey: env.LIVEAVATAR_API_KEY || undefined,
    liveAvatarSandbox: sandbox,
    liveAvatarAvatarId: sandbox ? SANDBOX_AVATAR_ID : (env.LIVEAVATAR_AVATAR_ID ?? SANDBOX_AVATAR_ID),
    liveAvatarVideoQuality: quality as Env["liveAvatarVideoQuality"],
    deepgramApiKey: env.DEEPGRAM_API_KEY || undefined,
    deepgramSttModel: env.DEEPGRAM_STT_MODEL ?? "nova-3",
    deepgramTtsModel: env.DEEPGRAM_TTS_MODEL ?? "aura-2-thalia-en",
  };
}
