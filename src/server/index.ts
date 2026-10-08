import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { WebSocketServer } from "ws";
import { ClaudeBrain } from "./brain.ts";
import { loadShow, pickAvatarId, readEnv } from "./config.ts";
import { Conversation, type ServerMessage } from "./conversation.ts";
import { InputClassifier } from "./guardrails.ts";
import { createLiteSessionToken } from "./liveavatar.ts";
import { TranscriptLog } from "./transcriptLog.ts";
import { DeepgramStt, DeepgramTts } from "./voice.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = readEnv();
const show = loadShow(path.join(root, "shows"), env.showName);

if (!env.deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required for speech-to-text and text-to-speech.");
if (!env.liveAvatarApiKey) throw new Error("LIVEAVATAR_API_KEY is required to start avatar sessions.");
const avatarId = pickAvatarId(env, show);

// AVA_ANTHROPIC_API_KEY works where the host reserves ANTHROPIC_API_KEY for itself
// (Claude cloud environments do); otherwise the SDK reads ANTHROPIC_API_KEY.
const client = new Anthropic({ apiKey: process.env.AVA_ANTHROPIC_API_KEY || undefined });
const brain = new ClaudeBrain(client, env.claudeModel, env.claudeEffort, show);
const classifier = new InputClassifier(client, env.classifierModel);
const tts = new DeepgramTts(env.deepgramApiKey, env.deepgramTtsModel || show.voice);
const stt = new DeepgramStt(env.deepgramApiKey, env.deepgramSttModel, show.language);
const log = new TranscriptLog(path.resolve(root, env.logDir));

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, "public")));

app.get("/api/show", (_req, res) => {
  res.json({
    company: show.company,
    avatarName: show.avatarName,
    eventName: show.eventName,
    suggestedQuestions: show.suggestedQuestions,
    sandbox: env.liveAvatarSandbox,
  });
});

app.post("/api/session", async (_req, res) => {
  try {
    const { sessionToken } = await createLiteSessionToken({
      apiKey: env.liveAvatarApiKey!,
      avatarId,
      sandbox: env.liveAvatarSandbox,
      quality: env.liveAvatarVideoQuality,
    });
    res.json({ sessionToken });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not start the avatar session." });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** Messages the kiosk page sends. Binary frames are PCM16 16 kHz mic audio. */
type ClientMessage =
  | { type: "start_visit" }
  | { type: "ptt_start" }
  | { type: "ptt_end" }
  | { type: "ask"; text: string }
  | { type: "staff_reset" };

wss.on("connection", (socket) => {
  const send = (message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };
  const conversation = new Conversation({ show, brain, classifier, tts, stt, log, send, kioskId: env.kioskId });

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
      case "start_visit":
        void conversation.greet();
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
  console.log(`LiveAvatar ${env.liveAvatarSandbox ? "SANDBOX (free, ~1 minute sessions)" : "LIVE"} mode, avatar ${avatarId}, voice ${env.deepgramTtsModel || show.voice}, model ${env.claudeModel}`);
});
