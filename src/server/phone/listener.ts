import WebSocket from "ws";

export interface CallListenerEvents {
  /** Words heard so far in the current utterance, while the caller is still talking. */
  onSpeech(text: string, isFinal: boolean): void;
  /** The caller finished a sentence (a pause after speech): answer it. */
  onUtterance(text: string): void;
}

export interface CallListener {
  /** mu-law 8 kHz audio from the call, straight from the phone line. */
  write(mulaw: Buffer): void;
  close(): void;
}

export interface CallStt {
  open(keyterms: string[], events: CallListenerEvents): CallListener;
}

/**
 * Speech-to-text for a whole phone call. The kiosk uses push-to-talk; a caller
 * just talks, so this keeps one Deepgram stream open for the call and lets
 * Deepgram decide when a sentence has ended (a short pause, or a longer gap
 * on a noisy line).
 */
export class DeepgramCallStt implements CallStt {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly language: string,
    /** Silence that ends a sentence. Lower answers sooner but may cut slow talkers off. */
    private readonly endpointingMs = 400,
  ) {}

  open(keyterms: string[], events: CallListenerEvents): CallListener {
    const url = new URL("wss://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.model);
    url.searchParams.set("language", this.language);
    url.searchParams.set("encoding", "mulaw");
    url.searchParams.set("sample_rate", "8000");
    url.searchParams.set("channels", "1");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("endpointing", String(this.endpointingMs));
    // Backup end-of-sentence signal for noisy lines where endpointing never fires.
    url.searchParams.set("utterance_end_ms", "1000");
    for (const term of keyterms) url.searchParams.append("keyterm", term);

    let closed = false;
    let socket: WebSocket;
    let pending: Buffer[] = [];
    let finals: string[] = [];
    let retries = 0;

    const flush = () => {
      const text = finals.join(" ").trim();
      finals = [];
      if (text) events.onUtterance(text);
    };

    const connect = () => {
      socket = new WebSocket(url, { headers: { Authorization: `Token ${this.apiKey}` } });
      socket.on("open", () => {
        retries = 0;
        for (const chunk of pending) socket.send(chunk);
        pending = [];
      });
      socket.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (msg.type === "UtteranceEnd") {
          flush();
          return;
        }
        if (msg.type !== "Results") return;
        const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
        if (msg.is_final && text) finals.push(text);
        if (text) events.onSpeech([...finals, msg.is_final ? "" : text].join(" ").trim(), Boolean(msg.is_final));
        if (msg.speech_final) flush();
      });
      socket.on("error", (err) => console.warn(`PHONE STT: Deepgram error: ${(err as Error).message}`));
      socket.on("close", (code) => {
        if (closed) return;
        // A dropped stream mid-call would leave Ava deaf: reconnect a few times.
        if (retries++ < 3) {
          console.warn(`PHONE STT: Deepgram stream closed (${code}); reconnecting.`);
          setTimeout(connect, 250 * retries);
        } else console.error("PHONE STT: Deepgram keeps closing the stream; Ava can no longer hear this caller.");
      });
    };
    connect();

    return {
      write(mulaw) {
        if (socket.readyState === WebSocket.OPEN) socket.send(mulaw);
        else if (pending.length < 250) pending.push(mulaw); // about 5 s while (re)connecting
      },
      close() {
        closed = true;
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
