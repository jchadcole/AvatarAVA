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
  /** Deepgram Aura voice for the host, e.g. "aura-2-orpheus-en". Also the backup when ElevenLabs is on. */
  voice: z.string().default("aura-2-orpheus-en"),
  /** ElevenLabs voice ID for the host; used when ELEVENLABS_API_KEY is set. Default: "Brian". */
  elevenLabsVoiceId: z.string().default("nPczCjzI2devNBz1zQrb"),
  language: z.string().default("en"),
  /** Who writes the answers: "claude" (default) or "genesys" (a Genesys AVA, with Claude as backup). */
  brain: z.enum(["claude", "genesys"]).default("claude"),
  /** Genesys Web Messaging deployment that reaches the AVA; used when brain is "genesys". */
  genesys: z
    .object({
      /** Org region domain, e.g. "mypurecloud.com" or "usw2.pure.cloud". */
      region: z.string().default(""),
      deploymentId: z.string().default(""),
      /** Origin header to send when the deployment restricts domains, e.g. "https://booth.example.com". */
      origin: z.string().default(""),
      /** Claude answers the turn if the AVA has not started answering by then. */
      replyTimeoutMs: z.number().int().positive().default(7000),
      /** The AVA's reply counts as finished after this long with no new message. */
      quietMs: z.number().int().positive().default(800),
      /** true: hold each question until the safety classifier passes it (adds 1-3 s). */
      waitForScreening: z.boolean().default(false),
      /** Sent when a visitor taps Start so the bot's welcome message is out of the way; "" turns it off. */
      warmUpText: z.string().default("Hello"),
    })
    .default({
      region: "",
      deploymentId: "",
      origin: "",
      replyTimeoutMs: 7000,
      quietMs: 800,
      waitForScreening: false,
      warmUpText: "Hello",
    }),
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
  /** ELEVENLABS_API_KEY: when set, the host speaks with ElevenLabs and Deepgram is the backup. */
  elevenLabsApiKey?: string;
  /** ELEVENLABS_VOICE_ID, an override for the show's elevenLabsVoiceId. */
  elevenLabsVoiceId?: string;
  elevenLabsModel: string;
  /** AVA_BRAIN: overrides the show's brain ("claude" or "genesys"). */
  brain?: "claude" | "genesys";
  /** GENESYS_REGION and GENESYS_DEPLOYMENT_ID: override the show's genesys settings. */
  genesysRegion?: string;
  genesysDeploymentId?: string;
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
  const brain = env.AVA_BRAIN?.toLowerCase() || undefined;
  if (brain && brain !== "claude" && brain !== "genesys") {
    throw new Error(`AVA_BRAIN must be claude or genesys (got "${env.AVA_BRAIN}")`);
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
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || undefined,
    elevenLabsModel: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    brain: brain as Env["brain"],
    genesysRegion: env.GENESYS_REGION || undefined,
    genesysDeploymentId: env.GENESYS_DEPLOYMENT_ID || undefined,
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

/**
 * The Genesys settings to use, or null when the show answers with Claude.
 * Environment variables win over show.json.
 */
export function pickGenesys(env: Env, show: Pick<ShowConfig, "brain" | "genesys">): ShowConfig["genesys"] | null {
  if ((env.brain ?? show.brain) !== "genesys") return null;
  const settings = {
    ...show.genesys,
    region: env.genesysRegion || show.genesys.region,
    deploymentId: env.genesysDeploymentId || show.genesys.deploymentId,
  };
  if (!settings.region || !settings.deploymentId) {
    throw new Error(
      'The Genesys brain needs a region and deploymentId: set "genesys" in show.json or GENESYS_REGION and GENESYS_DEPLOYMENT_ID.',
    );
  }
  return settings;
}
