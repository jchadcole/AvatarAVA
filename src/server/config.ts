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

/** A text box inside the scene picture, in percent of the picture's width and height. */
const SceneBox = z.object({
  left: z.number().min(0).max(100),
  top: z.number().min(0).max(100),
  width: z.number().min(1).max(100),
  height: z.number().min(1).max(100),
});

/**
 * The animated sound wave in the scene. Its box is in percent of the picture; bar
 * heights are fractions of the box's height, and spacing and barWidth fractions of
 * its width. The defaults sit on the wave in the built-in picture, whose own bars
 * were painted out.
 */
const SceneWave = z.object({
  /** false: no animated wave (use with a picture that keeps its own bars). */
  enabled: z.boolean().default(true),
  left: z.number().min(0).max(100).default(52.45),
  top: z.number().min(0).max(100).default(59.26),
  width: z.number().min(1).max(100).default(9.81),
  height: z.number().min(1).max(100).default(20),
  /** Resting height of each bar, left to right. */
  bars: z.array(z.number().min(0).max(1)).min(1).default([0.088, 0.176, 0.333, 0.245, 0.495, 0.296, 0.269, 0.185, 0.088]),
  spacing: z.number().positive().default(0.0936),
  barWidth: z.number().positive().default(0.042),
  color: z.string().default("#ffffff"),
  glowColor: z.string().default("#4d9fff"),
});

/**
 * The robot's mouth, drawn over the picture: a recessed speaker slot with a row
 * of light segments that blink with each syllable while AVA speaks. Its box is in
 * percent of the picture; the mouth is centered in it.
 */
const SceneMouth = z.object({
  /** false: no mouth (use with a picture that already has one). */
  enabled: z.boolean().default(true),
  left: z.number().min(0).max(100).default(14.61),
  top: z.number().min(0).max(100).default(51.39),
  width: z.number().min(1).max(100).default(5.74),
  height: z.number().min(1).max(100).default(6.94),
  /** Mouth width as a share of the box's width (the rest leaves room for the glow). */
  size: z.number().min(0.1).max(1).default(0.6),
  /** The segments' light when lit, and the glow around them (and their color when dim). */
  color: z.string().default("#fff4e6"),
  glowColor: z.string().default("#ffd08a"),
});

/**
 * The "image" renderer: one landscape picture, full screen, with the AVA's words
 * typing into one speech bubble and the visitor's into another. The defaults fit
 * the built-in picture (public/ava-scene.jpg, a robot, an agent and a caller).
 */
const SceneScreen = z.object({
  /** The picture: "" for the built-in one, a file in shows/<show>/assets/, a path under public/ ("/..."), or an https URL. Bubbles must be empty. */
  image: z.string().default(""),
  /** Width / height of the picture, so the text boxes stay on the bubbles at any screen size. */
  aspectRatio: z.number().positive().default(1916 / 1080),
  /** The blank part of the AVA's bubble, where its words type out. */
  avaBox: SceneBox.default({ left: 18.4, top: 15.0, width: 24.4, height: 20.2 }),
  /** The blank part of the caller's bubble, where the visitor's words type out. */
  callerBox: SceneBox.default({ left: 70.0, top: 16.3, width: 22.8, height: 9.2 }),
  /** Largest text size in the bubbles, in percent of the picture's width; longer text shrinks to fit. */
  fontSize: z.number().positive().default(1.75),
  /** Text color in the AVA's bubble and in the caller's bubble. */
  avaColor: z.string().default("#14213d"),
  callerColor: z.string().default("#14213d"),
  /** What the AVA's bubble says before a visit starts. "" leaves it empty. */
  idleText: z.string().default("Hi! Tap Start and ask me anything."),
  /** The glowing sound wave drawn over the picture, moving with the voice and the visitor's mic. */
  wave: SceneWave.default(SceneWave.parse({})),
  /** The robot's light mouth, which glows while AVA speaks. */
  mouth: SceneMouth.default(SceneMouth.parse({})),
});

/** What the kiosk screen shows above the avatar. Text may use {{avatarName}}, {{company}} and {{eventName}}. */
const KioskScreen = z.object({
  /** Big line at the top, e.g. "Meet {{avatarName}}". */
  headline: z.string().default("Meet {{avatarName}}"),
  /** Words in the headline drawn in the accent color, e.g. "{{avatarName}}". "" colors nothing. */
  accentText: z.string().default("{{avatarName}}"),
  /** Accent color for the highlighted words, the listening light and buttons. */
  accentColor: z.string().default("#ff4f1f"),
  /** Color of the sound wave under the transcript. */
  waveColor: z.string().default("#5468ff"),
  /** Page background behind the header and avatar. */
  backgroundColor: z.string().default("#0b1626"),
  /** Logo above the headline: a file in shows/<show>/assets/ (e.g. "logo.svg") or an https URL. */
  logo: z.string().default(""),
  /** Text shown in place of the logo when there is no logo image. "" shows nothing. */
  logoText: z.string().default(""),
  /** How the avatar video fills its frame: "cover" crops the sides to fill it, "contain" shows the whole video. */
  videoFit: z.enum(["cover", "contain"]).default("cover"),
  /** Share of the height under the header given to the avatar (0.3 to 0.8); the transcript gets the rest. */
  avatarShare: z.number().min(0.3).max(0.8).default(0.6),
  /** Name shown on the avatar's lines in the transcript. */
  avaName: z.string().default("{{avatarName}}"),
  /** Name shown on the visitor's lines in the transcript. */
  visitorName: z.string().default("You"),
  /** Smaller line under the headline. "" hides it. */
  subtitle: z.string().default(""),
  /** The landscape picture used when the renderer is "image", and where its two speech bubbles are. */
  scene: SceneScreen.default(SceneScreen.parse({})),
});

const ShowFile = z.object({
  id: z.string(),
  eventName: z.string(),
  company: z.string(),
  avatarName: z.string(),
  /** LiveAvatar avatar for this show (from the LiveAvatar dashboard). Ignored in sandbox mode. */
  avatarId: z.string().optional(),
  /**
   * Which face shows the host: "liveavatar" (default) or "anam", hosted faces that
   * lip-sync to our own voice, or "image": no face, just the scene picture with the
   * conversation typing into its speech bubbles (see screen.scene).
   */
  renderer: z.enum(["liveavatar", "anam", "image"]).default("liveavatar"),
  /** Anam avatar for this show (from the Anam Lab), used when renderer is "anam". */
  anamAvatarId: z.string().optional(),
  /** Deepgram Aura voice for the host, e.g. "aura-2-orpheus-en". Also the backup when ElevenLabs is on. */
  voice: z.string().default("aura-2-orpheus-en"),
  /** ElevenLabs voice ID for the host; used when ELEVENLABS_API_KEY is set. Default: "Brian". */
  elevenLabsVoiceId: z.string().default("nPczCjzI2devNBz1zQrb"),
  language: z.string().default("en"),
  /** What the booth is about, for the safety classifier. Default: the company, its products, demos and the event. */
  about: z.string().optional(),
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
      replyTimeoutMs: z.number().int().positive().default(10000),
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
      replyTimeoutMs: 10000,
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
  screen: KioskScreen.default(KioskScreen.parse({})),
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
  const screen = Object.fromEntries(
    Object.entries(show.screen).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value]),
  ) as typeof show.screen;
  return {
    ...show,
    screen,
    persona: fill(fs.readFileSync(path.join(dir, "persona.md"), "utf8")),
    knowledge: joinKnowledge(knowledgeFiles),
    knowledgeFiles,
  };
}

export type KioskScreenConfig = z.infer<typeof KioskScreen>;

/**
 * Reads just the kiosk screen settings from shows/<name>/show.json, so edits to
 * the header and transcript names show up on the next page load without a restart.
 */
export function loadScreen(showsDir: string, name: string): KioskScreenConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(showsDir, name, "show.json"), "utf8"));
  const show = ShowFile.pick({ avatarName: true, company: true, eventName: true, screen: true }).parse(raw);
  const fill = (text: string) =>
    text
      .replaceAll("{{avatarName}}", show.avatarName)
      .replaceAll("{{company}}", show.company)
      .replaceAll("{{eventName}}", show.eventName);
  return Object.fromEntries(
    Object.entries(show.screen).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value]),
  ) as KioskScreenConfig;
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
  /** AVA_RENDERER: overrides the show's renderer ("liveavatar", "anam" or "image"). */
  renderer?: Renderer;
  anamApiKey?: string;
  /** ANAM_AVATAR_ID, an override for the show's anamAvatarId. */
  anamAvatarId?: string;
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
  /** GENESYS_REGION, GENESYS_DEPLOYMENT_ID and GENESYS_ORIGIN: override the show's genesys settings. */
  genesysRegion?: string;
  genesysDeploymentId?: string;
  genesysOrigin?: string;
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
  const renderer = env.AVA_RENDERER?.toLowerCase() || undefined;
  if (renderer && !RENDERERS.includes(renderer as Renderer)) {
    throw new Error(`AVA_RENDERER must be liveavatar, anam or image (got "${env.AVA_RENDERER}")`);
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
    renderer: renderer as Env["renderer"],
    anamApiKey: env.ANAM_API_KEY || undefined,
    anamAvatarId: env.ANAM_AVATAR_ID || undefined,
    deepgramApiKey: env.DEEPGRAM_API_KEY || undefined,
    deepgramSttModel: env.DEEPGRAM_STT_MODEL ?? "nova-3",
    deepgramTtsModel: env.DEEPGRAM_TTS_MODEL || undefined,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID || undefined,
    elevenLabsModel: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
    brain: brain as Env["brain"],
    genesysRegion: env.GENESYS_REGION || undefined,
    genesysDeploymentId: env.GENESYS_DEPLOYMENT_ID || undefined,
    genesysOrigin: env.GENESYS_ORIGIN || undefined,
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
    origin: env.genesysOrigin || show.genesys.origin,
  };
  if (!settings.region || !settings.deploymentId) {
    throw new Error(
      'The Genesys brain needs a region and deploymentId: set "genesys" in show.json or GENESYS_REGION and GENESYS_DEPLOYMENT_ID.',
    );
  }
  return settings;
}

export const RENDERERS = ["liveavatar", "anam", "image"] as const;
export type Renderer = (typeof RENDERERS)[number];

/** The face to use and its avatar ("" for the image scene). Environment variables win over show.json. */
export function pickRenderer(
  env: Env,
  show: Pick<ShowConfig, "renderer" | "avatarId" | "anamAvatarId">,
): { renderer: Renderer; avatarId: string } {
  const renderer = env.renderer ?? show.renderer;
  // The image scene has no face, so it needs no avatar service or key.
  if (renderer === "image") return { renderer, avatarId: "" };
  if (renderer === "anam") {
    if (!env.anamApiKey) throw new Error("ANAM_API_KEY is required when the renderer is anam.");
    const avatarId = env.anamAvatarId || show.anamAvatarId;
    if (!avatarId) throw new Error('The Anam face needs an avatar: set "anamAvatarId" in show.json or ANAM_AVATAR_ID.');
    return { renderer, avatarId };
  }
  if (!env.liveAvatarApiKey) throw new Error("LIVEAVATAR_API_KEY is required to start avatar sessions.");
  return { renderer, avatarId: pickAvatarId(env, show) };
}
