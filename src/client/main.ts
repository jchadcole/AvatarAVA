import { createFace, unlockAudio, voiceLevel, type Face, type Renderer } from "./faces.ts";

type ServerMessage =
  | { type: "say"; text: string; audio: string }
  | { type: "interrupt" }
  | { type: "state"; state: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "caption"; role: "visitor" | "avatar"; text: string }
  | { type: "caption_partial"; role: "visitor"; text: string }
  | { type: "suggestions"; items: string[] }
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
const wave = $<HTMLCanvasElement>("wave");
const attractStatus = $("attract-status");

interface ScreenConfig {
  headline: string;
  accentText: string;
  accentColor: string;
  waveColor: string;
  backgroundColor: string;
  logo: string;
  logoText: string;
  subtitle: string;
  videoFit: "cover" | "contain";
  avatarShare: number;
  avaName: string;
  visitorName: string;
  scene: SceneConfig;
}

interface SceneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The "image" renderer's picture and where its speech bubbles are (percent of the picture). */
interface SceneConfig {
  image: string;
  aspectRatio: number;
  avaBox: SceneBox;
  callerBox: SceneBox;
  fontSize: number;
  avaColor: string;
  callerColor: string;
  idleText: string;
  wave: SceneWave;
}

interface SceneWave extends SceneBox {
  enabled: boolean;
  bars: number[];
  spacing: number;
  barWidth: number;
  color: string;
  glowColor: string;
}

/** Names on the transcript lines, from show.json "screen". */
const speakerNames = { avatar: "Ava", visitor: "You" };

const IDLE_STATUS = "Hold to talk";

let session: Face | null = null;
/** With prewarm on, an avatar session already streaming, ready for the next visit. */
let spare: Face | null = null;
let warming: Promise<void> | null = null;
let prewarm = false;
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
      session?.say(message.audio);
      transcript.say(message.text, message.audio);
      break;
    case "interrupt":
      session?.interrupt();
      transcript.interrupt();
      break;
    case "state":
      if (message.state !== "speaking") session?.endTurn();
      document.body.dataset.state = message.state;
      if (message.state !== "listening") transcript.dropPartial();
      if (message.state === "listening") transcript.newReply();
      statusLine.textContent = {
        idle: IDLE_STATUS,
        listening: "Listening…",
        thinking: "Thinking…",
        speaking: "",
      }[message.state];
      break;
    case "caption":
      // Ava's lines are shown word by word from "say", in time with her voice.
      if (message.role === "visitor") transcript.visitor(message.text, true);
      break;
    case "caption_partial":
      transcript.visitor(message.text, false);
      break;
    case "suggestions":
      setSuggestions(message.items);
      break;
    case "end_visit":
      // Let the goodbye line finish before the avatar leaves.
      setTimeout(() => void endVisit(), message.reason === "staff" ? 0 : 4000);
      break;
  }
}

// ---- Live transcript ---------------------------------------------------

/**
 * The scrolling transcript under the avatar. The visitor's words appear as they
 * are recognized; Ava's words appear one by one, paced to the length of each
 * line's audio, so the text keeps up with her voice.
 */
/** What the kiosk does with the words: a scrolling chat (portrait) or two speech bubbles (image scene). */
interface TranscriptView {
  visitor(text: string, final: boolean): void;
  dropPartial(): void;
  newReply(): void;
  say(text: string, audio: string): void;
  interrupt(): void;
  clear(): void;
}

class Transcript implements TranscriptView {
  private partial: HTMLParagraphElement | null = null;
  private reply: HTMLParagraphElement | null = null;
  private queue: { words: string[]; msPerWord: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** The visitor's words so far (final = false) or their finished line. */
  visitor(text: string, final: boolean): void {
    if (!this.partial) {
      this.partial = this.line("visitor");
      this.reply = null;
    }
    this.partial.textContent = text;
    this.partial.classList.toggle("partial", !final);
    if (final) this.partial = null;
    this.scroll();
  }

  /** Removes words that were never confirmed (nothing was heard). */
  dropPartial(): void {
    this.partial?.parentElement?.remove();
    this.partial = null;
  }

  /** The next thing Ava says starts a new paragraph. */
  newReply(): void {
    this.flush();
    this.reply = null;
  }

  /** Queues one spoken line; audio is base64 PCM16 at 24 kHz mono. */
  say(text: string, audio: string): void {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    const ms = ((audio.length * 3) / 4 / 2 / 24000) * 1000;
    this.queue.push({ words, msPerWord: Math.min(600, ms / words.length) });
    if (!this.timer) this.next();
  }

  /** Ava was cut off: show the line she was on and drop what she never said. */
  interrupt(): void {
    this.flush(false);
  }

  clear(): void {
    this.flush(false);
    this.partial = null;
    this.reply = null;
    captions.replaceChildren();
  }

  /** Stops the word-by-word reveal; with showRest, writes out what is queued. */
  private flush(showRest = true): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const rest = this.queue.splice(0);
    if (showRest) for (const item of rest) item.words.forEach((w) => this.word(w));
    else if (rest[0]) rest[0].words.forEach((w) => this.word(w));
    this.scroll();
  }

  private next(): void {
    const item = this.queue[0];
    if (!item) {
      this.timer = null;
      return;
    }
    const word = item.words.shift();
    if (word) {
      this.word(word);
      this.scroll();
    }
    if (!item.words.length) this.queue.shift();
    this.timer = setTimeout(() => this.next(), item.msPerWord);
  }

  private word(word: string): void {
    this.reply ??= this.line("avatar");
    this.reply.textContent = this.reply.textContent ? `${this.reply.textContent} ${word}` : word;
  }

  /** Adds a chat message with the speaker's name; returns the element for its text. */
  private line(role: "visitor" | "avatar"): HTMLParagraphElement {
    const message = document.createElement("div");
    message.className = `message ${role}`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = speakerNames[role];
    const p = document.createElement("p");
    p.className = role;
    message.append(name, p);
    captions.append(message);
    // Keep the whole visit, but not without limit.
    while (captions.children.length > 60) captions.firstElementChild?.remove();
    return p;
  }

  private scroll(): void {
    captions.scrollTo({ top: captions.scrollHeight, behavior: "smooth" });
  }
}

// ---- Speech bubbles (image scene) -------------------------------------------

/**
 * Types text into one speech bubble, a character at a time, shrinking the font
 * so it stays inside the bubble.
 */
class Typer {
  private text: HTMLParagraphElement;
  /** Characters still to type, each with its delay. */
  private queue: { chars: string[]; msPerChar: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Live mode (the visitor): type toward this text, quickly, as it changes. */
  private target: string | null = null;

  constructor(private box: HTMLElement) {
    this.text = box.querySelector("p")!;
  }

  get shown(): string {
    return this.text.textContent ?? "";
  }

  /** Empties the bubble (or shows fixed text) and stops any typing. */
  reset(text = ""): void {
    this.stop();
    this.queue = [];
    this.target = null;
    this.text.textContent = text;
    this.fit(true);
  }

  /** Adds a line, typed over durationMs (the length of its audio). */
  append(line: string, durationMs: number): void {
    const chars = [...(this.shown || this.queue.length ? " " : "") + line];
    this.queue.push({ chars, msPerChar: Math.max(12, Math.min(70, durationMs / chars.length)) });
    this.run();
  }

  /** Types toward text, keeping what already matches (speech-to-text revises its guesses). */
  follow(text: string): void {
    const shown = this.shown;
    let same = 0;
    while (same < shown.length && same < text.length && shown[same] === text[same]) same++;
    if (same < shown.length) {
      this.text.textContent = shown.slice(0, same);
      this.fit(true);
    }
    this.target = text;
    this.run();
  }

  /** Writes out the current line at once; with all, everything queued too. */
  finish(all: boolean): void {
    this.stop();
    if (this.target !== null) this.text.textContent = this.target;
    const rest = all ? this.queue.splice(0) : this.queue.splice(0, 1);
    this.queue = [];
    this.text.textContent += rest.map((item) => item.chars.join("")).join("");
    this.target = null;
    this.fit(false);
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.box.classList.remove("typing");
  }

  private run(): void {
    if (this.timer) return;
    this.box.classList.add("typing");
    this.tick();
  }

  private tick(): void {
    let delay: number;
    if (this.target !== null) {
      const behind = this.target.length - this.shown.length;
      if (behind <= 0) return this.stop();
      // Catch up faster when the visitor is far ahead of the typing.
      const step = Math.max(1, Math.ceil(behind / 12));
      this.text.textContent = this.target.slice(0, this.shown.length + step);
      delay = 22;
    } else {
      const item = this.queue[0];
      if (!item) return this.stop();
      this.text.textContent += item.chars.shift() ?? "";
      if (!item.chars.length) this.queue.shift();
      delay = item.msPerChar;
    }
    this.fit(false);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
  }

  /** Shrinks the text until it fits the bubble (down to 45%); past that, the newest words stay in view. */
  private fit(fromTop: boolean): void {
    const box = this.box;
    let fit = fromTop ? 1 : Number(box.style.getPropertyValue("--fit") || 1);
    box.style.setProperty("--fit", String(fit));
    while (this.text.scrollHeight > box.clientHeight + 1 && fit > 0.45) {
      fit = Math.round((fit - 0.05) * 100) / 100;
      box.style.setProperty("--fit", String(fit));
    }
    box.classList.toggle("overflow", this.text.scrollHeight > box.clientHeight + 1);
  }
}

/**
 * The image scene's transcript: the AVA's words type into the robot's bubble in
 * time with its voice, and the visitor's into the caller's bubble as they are
 * heard. Each new turn replaces the bubble's text.
 */
class BubbleTranscript implements TranscriptView {
  private ava = new Typer($("ava-bubble"));
  private caller = new Typer($("caller-bubble"));
  /** The next AVA line starts a new reply, so it replaces the bubble's text. */
  private freshReply = true;
  /** The visitor is mid-utterance; partial is true until speech-to-text confirms it. */
  private visitorOpen = false;
  private partial = false;

  constructor(private idleText: string) {
    this.ava.reset(idleText);
  }

  visitor(text: string, final: boolean): void {
    if (!this.visitorOpen) {
      this.caller.reset();
      this.visitorOpen = true;
    }
    this.freshReply = true;
    this.partial = !final;
    $("caller-bubble").classList.toggle("partial", !final);
    this.caller.follow(text);
    if (final) this.visitorOpen = false;
  }

  dropPartial(): void {
    // Nothing was heard: take back the guesses.
    if (this.visitorOpen && this.partial) this.caller.reset();
    this.visitorOpen = false;
    this.partial = false;
    $("caller-bubble").classList.remove("partial");
  }

  newReply(): void {
    this.ava.finish(true);
    this.freshReply = true;
  }

  say(text: string, audio: string): void {
    if (!text.trim()) return;
    if (this.freshReply) {
      this.ava.reset();
      this.freshReply = false;
    }
    // Base64 PCM16 at 24 kHz mono: its length gives the line's duration.
    this.ava.append(text.trim(), ((audio.length * 3) / 4 / 2 / 24000) * 1000);
  }

  interrupt(): void {
    this.ava.finish(false);
  }

  clear(): void {
    this.ava.reset(this.idleText);
    this.caller.reset();
    this.freshReply = true;
    this.visitorOpen = false;
    this.partial = false;
  }
}

/** Sets up the landscape scene: the picture, the bubbles' places, and the controls bar. */
function showScene(scene: SceneConfig): void {
  document.body.classList.add("scene-mode");
  const frame = $("scene-frame");
  frame.style.setProperty("--scene-ar", String(scene.aspectRatio));
  frame.style.setProperty("--bubble-font", String(scene.fontSize));
  frame.style.setProperty("--ava-ink", scene.avaColor);
  frame.style.setProperty("--caller-ink", scene.callerColor);
  $<HTMLImageElement>("scene-image").src = scene.image;
  const place = (id: string, box: SceneBox) =>
    Object.assign($(id).style, {
      left: `${box.left}%`,
      top: `${box.top}%`,
      width: `${box.width}%`,
      height: `${box.height}%`,
    });
  place("ava-bubble", scene.avaBox);
  place("caller-bubble", scene.callerBox);
  if (scene.wave.enabled) {
    place("scene-wave", scene.wave);
    sceneWave = scene.wave;
  }
  frame.append($("panel"));
  $("scene").hidden = false;
}

let transcript: TranscriptView = new Transcript();

// ---- Sound wave --------------------------------------------------------

/** Mic loudness, 0..1, updated while the visitor holds the talk button. */
let micLevel = 0;
const levels: number[] = new Array(48).fill(0);

/** Draws the wave under the transcript: the mic while listening, a soft pulse while Ava talks. */
function drawWave(time: number): void {
  const ratio = window.devicePixelRatio || 1;
  const width = wave.clientWidth * ratio;
  const height = wave.clientHeight * ratio;
  if (wave.width !== width || wave.height !== height) {
    wave.width = width;
    wave.height = height;
  }
  const state = document.body.dataset.state;
  let level = 0;
  if (state === "listening") level = Math.min(1, micLevel * 6);
  else if (state === "speaking") level = 0.25 + 0.2 * Math.abs(Math.sin(time / 160) * Math.sin(time / 410));
  levels.push(level);
  levels.shift();

  const ctx = wave.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(wave).getPropertyValue("--wave").trim() || "#5468ff";
    const bar = width / levels.length;
    levels.forEach((value, i) => {
      // Taper the ends so the wave reads as a shape, not a bar chart.
      const taper = Math.sin((Math.PI * (i + 0.5)) / levels.length);
      const h = Math.max(ratio * 2, value * taper * height);
      ctx.fillRect(i * bar + bar * 0.2, (height - h) / 2, bar * 0.6, h);
    });
  }
  if (sceneWave) drawSceneWave(time, sceneWave);
  requestAnimationFrame(drawWave);
}

/** The image scene's wave, when it has one. */
let sceneWave: SceneWave | null = null;
/** Smoothed loudness driving the scene's wave, 0..1. */
let sceneLevel = 0;

/**
 * Draws the scene's glowing bars: calm and barely breathing when nobody talks,
 * jumping with the host's voice as it plays and with the visitor's microphone.
 */
function drawSceneWave(time: number, config: SceneWave): void {
  const canvas = $<HTMLCanvasElement>("scene-wave");
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const state = document.body.dataset.state;
  const voice = Math.min(1, voiceLevel() * 5);
  const mic = state === "listening" ? Math.min(1, micLevel * 6) : 0;
  const target = Math.max(voice, mic);
  // Rise fast, fall slowly, so the bars read as speech rather than flicker.
  sceneLevel += (target - sceneLevel) * (target > sceneLevel ? 0.45 : 0.12);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const n = config.bars.length;
  const barWidth = config.barWidth * width;
  const activity = Math.min(1, sceneLevel * 3);
  ctx.fillStyle = config.color;
  ctx.shadowColor = config.glowColor;
  ctx.shadowBlur = barWidth * 2.2;
  config.bars.forEach((rest, i) => {
    const calm = 1 + 0.05 * Math.sin(time / 700 + i * 0.9);
    // Each bar moves at its own pace, so the wave ripples instead of pumping as one block.
    const wobble = 0.5 + 0.5 * Math.sin(time / (85 + i * 23) + i * 1.7) * Math.sin(time / (210 + i * 31));
    const lively = 0.45 + sceneLevel * 1.5 * (0.55 + 0.75 * wobble);
    const scale = calm * (1 - activity) + lively * activity;
    const h = Math.min(height * 0.92, Math.max(barWidth, rest * height * scale));
    const x = width / 2 + (i - (n - 1) / 2) * config.spacing * width - barWidth / 2;
    const y = (height - h) / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, h, barWidth / 2);
    // Twice for a stronger glow, like the light in the picture.
    ctx.fill();
    ctx.fill();
  });
}

// ---- Header ------------------------------------------------------------

function showHeader(screen: ScreenConfig): void {
  const root = document.documentElement.style;
  root.setProperty("--accent", screen.accentColor);
  root.setProperty("--wave", screen.waveColor);
  root.setProperty("--bg", screen.backgroundColor);
  video.style.objectFit = screen.videoFit;
  root.setProperty("--avatar-share", String(screen.avatarShare));
  speakerNames.avatar = screen.avaName;
  speakerNames.visitor = screen.visitorName;

  const headline = $("headline");
  const at = screen.accentText ? screen.headline.indexOf(screen.accentText) : -1;
  if (at < 0) headline.textContent = screen.headline;
  else {
    const accent = document.createElement("span");
    accent.className = "accent";
    accent.textContent = screen.accentText;
    headline.replaceChildren(
      screen.headline.slice(0, at),
      accent,
      screen.headline.slice(at + screen.accentText.length),
    );
  }

  const subtitle = $("subtitle");
  subtitle.textContent = screen.subtitle;
  subtitle.hidden = !screen.subtitle;

  const logo = $<HTMLImageElement>("logo-image");
  const logoText = $("logo-text");
  logoText.textContent = screen.logoText;
  logoText.hidden = Boolean(screen.logo) || !screen.logoText;
  if (screen.logo) {
    logo.src = screen.logo;
    logo.hidden = false;
    // A missing logo file falls back to the logo text.
    logo.onerror = () => {
      logo.hidden = true;
      logoText.hidden = !screen.logoText;
    };
  }
}

// ---- Avatar session ----------------------------------------------------

async function openSession(): Promise<Face> {
  const res = await fetch("/api/session", { method: "POST" });
  if (!res.ok) throw new Error(`/api/session answered ${res.status}: ${await res.text()} (see the server's Terminal window)`);
  const { renderer, sessionToken } = (await res.json()) as { renderer: Renderer; sessionToken: string };
  const opened = createFace(renderer, sessionToken);
  opened.onDisconnected(() => {
    if (opened === session) void endVisit();
    if (opened === spare) {
      spare = null;
      setTimeout(warmUp, 5000);
    }
  });
  opened.onSpeakEnded(() => {
    if (!talking) statusLine.textContent = IDLE_STATUS;
  });
  await opened.start(video);
  return opened;
}

/** Opens the next visit's avatar session in the background, when prewarm is on. */
function warmUp(): void {
  if (!prewarm || spare || warming) return;
  warming = openSession()
    .then((opened) => {
      spare = opened;
    })
    .catch((err) => {
      console.error("prewarm failed", err);
      setTimeout(warmUp, 15000);
    })
    .finally(() => {
      warming = null;
    });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "object" && err) {
    try {
      return JSON.stringify(err);
    } catch {}
  }
  return String(err);
}

/** Sends a kiosk error to the server, so it shows in the Terminal window too. */
function reportError(message: string): void {
  void fetch("/api/kiosk-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: message.slice(0, 2000) }),
  }).catch(() => {});
}

/** The longest a visitor waits after tapping Start before we say something went wrong. */
const START_TIMEOUT_MS = 20000;

async function startVisit(): Promise<void> {
  // The image scene plays the voice in this page, which browsers only allow after a tap.
  if (document.body.classList.contains("scene-mode")) unlockAudio();
  startButton.disabled = true;
  // The visit status line is hidden until the visit starts, so report on the start screen.
  attractStatus.textContent = "Starting…";
  // Ava's chat and her first words get ready on the server while the face loads.
  const tappedAt = performance.now();
  send({ type: "visit_starting" });
  const opening = (async () => {
    if (warming) await warming;
    const ready = spare ?? (await openSession());
    spare = null;
    return ready;
  })();
  let timedOut = false;
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        timedOut = true;
        reject(new Error(`the avatar did not start within ${START_TIMEOUT_MS / 1000} seconds`));
      }, START_TIMEOUT_MS),
    );
    session = await Promise.race([opening, timeout]);
    attractStatus.textContent = "";
    document.body.classList.add("in-visit");
    send({ type: "start_visit", faceMs: Math.round(performance.now() - tappedAt) });
  } catch (err) {
    console.error("[kiosk] Start failed:", err);
    reportError(`Start failed: ${describe(err)}`);
    attractStatus.textContent = "The avatar is taking a break. Please ask a booth teammate.";
    session = null;
    send({ type: "visit_cancelled" });
    // A session that turns up after we gave up is closed, not left running (and billing).
    if (timedOut) void opening.then((late) => late.stop()).catch(() => {});
  } finally {
    startButton.disabled = false;
  }
}

async function endVisit(): Promise<void> {
  const ending = session;
  session = null;
  document.body.classList.remove("in-visit");
  delete document.body.dataset.state;
  transcript.clear();
  setSuggestions(startSuggestions);
  statusLine.textContent = "";
  await ending?.stop().catch(() => {});
  warmUp();
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
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    micLevel = micLevel * 0.6 + Math.sqrt(sum / samples.length) * 0.4;
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
  micLevel = 0;
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

/** The buttons a new visitor sees before Ava greets them. */
let startSuggestions: string[] = [];

/** Replaces the tap-to-ask buttons (the AVA's quick replies, or the show's questions). */
function setSuggestions(items: string[]): void {
  suggestions.replaceChildren(
    ...items.map((question) => {
      const button = document.createElement("button");
      button.textContent = question;
      button.addEventListener("click", () => send({ type: "ask", text: question }));
      return button;
    }),
  );
}

async function init(): Promise<void> {
  const showInfo = await (await fetch("/api/show")).json();
  document.title = `${(showInfo.screen as ScreenConfig).avaName} · ${showInfo.company}`;
  showHeader(showInfo.screen as ScreenConfig);
  if (showInfo.renderer === "image") {
    const scene = (showInfo.screen as ScreenConfig).scene;
    showScene(scene);
    transcript = new BubbleTranscript(scene.idleText);
  }
  $("attract-sub").textContent = `${showInfo.company}'s digital host. Tap to start a conversation.`;
  sandboxBadge.hidden = !showInfo.sandbox;
  prewarm = Boolean(showInfo.prewarm);
  startSuggestions = showInfo.suggestedQuestions as string[];
  setSuggestions(startSuggestions);
  attract.hidden = false;
  requestAnimationFrame(drawWave);
  connect();
  warmUp();
}

void init();
