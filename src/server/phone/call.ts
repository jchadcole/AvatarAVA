import type { ServerMessage } from "../conversation.ts";
import { pcm24kToMulaw8k } from "./audio.ts";
import type { CallListener, CallStt } from "./listener.ts";
import type { PhoneSettings } from "./phoneShow.ts";

/** The phone line a call runs on (Genesys Audio Connector, or any other carrier). */
export interface CallLine {
  /** mu-law 8 kHz audio for the caller to hear. */
  sendAudio(mulaw: Buffer): void;
  /** Ava stopped talking mid-sentence: drop anything the line still has queued. */
  clearAudio(): void;
  /** Ava is done: end the call. */
  hangUp(info: string): void;
}

/** The parts of a Conversation a phone call drives. */
export interface CallConversation {
  greet(): Promise<void>;
  startListening(): void;
  handleVisitor(text: string): Promise<void>;
  endVisit(reason: "idle" | "strikes" | "staff"): void;
  dispose(): void;
}

/**
 * Sends Ava's speech down the line at the pace it plays, a little ahead, so
 * that when the caller talks over her the rest can be dropped at once rather
 * than playing out of a buffer we no longer control.
 */
export class PacedPlayer {
  private queue: Buffer[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** When the audio already sent will have finished playing. */
  private playsUntil = 0;
  private drainWaiters: (() => void)[] = [];

  constructor(
    private readonly send: (mulaw: Buffer) => void,
    private readonly opts: { chunkMs?: number; leadMs?: number; now?: () => number } = {},
  ) {}

  private get chunkBytes(): number {
    return (this.opts.chunkMs ?? 100) * 8; // 8 bytes per ms at 8 kHz mu-law
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** True while the caller is still hearing (or about to hear) Ava. */
  get playing(): boolean {
    return this.queue.length > 0 || this.now() < this.playsUntil;
  }

  enqueue(mulaw: Buffer): void {
    for (let i = 0; i < mulaw.length; i += this.chunkBytes) this.queue.push(mulaw.subarray(i, i + this.chunkBytes));
    this.pump();
  }

  /** Drops everything not yet sent. */
  clear(): void {
    this.queue = [];
    this.playsUntil = 0;
    this.stopTimer();
    this.resolveDrain();
  }

  /** Resolves once everything queued has played. */
  drained(): Promise<void> {
    if (!this.playing) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  stop(): void {
    this.clear();
  }

  private pump = (): void => {
    const now = this.now();
    const lead = this.opts.leadMs ?? 300;
    this.playsUntil = Math.max(this.playsUntil, now);
    while (this.queue.length && this.playsUntil - now < lead) {
      const chunk = this.queue.shift()!;
      this.send(chunk);
      this.playsUntil += chunk.length / 8;
    }
    this.stopTimer();
    if (this.queue.length || this.playsUntil > now) {
      this.timer = setTimeout(this.pump, Math.max(10, Math.min(this.opts.chunkMs ?? 100, this.playsUntil - now)));
    } else this.resolveDrain();
  };

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private resolveDrain(): void {
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

export interface PhoneCallDeps {
  /** Builds this call's conversation; everything it says arrives through `send`. */
  makeConversation(send: (message: ServerMessage) => void): CallConversation;
  stt: CallStt;
  keyterms: string[];
  line: CallLine;
  settings: PhoneSettings;
  /** Voices a fixed line (the goodbye), from the shared cache when it is there. */
  voiceLine(text: string): Promise<Buffer>;
  goodbye: string;
  /** Optional: how a cut-off call is logged in Terminal. */
  label?: string;
}

/**
 * One phone call with Ava. The caller just talks: Deepgram decides when a
 * sentence has ended, Ava answers through the same Conversation as the kiosk
 * (same brain, guardrails, backup brain and voices), and her speech goes down
 * the line as each sentence is voiced. Talking over Ava stops her.
 */
export class PhoneCall {
  private readonly conversation: CallConversation;
  private readonly player: PacedPlayer;
  private listener: CallListener | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private ending = false;
  private ended = false;
  /** Set once the caller's current words have stopped Ava, until that utterance is answered. */
  private bargedIn = false;
  /** Covers words that stopped Ava but never became a sentence (a cough, line noise). */
  private bargeTimer: NodeJS.Timeout | null = null;
  /** The last thing the caller said, and whether Ava has said anything since. */
  private lastAsked: { text: string; at: number } | null = null;
  private saidSinceAsked = false;

  constructor(private readonly deps: PhoneCallDeps) {
    this.player = new PacedPlayer((chunk) => deps.line.sendAudio(chunk));
    this.conversation = deps.makeConversation((message) => this.onConversation(message));
  }

  /** The line is open: start listening and greet the caller. */
  start(): void {
    this.listener = this.deps.stt.open(this.deps.keyterms, {
      onSpeech: (text, isFinal) => this.onSpeech(text, isFinal),
      onUtterance: (text) => this.onUtterance(text),
    });
    this.maxTimer = setTimeout(() => {
      console.log(`PHONE: ${this.deps.label ?? "call"} reached ${this.deps.settings.maxCallMinutes} minutes; Ava says goodbye.`);
      this.conversation.endVisit("staff");
    }, this.deps.settings.maxCallMinutes * 60_000);
    void this.conversation.greet();
  }

  /** Caller audio from the line. */
  audio(mulaw: Buffer): void {
    this.listener?.write(mulaw);
  }

  /** The line closed (the caller hung up, or we did). */
  close(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.player.stop();
    this.listener?.close();
    this.conversation.dispose();
  }

  private onConversation(message: ServerMessage): void {
    if (this.ended) return;
    switch (message.type) {
      case "say":
        this.saidSinceAsked = true;
        this.player.enqueue(pcm24kToMulaw8k(Buffer.from(message.audio, "base64")));
        break;
      case "interrupt":
        if (this.player.playing) this.deps.line.clearAudio();
        this.player.clear();
        break;
      case "end_visit":
        void this.finish(message.reason);
        break;
      // Captions, states and tap-to-ask buttons are for a screen; a caller has none.
    }
  }

  private onSpeech(text: string, isFinal: boolean): void {
    if (this.ending || this.bargedIn || !this.deps.settings.bargeIn || !this.player.playing) return;
    const words = text.split(/\s+/).filter((w) => /\w/.test(w)).length;
    if (words >= this.deps.settings.bargeInMinWords || (isFinal && words > 0)) {
      this.bargedIn = true;
      // Cancels Ava's turn and sends "interrupt", which drops her queued audio.
      this.conversation.startListening();
      this.bargeTimer = setTimeout(() => {
        if (!this.bargedIn || this.ending) return;
        this.bargedIn = false;
        void this.conversation.handleVisitor(""); // "Sorry, could you say that again?"
      }, 6000);
    }
  }

  private onUtterance(text: string): void {
    this.bargedIn = false;
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    if (this.ending) return;
    // A caller who adds to their question before Ava has said a word gets
    // one answer to the whole question, not just to the last few words.
    const now = Date.now();
    const asked =
      this.lastAsked && !this.saidSinceAsked && now - this.lastAsked.at < 15_000 ? `${this.lastAsked.text} ${text}` : text;
    this.lastAsked = { text: asked, at: now };
    this.saidSinceAsked = false;
    void this.conversation.handleVisitor(asked);
  }

  /** Says goodbye (unless the strike line already did) and hangs up once it has played. */
  private async finish(reason: "idle" | "strikes" | "staff"): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    if (reason !== "strikes") {
      try {
        this.player.enqueue(pcm24kToMulaw8k(await this.deps.voiceLine(this.deps.goodbye)));
      } catch (err) {
        console.warn(`PHONE: could not voice the goodbye: ${(err as Error).message}`);
      }
    }
    await this.player.drained();
    // Give the far end a moment to play the last packet before the line drops.
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!this.ended) this.deps.line.hangUp(reason);
  }
}
