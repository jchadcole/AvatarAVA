import { AnamEvent, createClient, type AgentAudioInputStream } from "@anam-ai/js-sdk";
import { AgentEventsEnum, LiveAvatarSession, SessionEvent } from "@heygen/liveavatar-web-sdk";

export type Renderer = "liveavatar" | "anam";

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
  return renderer === "anam" ? new AnamFace(sessionToken) : new LiveAvatarFace(sessionToken);
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
