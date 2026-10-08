import WebSocket from "ws";

/** Text-to-speech that returns raw PCM 16-bit, 24 kHz, mono (what LiveAvatar expects). */
export interface Tts {
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
  /** Which voice produced this audio, when more than one may be in use. */
  voiceOf?(audio: Buffer): string | undefined;
}

/** One push-to-talk utterance streamed to speech-to-text. */
export interface SttSession {
  /** PCM 16-bit, 16 kHz, mono audio from the kiosk mic. */
  write(pcm: Buffer): void;
  /** Ends the utterance and resolves with the final transcript. */
  finish(): Promise<string>;
  close(): void;
}

export interface Stt {
  open(keyterms: string[]): SttSession;
}

export class DeepgramTts implements Tts {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const url = new URL("https://api.deepgram.com/v1/speak");
    url.searchParams.set("model", this.model);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "24000");
    url.searchParams.set("container", "none");
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) throw new Error(`Deepgram TTS failed: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/**
 * ElevenLabs voice, via the streaming endpoint so audio starts arriving as soon
 * as it is generated. Returns the same raw PCM 24 kHz the avatar expects.
 */
export class ElevenLabsTts implements Tts {
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly model: string,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`);
    url.searchParams.set("output_format", "pcm_24000");
    const res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/pcm" },
      body: JSON.stringify({ text, model_id: this.model }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}

/**
 * Uses the premium voice and falls back to the backup voice whenever it fails
 * or is slow, so the avatar never goes silent. After repeated failures it skips
 * the premium voice for a while instead of paying the timeout on every line.
 */
export class FallbackTts implements Tts {
  private failures = 0;
  private skipUntil = 0;
  private readonly voices = new WeakMap<Buffer, string>();
  /** Why the premium voice last failed, for the startup check. */
  lastError: string | undefined;

  constructor(
    private readonly primary: Tts,
    private readonly backup: Tts,
    private readonly opts: {
      timeoutMs?: number;
      maxFailures?: number;
      cooldownMs?: number;
      now?: () => number;
      primaryName?: string;
      backupName?: string;
    } = {},
  ) {}

  voiceOf(audio: Buffer): string | undefined {
    return this.voices.get(audio);
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const now = this.opts.now ?? Date.now;
    if (now() >= this.skipUntil) {
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 4000);
      try {
        const audio = await this.primary.synthesize(text, signal ? AbortSignal.any([signal, timeout]) : timeout);
        this.failures = 0;
        this.voices.set(audio, this.opts.primaryName ?? "premium");
        return audio;
      } catch (err) {
        if (signal?.aborted) throw err;
        this.lastError = timeout.aborted ? `no audio within ${this.opts.timeoutMs ?? 4000} ms` : String(err);
        console.warn(`Premium voice failed (${this.lastError}); using the backup voice for this line.`);
        if (++this.failures >= (this.opts.maxFailures ?? 3)) {
          this.skipUntil = now() + (this.opts.cooldownMs ?? 60_000);
          this.failures = 0;
          console.warn("Premium voice keeps failing; using the backup voice for the next minute.");
        }
      }
    }
    const audio = await this.backup.synthesize(text, signal);
    this.voices.set(audio, `${this.opts.backupName ?? "backup"} (backup)`);
    return audio;
  }
}

export class DeepgramStt implements Stt {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly language: string,
  ) {}

  open(keyterms: string[]): SttSession {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("language", this.language);
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("interim_results", "false");
    for (const term of keyterms) url.searchParams.append("keyterm", term);

    const socket = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
    const finals: string[] = [];
    const pending: Buffer[] = [];
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));

    socket.on("open", () => {
      for (const chunk of pending.splice(0)) socket.send(chunk);
    });
    socket.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "Results") return;
      const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (msg.is_final && text) finals.push(text);
      if (msg.from_finalize) resolveDone?.();
    });
    socket.on("close", () => resolveDone?.());
    socket.on("error", () => resolveDone?.());

    return {
      write(pcm) {
        if (socket.readyState === WebSocket.OPEN) socket.send(pcm);
        else if (socket.readyState === WebSocket.CONNECTING) pending.push(pcm);
      },
      async finish() {
        const send = () => socket.send(JSON.stringify({ type: "Finalize" }));
        if (socket.readyState === WebSocket.OPEN) send();
        else socket.once("open", send);
        // Never leave the visitor waiting on a slow or dropped connection.
        await Promise.race([done, new Promise((r) => setTimeout(r, 2500))]);
        this.close();
        return finals.join(" ").trim();
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "CloseStream" }));
          socket.close();
        } else if (socket.readyState === WebSocket.CONNECTING) {
          socket.once("open", () => socket.close());
        }
      },
    };
  }
}
