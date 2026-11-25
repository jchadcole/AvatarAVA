import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { WebSocketServer } from "ws";
import { ClaudeBrain, type Brain } from "./brain.ts";
import { loadScreen, loadShow, pickGenesys, pickRenderer, readEnv } from "./config.ts";
import { Conversation, warmLines, type ServerMessage } from "./conversation.ts";
import { FallbackBrain, GenesysBrain, webMessagingUrl } from "./genesys.ts";
import { InputClassifier } from "./guardrails.ts";
import { InsightHub } from "./insights.ts";
import { createAnamSessionToken } from "./anam.ts";
import { createLiteSessionToken } from "./liveavatar.ts";
import { SourceMatcher } from "./sources.ts";
import { TranscriptLog } from "./transcriptLog.ts";
import { DeepgramStt, DeepgramTts, ElevenLabsTts, elevenLabsPlanCheck, FallbackTts, type Tts } from "./voice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = readEnv();
const show = loadShow(path.join(root, "shows"), env.showName);

if (!env.deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required for speech-to-text and text-to-speech.");
const { renderer, avatarId } = pickRenderer(env, show);
/** LiveAvatar's sandbox and prewarm settings only apply to the LiveAvatar face. */
const sandbox = renderer === "liveavatar" && env.liveAvatarSandbox;
const prewarm = renderer === "liveavatar" && env.liveAvatarPrewarm;

// AVA_ANTHROPIC_API_KEY works where the host reserves ANTHROPIC_API_KEY for itself
// (Claude cloud environments do); otherwise the SDK reads ANTHROPIC_API_KEY.
const client = new Anthropic({ apiKey: process.env.AVA_ANTHROPIC_API_KEY || undefined });
const claude = new ClaudeBrain(client, env.claudeModel, env.claudeEffort, show);
const genesys = pickGenesys(env, show);
/** Claude is shared by every kiosk; a Genesys AVA keeps one chat per kiosk, so each kiosk gets its own. */
const makeBrain = (): Brain =>
  genesys
    ? new FallbackBrain(
        new GenesysBrain({ ...genesys, origin: genesys.origin || undefined }),
        claude,
        "Claude",
      )
    : claude;
console.log(
  genesys
    ? `BRAIN: Genesys AVA via ${webMessagingUrl(genesys.region, genesys.deploymentId)}, Claude answers if it fails or takes over ${genesys.replyTimeoutMs} ms.`
    : `BRAIN: Claude ${env.claudeModel}, not the Genesys AVA. shows/${env.showName}/show.json has "brain": "${show.brain}"${env.brain ? ` and .env has AVA_BRAIN=${env.brain}` : ""}; set it to "genesys" and restart to use the AVA.`,
);
const classifier = new InputClassifier(
  client,
  env.classifierModel,
  show.about || `${show.company}: its company, products, demos and the event`,
);
const deepgramVoice = env.deepgramTtsModel || show.voice;
const elevenLabsVoice = env.elevenLabsVoiceId || show.elevenLabsVoiceId;
const deepgramTts = new DeepgramTts(env.deepgramApiKey, deepgramVoice);
const fallbackTts = env.elevenLabsApiKey
  ? new FallbackTts(new ElevenLabsTts(env.elevenLabsApiKey, elevenLabsVoice, env.elevenLabsModel), deepgramTts, {
      primaryName: "ElevenLabs",
      backupName: "Deepgram",
    })
  : null;
const tts: Tts = fallbackTts ?? deepgramTts;
const voiceName = fallbackTts
  ? `ElevenLabs ${elevenLabsVoice} (${env.elevenLabsModel}), Deepgram ${deepgramVoice} as backup`
  : `Deepgram ${deepgramVoice} only (no ELEVENLABS_API_KEY)`;
if (env.elevenLabsApiKey) {
  void elevenLabsPlanCheck(env.elevenLabsApiKey).then(({ ok, message }) => (ok ? console.log(message) : console.warn(message)));
}
const stt = new DeepgramStt(env.deepgramApiKey, env.deepgramSttModel, show.language);
const log = new TranscriptLog(path.resolve(root, env.logDir));
const insights = new InsightHub();
const sources = new SourceMatcher(show.knowledgeFiles);
const lineAudio = new Map<string, Promise<Buffer>>();
void warmLines(show, tts, lineAudio).then(async () => {
  // Startup voice check: the greeting was just voiced, so say plainly which voice did it.
  const greeting = await lineAudio.get(show.greeting)?.catch(() => undefined);
  if (!fallbackTts) {
    console.log(`VOICE CHECK: Deepgram ${deepgramVoice}. Add ELEVENLABS_API_KEY to .env for the ElevenLabs voice.`);
  } else if (greeting && fallbackTts.voiceOf(greeting) === "ElevenLabs") {
    console.log(`VOICE CHECK: ElevenLabs is working (voice ${elevenLabsVoice}, ${env.elevenLabsModel}).`);
  } else {
    console.warn(
      `VOICE CHECK FAILED: ElevenLabs did not voice the greeting, so you will hear the Deepgram backup. Reason: ${fallbackTts.lastError ?? "unknown"}`,
    );
  }
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, "public")));
// Logos and other images for the kiosk header live in shows/<show>/assets/.
app.use("/show-assets", express.static(path.join(root, "shows", env.showName, "assets")));

/** Last screen settings that loaded cleanly; a typo in show.json keeps these. */
let screen = show.screen;

app.get("/api/show", (_req, res) => {
  // Re-read the screen settings on every page load, so header and name edits need no restart.
  try {
    screen = loadScreen(path.join(root, "shows"), env.showName);
  } catch (err) {
    console.warn(`SCREEN: could not read the "screen" settings in shows/${env.showName}/show.json, keeping the last good ones. ${(err as Error).message}`);
  }
  res.json({
    company: show.company,
    avatarName: show.avatarName,
    eventName: show.eventName,
    // With the AVA, the buttons are its own quick replies, sent once it greets.
    suggestedQuestions: genesys ? [] : show.suggestedQuestions,
    screen: {
      ...screen,
      logo: screen.logo && !/^https?:\/\//.test(screen.logo) ? `/show-assets/${screen.logo}` : screen.logo,
    },
    sandbox,
    prewarm,
    renderer,
    voice: voiceName,
  });
});

// The kiosk page reports its own errors here so they show up in this Terminal window.
app.post("/api/kiosk-error", (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 2000) : "(no message)";
  console.error(`KIOSK ERROR (from the browser): ${message}`);
  res.status(204).end();
});

app.post("/api/session", async (_req, res) => {
  try {
    const { sessionToken } =
      renderer === "anam"
        ? await createAnamSessionToken({ apiKey: env.anamApiKey!, avatarId })
        : await createLiteSessionToken({
            apiKey: env.liveAvatarApiKey!,
            avatarId,
            sandbox: env.liveAvatarSandbox,
            quality: env.liveAvatarVideoQuality,
          });
    res.json({ renderer, sessionToken });
  } catch (err) {
    console.error(`FACE ERROR: could not get a ${renderer} session. ${(err as Error).message}`);
    res.status(502).json({ error: "Could not start the avatar session.", detail: (err as Error).message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const backstage = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const route = new URL(req.url ?? "/", "http://kiosk").pathname;
  const target = route === "/ws" ? wss : route === "/backstage-ws" ? backstage : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

// The backstage screen only listens; it never sends anything that changes the kiosk.
backstage.on("connection", (socket) => {
  const unsubscribe = insights.subscribe((insight) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(insight));
  });
  socket.on("close", unsubscribe);
});

/** Messages the kiosk page sends. Binary frames are PCM16 16 kHz mic audio. */
type ClientMessage =
  | { type: "visit_starting" }
  | { type: "visit_cancelled" }
  | { type: "start_visit"; faceMs?: number }
  | { type: "ptt_start" }
  | { type: "ptt_end" }
  | { type: "ask"; text: string }
  | { type: "staff_reset" };

wss.on("connection", (socket) => {
  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const conversation = new Conversation({
    show,
    brain: makeBrain(),
    classifier,
    tts,
    stt,
    log,
    send,
    kioskId: env.kioskId,
    lineAudio,
    insight: (insight) => insights.publish(insight),
    sources,
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      conversation.pushAudio(data as Buffer);
      return;
    }
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (message.type) {
      case "visit_starting":
        conversation.prepareVisit();
        break;
      case "visit_cancelled":
        conversation.cancelVisit();
        break;
      case "start_visit":
        void conversation.greet(typeof message.faceMs === "number" ? message.faceMs : undefined);
        break;
      case "ptt_start":
        conversation.startListening();
        break;
      case "ptt_end":
        void conversation.stopListening();
        break;
      case "ask":
        if (typeof message.text === "string") void conversation.handleVisitor(message.text);
        break;
      case "staff_reset":
        conversation.endVisit("staff");
        break;
    }
  });
  socket.on("close", () => conversation.dispose());
});

server.listen(env.port, () => {
  console.log(`${show.avatarName} kiosk for ${show.eventName} on http://localhost:${env.port}`);
  console.log(`Backstage screen on http://localhost:${env.port}/backstage.html`);
  const face =
    renderer === "anam"
      ? `FACE: Anam (audio passthrough), avatar ${avatarId}`
      : `FACE: LiveAvatar ${env.liveAvatarSandbox ? "SANDBOX (free, ~1 minute sessions)" : "LIVE"} mode, avatar ${avatarId}${prewarm ? ", kept warm between visits" : ""}`;
  console.log(`${face}, voice ${voiceName}, model ${env.claudeModel}`);
});
