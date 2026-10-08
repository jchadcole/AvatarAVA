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
  /** LiveAvatar avatar for this show (from the LiveAvatar dashboard). Ignored in sandbox mode. */
  avatarId: z.string().optional(),
  /** Deepgram Aura voice for the host, e.g. "aura-2-orpheus-en". */
  voice: z.string().default("aura-2-orpheus-en"),
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
  /** The same knowledge, one entry per file, for showing where an answer came from. */
  knowledgeFiles: KnowledgeFile[];
};

export interface KnowledgeFile {
  name: string;
  text: string;
}

/** Loads shows/<name>/{show.json,persona.md} plus its knowledge (see loadKnowledge). */
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
  const knowledgeFiles = readKnowledgeFiles(dir);
  return {
    ...show,
    persona: fill(fs.readFileSync(path.join(dir, "persona.md"), "utf8")),
    knowledge: joinKnowledge(knowledgeFiles),
    knowledgeFiles,
  };
}

/** Roughly 100k tokens; beyond this replies slow down and cost more. */
const KNOWLEDGE_WARN_CHARS = 400_000;

/**
 * Booth knowledge is knowledge.md (if present) plus every .md and .txt file in
 * the show's knowledge/ folder, in name order, each tagged with its file name.
 */
export function loadKnowledge(showDir: string): string {
  return joinKnowledge(readKnowledgeFiles(showDir));
}

function readKnowledgeFiles(showDir: string): KnowledgeFile[] {
  const files: string[] = [];
  if (fs.existsSync(path.join(showDir, "knowledge.md"))) files.push("knowledge.md");
  const folder = path.join(showDir, "knowledge");
  if (fs.existsSync(folder)) {
    for (const name of fs.readdirSync(folder).sort()) {
      if (/\.(md|txt)$/i.test(name)) files.push(path.join("knowledge", name));
    }
  }
  if (!files.length) throw new Error(`No booth knowledge in ${showDir}: add knowledge.md or files in knowledge/.`);
  return files.map((name) => ({ name, text: fs.readFileSync(path.join(showDir, name), "utf8").trim() }));
}

function joinKnowledge(files: KnowledgeFile[]): string {
  const knowledge = files.map((f) => `<source name="${f.name}">\n${f.text}\n</source>`).join("\n\n");
  if (knowledge.length > KNOWLEDGE_WARN_CHARS) {
    console.warn(`Booth knowledge is ${knowledge.length} characters; consider trimming it to the topics visitors ask about.`);
  }
  return knowledge;
}

export interface Env {
  port: number;
  kioskId: string;
  showName: string;
  logDir: string;
  claudeModel: string;
  /** Model for the input classifier; a faster model here cuts the wait before speech. */
  classifierModel: string;
  claudeEffort: "low" | "medium" | "high" | "xhigh" | "max";
  liveAvatarApiKey?: string;
  liveAvatarSandbox: boolean;
  /** LIVEAVATAR_AVATAR_ID, an override for the show's avatarId. */
  liveAvatarAvatarId?: string;
  liveAvatarVideoQuality: "very_high" | "high" | "medium" | "low";
  /**
   * LIVEAVATAR_PREWARM: keep an avatar session open between visits so Start is
   * instant. Uses credits the whole time the page is open; never in sandbox.
   */
  liveAvatarPrewarm: boolean;
  deepgramApiKey?: string;
  deepgramSttModel: string;
  /** DEEPGRAM_TTS_MODEL, an override for the show's voice. */
  deepgramTtsModel?: string;
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
    claudeModel: env.CLAUDE_MODEL || "claude-opus-5-5",
    classifierModel: env.CLAUDE_CLASSIFIER_MODEL || "claude-haiku-4-5",
    claudeEffort: effort as Env["claudeEffort"],
    liveAvatarApiKey: env.LIVEAVATAR_API_KEY || undefined,
    liveAvatarSandbox: sandbox,
    liveAvatarAvatarId: env.LIVEAVATAR_AVATAR_ID || undefined,
    liveAvatarVideoQuality: quality as Env["liveAvatarVideoQuality"],
    liveAvatarPrewarm: !sandbox && (env.LIVEAVATAR_PREWARM ?? "").toLowerCase() === "true",
    deepgramApiKey: env.DEEPGRAM_API_KEY || undefined,
    deepgramSttModel: env.DEEPGRAM_STT_MODEL ?? "nova-3",
    deepgramTtsModel: env.DEEPGRAM_TTS_MODEL || undefined,
  };
}

/**
 * Which avatar to start. Sandbox mode only allows the sandbox avatar; otherwise
 * LIVEAVATAR_AVATAR_ID wins over the show's avatarId.
 */
export function pickAvatarId(env: Env, show: Pick<ShowConfig, "avatarId">): string {
  if (env.liveAvatarSandbox) return SANDBOX_AVATAR_ID;
  const id = env.liveAvatarAvatarId || show.avatarId;
  if (!id) throw new Error('Live mode needs an avatar: set "avatarId" in show.json or LIVEAVATAR_AVATAR_ID.');
  return id;
}
