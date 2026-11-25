import { AnamEvent, createClient, type AgentAudioInputStream } from "@anam-ai/js-sdk";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";

export type Renderer = "liveavatar" | "anam" | "image";

/**
 * A hosted face that lip-syncs to audio we send. The kiosk never lets the
 * vendor listen or answer: speech-to-text, the brain, guardrails and the voice
 * all stay on our server, so faces can be swapped per show.
 */
export interface Face {
  start(video: HTMLVideoElement): Promise<void>;
  /** Speaks one line: base64 PCM16, 24 kHz, mono. */
  say(audio: string): void;
  /** The server finished the turn; no more lines are coming for now. */
  endTurn(): void;
  /** Stops speaking at once (the visitor cut in or the turn was cancelled). */
  interrupt(): void;
  stop(): Promise<void>;
  onDisconnected(handler: () => void): void;
  onSpeakEnded(handler: () => void): void;
}

export function createFace(renderer: Renderer, sessionToken: string): Face {
  if (renderer === "image") return new VoiceOnlyFace();
  return renderer === "anam" ? new AnamFace(sessionToken) : new LiveAvatarFace(sessionToken);
}

/** One audio output for the voice-only face, made on the visitor's tap so the browser lets it play. */
let speaker: AudioContext | null = null;
/** Measures the voice as it plays, for the scene's sound-wave animation. */
let meter: AnalyserNode | null = null;
let meterData: Float32Array<ArrayBuffer> | null = null;

/** Call from a tap or click: browsers only start audio after the visitor touches the page. */
export function unlockAudio(): void {
  if (!speaker) {
    speaker = new AudioContext({ sampleRate: 24000 });
    meter = speaker.createAnalyser();
    meter.fftSize = 512;
    meter.connect(speaker.destination);
    meterData = new Float32Array(meter.fftSize);
  }
  void speaker.resume();
}

/** How loud the host's voice is right now (RMS, about 0 to 0.5), when the page plays it. */
export function voiceLevel(): number {
  if (!meter || !meterData) return 0;
  meter.getFloatTimeDomainData(meterData);
  let sum = 0;
  for (const v of meterData) sum += v * v;
  return Math.sqrt(sum / meterData.length);
}

/**
 * No face at all (the "image" scene): the kiosk plays the host's voice itself,
 * line after line, and the words type into the scene's speech bubble instead.
 */
class VoiceOnlyFace implements Face {
  private playing = new Set<AudioBufferSourceNode>();
  /** When the audio queued so far finishes, on the AudioContext clock. */
  private playsUntil = 0;
  private speakEnded: (() => void) | null = null;

  async start(): Promise<void> {
    unlockAudio();
  }

  say(audio: string): void {
    unlockAudio();
    const context = speaker!;
    const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, 24000);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(meter ?? context.destination);
    // Lines play back to back, with no gap or overlap.
    const at = Math.max(context.currentTime + 0.02, this.playsUntil);
    source.start(at);
    this.playsUntil = at + buffer.duration;
    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      if (!this.playing.size) this.speakEnded?.();
    };
  }

  endTurn(): void {}

  interrupt(): void {
    for (const source of this.playing) {
      source.onended = null;
      source.stop();
    }
    this.playing.clear();
    this.playsUntil = 0;
    this.speakEnded?.();
  }

  async stop(): Promise<void> {
    this.interrupt();
  }

  onDisconnected(): void {}

  onSpeakEnded(handler: () => void): void {
    this.speakEnded = handler;
  }
}

class LiveAvatarFace implements Face {
  private session: LiveAvatarSession;

  constructor(sessionToken: string) {
    // Mic audio goes to our server for speech-to-text, not into the avatar room.
    this.session = new LiveAvatarSession(sessionToken, { autoKeepAlive: true, voiceChat: { defaultMuted: true } });
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.session.on(SessionEvent.SESSION_STREAM_READY, () => this.session.attach(video));
    await this.session.start();
  }

  say(audio: string): void {
    this.session.repeatAudio(audio);
  }

  endTurn(): void {}

  interrupt(): void {
    this.session.interrupt();
  }

  async stop(): Promise<void> {
    await this.session.stop();
  }

  onDisconnected(handler: () => void): void {
    this.session.on(SessionEvent.SESSION_DISCONNECTED, handler);
  }

  onSpeakEnded(handler: () => void): void {
    this.session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, handler);
  }
}

/** Anam in audio passthrough mode: it renders the face from our audio only. */
class AnamFace implements Face {
  private client: ReturnType<typeof createClient>;
  private stream: AgentAudioInputStream | null = null;
  private speakEnded: (() => void) | null = null;
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the audio sent so far should finish playing, in performance.now() ms. */
  private playsUntil = 0;

  constructor(sessionToken: string) {
    // disableInputAudio: Anam never hears the visitor; our server does.
    this.client = createClient(sessionToken, { disableInputAudio: true });
  }

  async start(video: HTMLVideoElement): Promise<void> {
    if (!video.id) video.id = "avatar";
    await this.client.streamToVideoElement(video.id);
  }

  say(audio: string): void {
    this.stream ??= this.client.createAgentAudioInputStream({ encoding: "pcm_s16le", sampleRate: 24000, channels: 1 });
    this.stream.sendAudioChunk(audio);
    // Anam has no "finished speaking" event for passthrough audio, so estimate it
    // from the audio length (base64 of 16-bit 24 kHz mono).
    const seconds = (audio.length * 3) / 4 / 2 / 24000;
    this.playsUntil = Math.max(this.playsUntil, performance.now()) + seconds * 1000;
    this.armSpeakEnded();
  }

  endTurn(): void {
    this.stream?.endSequence();
    this.stream = null;
  }

  interrupt(): void {
    this.client.interruptPersona();
    this.endTurn();
    this.playsUntil = 0;
    this.armSpeakEnded();
  }

  async stop(): Promise<void> {
    if (this.speakTimer) clearTimeout(this.speakTimer);
    this.stream = null;
    await this.client.stopStreaming();
  }

  onDisconnected(handler: () => void): void {
    this.client.addListener(AnamEvent.CONNECTION_CLOSED, handler);
  }

  onSpeakEnded(handler: () => void): void {
    this.speakEnded = handler;
  }

  private armSpeakEnded(): void {
    if (this.speakTimer) clearTimeout(this.speakTimer);
    const wait = Math.max(0, this.playsUntil - performance.now());
    this.speakTimer = setTimeout(() => this.speakEnded?.(), wait);
  }
}
