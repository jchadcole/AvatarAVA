import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";

type ServerMessage =
  | { type: "say"; text: string; audio: string }
  | { type: "interrupt" }
  | { type: "state"; state: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "caption"; role: "visitor" | "avatar"; text: string }
  | { type: "end_visit"; reason: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("avatar");
const attract = $("attract");
const startButton = $<HTMLButtonElement>("start");
const talkButton = $<HTMLButtonElement>("talk");
const statusLine = $("status");
const captions = $("captions");
const suggestions = $("suggestions");
const sandboxBadge = $("sandbox");

let session: LiveAvatarSession | null = null;
let socket: WebSocket;
let mic: { context: AudioContext; stop(): void } | null = null;
let talking = false;

// ---- Server connection -------------------------------------------------

function connect(): void {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.binaryType = "arraybuffer";
  socket.onmessage = (event) => handle(JSON.parse(event.data) as ServerMessage);
  socket.onclose = () => setTimeout(connect, 2000);
}

function send(message: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "say":
      session?.repeatAudio(message.audio);
      break;
    case "interrupt":
      session?.interrupt();
      break;
    case "state":
      statusLine.textContent = {
        idle: "Hold the button and ask me anything",
        listening: "Listening…",
        thinking: "Thinking…",
        speaking: "",
      }[message.state];
      break;
    case "caption":
      showCaption(message.role, message.text);
      break;
    case "end_visit":
      // Let the goodbye line finish before the avatar leaves.
      setTimeout(() => void endVisit(), message.reason === "staff" ? 0 : 4000);
      break;
  }
}

function showCaption(role: "visitor" | "avatar", text: string): void {
  const line = document.createElement("p");
  line.className = role;
  line.textContent = text;
  captions.append(line);
  while (captions.children.length > 4) captions.firstElementChild?.remove();
}

// ---- Avatar session ----------------------------------------------------

async function startVisit(): Promise<void> {
  startButton.disabled = true;
  statusLine.textContent = "Starting…";
  try {
    const res = await fetch("/api/session", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    const { sessionToken } = await res.json();
    // Mic audio goes to our server for speech-to-text, not into the avatar room.
    session = new LiveAvatarSession(sessionToken, { autoKeepAlive: true, voiceChat: { defaultMuted: true } });
    session.on(SessionEvent.SESSION_STREAM_READY, () => session?.attach(video));
    session.on(SessionEvent.SESSION_DISCONNECTED, () => void endVisit());
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
      if (!talking) statusLine.textContent = "Hold the button and ask me anything";
    });
    await session.start();
    document.body.classList.add("in-visit");
    send({ type: "start_visit" });
  } catch (err) {
    console.error(err);
    statusLine.textContent = "The avatar is taking a break. Please ask a booth teammate.";
    session = null;
  } finally {
    startButton.disabled = false;
  }
}

async function endVisit(): Promise<void> {
  const ending = session;
  session = null;
  document.body.classList.remove("in-visit");
  captions.replaceChildren();
  statusLine.textContent = "";
  await ending?.stop().catch(() => {});
}

// ---- Push-to-talk microphone -------------------------------------------

const workletSource = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("capture", Capture);
`;

async function openMic(): Promise<{ context: AudioContext; stop(): void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  // A 16 kHz context makes the browser resample for us.
  const context = new AudioContext({ sampleRate: 16000 });
  await context.audioWorklet.addModule(URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" })));
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "capture");
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!talking || socket.readyState !== WebSocket.OPEN) return;
    const samples = event.data;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
    socket.send(pcm.buffer);
  };
  source.connect(node);
  return { context, stop: () => stream.getTracks().forEach((t) => t.stop()) };
}

async function pressTalk(): Promise<void> {
  if (!session || talking) return;
  mic ??= await openMic();
  await mic.context.resume();
  talking = true;
  talkButton.classList.add("active");
  send({ type: "ptt_start" });
}

function releaseTalk(): void {
  if (!talking) return;
  talking = false;
  talkButton.classList.remove("active");
  send({ type: "ptt_end" });
}

// ---- Wiring ------------------------------------------------------------

startButton.addEventListener("click", () => void startVisit());
talkButton.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  void pressTalk();
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) talkButton.addEventListener(ev, releaseTalk);
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat) void pressTalk();
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") releaseTalk();
});

// Staff reset: tap the top-left corner three times within two seconds.
let cornerTaps: number[] = [];
$("staff-corner").addEventListener("click", () => {
  const now = Date.now();
  cornerTaps = [...cornerTaps.filter((t) => now - t < 2000), now];
  if (cornerTaps.length >= 3) {
    cornerTaps = [];
    send({ type: "staff_reset" });
  }
});

async function init(): Promise<void> {
  const showInfo = await (await fetch("/api/show")).json();
  document.title = `${showInfo.avatarName} · ${showInfo.company}`;
  $("attract-title").textContent = `Meet ${showInfo.avatarName}`;
  $("attract-sub").textContent = `${showInfo.company}'s digital host. Tap to start a conversation.`;
  sandboxBadge.hidden = !showInfo.sandbox;
  for (const question of showInfo.suggestedQuestions as string[]) {
    const button = document.createElement("button");
    button.textContent = question;
    button.addEventListener("click", () => send({ type: "ask", text: question }));
    suggestions.append(button);
  }
  attract.hidden = false;
  connect();
}

void init();
