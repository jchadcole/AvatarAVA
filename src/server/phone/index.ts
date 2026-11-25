/**
 * Ava on the phone. A Genesys Cloud number's call flow hands the call to this
 * server through the Audio Connector; Ava answers with the same brain (the
 * Genesys AVA, Claude as backup), guardrails and voices as the kiosk. There is
 * no face: the caller only hears her.
 *
 * Start it with `npm run phone`. The kiosk (`npm start`) is unchanged and can
 * run at the same time on its own port.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { WebSocketServer } from "ws";
import { ClaudeBrain, type Brain } from "../brain.ts";
import { loadShow, pickGenesys, readEnv } from "../config.ts";
import { Conversation, warmLines } from "../conversation.ts";
import { FallbackBrain, GenesysBrain, webMessagingUrl } from "../genesys.ts";
import { InputClassifier } from "../guardrails.ts";
import { InsightHub } from "../insights.ts";
import { SourceMatcher } from "../sources.ts";
import { TranscriptLog } from "../transcriptLog.ts";
import { DeepgramTts, ElevenLabsTts, elevenLabsPlanCheck, FallbackTts, type Tts } from "../voice.ts";
import { apiKeyMatches, AudioConnectorSession } from "./audioConnector.ts";
import { PhoneCall } from "./call.ts";
import { DeepgramCallStt } from "./listener.ts";
import { loadPhoneShow } from "./phoneShow.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const env = readEnv();
const port = Number(process.env.PHONE_PORT ?? 3100);
const showsDir = path.join(root, "shows");
const { show, phone } = loadPhoneShow(showsDir, env.showName, loadShow(showsDir, env.showName));

if (!env.deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required for speech-to-text and text-to-speech.");
const apiKey = process.env.AUDIO_CONNECTOR_API_KEY || "";
const allowNoKey = (process.env.PHONE_ALLOW_NO_KEY ?? "").toLowerCase() === "true";
if (!apiKey && !allowNoKey) {
  throw new Error(
    "AUDIO_CONNECTOR_API_KEY is required: make up a long random value, put it in .env, and enter the same value as the API key in the Genesys Audio Connector integration.",
  );
}
/** Optional: only these caller numbers reach Ava (digits only, compared on the last 10). */
const allowedCallers = (process.env.PHONE_ALLOWED_CALLERS ?? "")
  .split(",")
  .map((n) => n.replace(/\D/g, "").slice(-10))
  .filter(Boolean);

const client = new Anthropic({ apiKey: process.env.AVA_ANTHROPIC_API_KEY || undefined });
const claude = new ClaudeBrain(client, env.claudeModel, env.claudeEffort, show);
const genesys = pickGenesys(env, show);
/** A Genesys AVA keeps one chat per conversation, so each call gets its own. */
const makeBrain = (): Brain =>
  genesys
    ? new FallbackBrain(new GenesysBrain({ ...genesys, origin: genesys.origin || undefined }), claude, "Claude")
    : claude;
console.log(
  genesys
    ? `BRAIN: Genesys AVA via ${webMessagingUrl(genesys.region, genesys.deploymentId)}, Claude answers if it fails or takes over ${genesys.replyTimeoutMs} ms.`
    : `BRAIN: Claude ${env.claudeModel}, not the Genesys AVA (shows/${env.showName}/show.json "brain" is "${show.brain}").`,
);
const classifier = new InputClassifier(client, env.classifierModel, show.about || `${show.company}: its company, products, demos and the event`);
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
const stt = new DeepgramCallStt(env.deepgramApiKey, env.deepgramSttModel, show.language, phone.endpointingMs);
const log = new TranscriptLog(path.resolve(root, env.logDir));
const insights = new InsightHub();
const sources = new SourceMatcher(show.knowledgeFiles);
const lineAudio = new Map<string, Promise<Buffer>>();
void warmLines(show, tts, lineAudio).then(async () => {
  const goodbye = await lineAudio.get(show.cannedLines.goodbye)?.catch(() => undefined);
  if (fallbackTts && goodbye && fallbackTts.voiceOf(goodbye) !== "ElevenLabs") {
    console.warn(`VOICE CHECK FAILED: ElevenLabs did not voice the fixed lines, so callers will hear the Deepgram backup. Reason: ${fallbackTts.lastError ?? "unknown"}`);
  } else console.log(`VOICE CHECK: ${fallbackTts ? "ElevenLabs is working" : `Deepgram ${deepgramVoice}`}.`);
});
const voiceLine = (text: string): Promise<Buffer> => {
  let audio = lineAudio.get(text);
  if (!audio) {
    audio = tts.synthesize(text);
    audio.catch(() => lineAudio.delete(text));
    lineAudio.set(text, audio);
  }
  return audio;
};

/** Last four digits of the caller's number, enough to tell calls apart in the logs. */
const maskCaller = (ani?: string) => (ani ? `…${ani.replace(/\D/g, "").slice(-4)}` : "unknown");

const app = express();
// The backstage screen works for calls too: open it while you're on the phone with Ava.
app.use(express.static(path.join(root, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, show: show.id, brain: genesys ? "genesys" : "claude", voice: voiceName }));

const server = http.createServer(app);
const calls = new WebSocketServer({ noServer: true, maxPayload: 65536 });
const backstage = new WebSocketServer({ noServer: true });
let activeCalls = 0;

server.on("upgrade", (req, socket, head) => {
  const route = new URL(req.url ?? "/", "http://phone").pathname;
  if (route === "/backstage-ws") {
    backstage.handleUpgrade(req, socket, head, (ws) => backstage.emit("connection", ws, req));
    return;
  }
  // Genesys appends the Connector ID set in the call flow, so accept anything under /audio-connector.
  if (route !== "/audio-connector" && !route.startsWith("/audio-connector/")) {
    socket.destroy();
    return;
  }
  if (apiKey && !apiKeyMatches(req.headers["x-api-key"], apiKey)) {
    console.warn(`PHONE: refused a connection with a missing or wrong X-API-KEY from ${req.socket.remoteAddress}.`);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  calls.handleUpgrade(req, socket, head, (ws) => calls.emit("connection", ws, req));
});

backstage.on("connection", (socket) => {
  const unsubscribe = insights.subscribe((insight) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(insight));
  });
  socket.on("close", unsubscribe);
});

calls.on("connection", (ws, req) => {
  const sessionHeader = req.headers["audiohook-session-id"];
  const sessionId = (Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader) ?? randomUUID();
  new AudioConnectorSession(ws, sessionId, (params, line) => {
    const caller = maskCaller(params.participant?.ani);
    const digits = (params.participant?.ani ?? "").replace(/\D/g, "").slice(-10);
    if (allowedCallers.length && !allowedCallers.includes(digits)) {
      console.warn(`PHONE: call from ${caller} is not in PHONE_ALLOWED_CALLERS; hanging up.`);
      return null;
    }
    const label = `call from ${caller}`;
    const startedAt = Date.now();
    activeCalls++;
    console.log(`PHONE: ${label} connected (${activeCalls} on the line now).`);
    const call = new PhoneCall({
      makeConversation: (send) => {
        const conversation = new Conversation({
          show,
          brain: makeBrain(),
          classifier,
          tts,
          log,
          send,
          kioskId: `phone ${caller}`,
          lineAudio,
          insight: (insight) => insights.publish(insight),
          sources,
        });
        // Open the AVA's chat and voice its welcome straight away: there's no face to wait for.
        conversation.prepareVisit();
        return conversation;
      },
      stt,
      keyterms: show.keyterms,
      line,
      settings: phone,
      voiceLine,
      goodbye: show.cannedLines.goodbye,
      label,
    });
    return {
      start: () => call.start(),
      audio: (mulaw) => call.audio(mulaw),
      close: () => {
        call.close();
        activeCalls--;
        console.log(`PHONE: ${label} ended after ${Math.round((Date.now() - startedAt) / 1000)} s.`);
      },
    };
  });
});

server.listen(port, () => {
  console.log(`${show.avatarName} phone line for ${show.eventName}: Audio Connector endpoint on ws://localhost:${port}/audio-connector`);
  console.log(`Backstage screen on http://localhost:${port}/backstage.html`);
  console.log(`VOICE: ${voiceName}. Barge-in ${phone.bargeIn ? "on" : "off"}, calls end after ${phone.maxCallMinutes} minutes.`);
  if (!apiKey) console.warn("PHONE: PHONE_ALLOW_NO_KEY=true, so anyone who finds this address can connect. Use it for local tests only.");
  if (allowedCallers.length) console.log(`PHONE: only ${allowedCallers.length} allowed caller number(s) can reach Ava.`);
});
