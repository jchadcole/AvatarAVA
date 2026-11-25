import { timingSafeEqual } from "node:crypto";
import type WebSocket from "ws";
import type { CallLine } from "./call.ts";

/**
 * Genesys Cloud Audio Connector: a Genesys call flow ("Call Audio Connector"
 * action) opens a WebSocket to us and streams the caller's audio; we stream
 * Ava's voice back. The messages follow the Genesys AudioHook protocol,
 * version 2: JSON text frames for control, binary frames for audio (PCMU,
 * 8 kHz).
 */

export type Media = { type: "audio"; format: "PCMU" | "L16"; channels: ("external" | "internal")[]; rate: number };

export interface OpenParameters {
  organizationId?: string;
  conversationId?: string;
  participant?: { id?: string; ani?: string; aniName?: string; dnis?: string };
  media?: Media[];
  language?: string;
  supportedLanguages?: boolean;
  customConfig?: Record<string, unknown>;
  inputVariables?: Record<string, unknown>;
}

/** What runs a call once Genesys has opened the session. */
export interface CallHandler {
  start(): void;
  audio(mulaw: Buffer): void;
  close(): void;
}

/** Picks the caller's audio: PCMU at 8 kHz, mono if Genesys offers it. */
export function chooseMedia(offers: Media[] = []): Media | null {
  const usable = offers.filter((m) => m.type === "audio" && m.format === "PCMU" && m.rate === 8000 && m.channels.includes("external"));
  return usable.find((m) => m.channels.length === 1) ?? usable[0] ?? null;
}

/** Checks the X-API-KEY header Genesys sends against ours, in constant time. */
export function apiKeyMatches(sent: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(sent) ? sent[0] : sent;
  if (!value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One Audio Connector session. Answers Genesys's control messages and hands
 * the call to `onOpen`, which returns the handler that runs it.
 */
export class AudioConnectorSession implements CallLine {
  private seq = 0;
  private clientseq = 0;
  private id: string;
  private state: "connecting" | "active" | "paused" | "closing" | "closed" = "connecting";
  private media: Media | null = null;
  /** Byte offset and stride of the caller's channel in each audio frame. */
  private channel = { offset: 0, stride: 1 };
  private handler: CallHandler | null = null;

  constructor(
    private readonly ws: WebSocket,
    sessionId: string,
    private readonly onOpen: (params: OpenParameters, line: AudioConnectorSession) => CallHandler | null,
    private readonly opts: { languages?: string[]; log?: (line: string) => void } = {},
  ) {
    this.id = sessionId;
    ws.on("message", (data, isBinary) => (isBinary ? this.onAudio(data as Buffer) : this.onText(data.toString())));
    ws.on("close", () => this.finish());
    ws.on("error", (err) => this.log(`socket error: ${err.message}`));
  }

  sendAudio(mulaw: Buffer): void {
    if (this.state !== "active" || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(mulaw, { binary: true });
  }

  /** Tells Genesys to drop any of Ava's audio it still has queued. */
  clearAudio(): void {
    if (this.state === "active" || this.state === "paused") this.send("event", { entities: [{ type: "barge_in", data: {} }] });
  }

  /** Ends the session; Genesys then answers with "close" and the call flow carries on (usually: hang up). */
  hangUp(info: string): void {
    if (this.state === "closing" || this.state === "closed") return;
    this.send("disconnect", { reason: "completed", info, outputVariables: { avaEndReason: info } });
  }

  private onText(text: string): void {
    let msg: { type?: string; seq?: number; id?: string; parameters?: any };
    try {
      msg = JSON.parse(text);
    } catch {
      this.log(`ignored a message that is not JSON`);
      return;
    }
    if (typeof msg.seq === "number") {
      if (msg.seq !== this.clientseq + 1) this.log(`sequence jumped from ${this.clientseq} to ${msg.seq}`);
      this.clientseq = msg.seq;
    }
    const params = msg.parameters ?? {};
    switch (msg.type) {
      case "open":
        if (typeof msg.id === "string") this.id = msg.id;
        this.open(params as OpenParameters);
        break;
      case "ping":
        this.send("pong", {});
        break;
      case "paused":
        if (this.state === "active") this.state = "paused";
        break;
      case "resumed":
        if (this.state === "paused") this.state = "active";
        break;
      case "update":
      case "discarded":
        break;
      case "error":
        this.log(`Genesys reported an error: ${JSON.stringify(params)}`);
        break;
      case "close":
        this.state = "closing";
        this.handler?.close();
        this.handler = null;
        this.send("closed", {});
        this.state = "closed";
        break;
      default:
        // Playback notices and other events need no answer.
        break;
    }
  }

  private open(params: OpenParameters): void {
    if (this.state !== "connecting") return;
    const media = chooseMedia(params.media);
    if (!media) {
      this.log(`Genesys offered no audio Ava can use: ${JSON.stringify(params.media)}`);
      this.send("disconnect", { reason: "error", info: "No supported media offered (need PCMU 8 kHz)." });
      this.state = "closing";
      return;
    }
    this.media = media;
    this.channel = { offset: Math.max(0, media.channels.indexOf("external")), stride: media.channels.length };
    const opened: Record<string, unknown> = { media: [media], startPaused: false };
    if (params.supportedLanguages) opened.supportedLanguages = this.opts.languages ?? ["en-US"];
    this.send("opened", opened);
    this.state = "active";
    this.handler = this.onOpen(params, this);
    if (!this.handler) {
      this.hangUp("not_allowed");
      return;
    }
    this.handler.start();
  }

  private onAudio(frame: Buffer): void {
    if (!this.media || !this.handler || this.state !== "active") return;
    if (this.channel.stride === 1) {
      this.handler.audio(frame);
      return;
    }
    // Stereo frames interleave the channels sample by sample; keep the caller's.
    const out = Buffer.alloc(Math.floor(frame.length / this.channel.stride));
    for (let i = 0; i < out.length; i++) out[i] = frame[i * this.channel.stride + this.channel.offset];
    this.handler.audio(out);
  }

  private send(type: string, parameters: Record<string, unknown>): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ version: "2", type, seq: ++this.seq, clientseq: this.clientseq, id: this.id, parameters }));
  }

  private finish(): void {
    this.state = "closed";
    this.handler?.close();
    this.handler = null;
  }

  private log(line: string): void {
    (this.opts.log ?? console.warn)(`AUDIO CONNECTOR ${this.id.slice(0, 8)}: ${line}`);
  }
}
