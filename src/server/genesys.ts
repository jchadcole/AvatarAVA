import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Brain, Turn } from "./brain.ts";
import { SentenceChunker } from "./speech.ts";

/**
 * Answers come from a Genesys Cloud Agentic Virtual Agent (AVA) instead of
 * Claude. Each visitor gets a fresh guest chat session on a Web Messaging
 * (Messenger) deployment; the deployment's inbound message flow hands the chat
 * to a digital bot flow that calls the AVA, and the AVA's replies come back on
 * the same socket.
 *
 * Protocol: Genesys Web Messaging Guest API
 * (https://developer.genesys.cloud/commdigital/digital/webmessaging/websocketapi).
 * Checked against the docs' summary and a mock server only; confirm the
 * message shapes against a real deployment.
 */
export interface GenesysOptions {
  /** Org region domain, e.g. "mypurecloud.com" or "usw2.pure.cloud". */
  region: string;
  deploymentId: string;
  /** Origin header to send, for deployments with domain restriction on. */
  origin?: string;
  /** How long to wait for the AVA's first words before giving up. */
  replyTimeoutMs: number;
  /** How long the AVA may go quiet before its reply counts as finished. */
  quietMs: number;
  /**
   * Hold each question until the input classifier passes it (slower, but a
   * flagged question never reaches Genesys). Off: the question goes at once,
   * and a flagged one is still never spoken.
   */
  waitForScreening?: boolean;
  /**
   * Sent as soon as the chat opens, so the bot's welcome message ("Hello,
   * thanks for contacting...") arrives and is discarded before the visitor's
   * first question. Empty: no warm-up.
   */
  warmUpText?: string;
  /** Test hook: connect here instead of the region's Web Messaging address. */
  url?: string;
  /** Sees every message Genesys sends, for genesys:check. */
  onRaw?(message: unknown): void;
}

export class GenesysTimeoutError extends Error {
  constructor(ms: number) {
    super(`Genesys AVA did not answer within ${ms} ms`);
  }
}

/** wss://webmessaging.<region>/v1?deploymentId=…, from a bare region or any Genesys Cloud URL for it. */
export function webMessagingUrl(region: string, deploymentId: string): string {
  const domain = region
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^(webmessaging|api|apps|login)\./i, "");
  if (!domain) throw new Error("Genesys region is empty");
  return `wss://webmessaging.${domain}/v1?deploymentId=${encodeURIComponent(deploymentId)}`;
}

type Inbound = {
  type?: string;
  class?: string;
  code?: number;
  body?: {
    text?: string;
    direction?: string;
    type?: string;
    events?: { eventType?: string; presence?: { type?: string } }[];
  };
};

const GREETING_START = /^(hi|hello|hey|welcome|greetings|good (morning|afternoon|evening)|thanks?( you)? for)\b/i;
const OFFER_HELP = /\b(how (can|may) i (help|assist)|what can i (help|do)|help you (with )?today|how can we help)\b/i;

/** A bot's welcome line ("Hello, thanks for contacting... How can I help you today?") rather than an answer. */
export function looksLikeGreeting(text: string): boolean {
  return GREETING_START.test(text.trim()) && OFFER_HELP.test(text);
}

/** The visitor just said hello, so a greeting back is a fair answer. */
function isHello(text: string): boolean {
  return text.trim().length <= 30 && /^(hi|hello|hey|good (morning|afternoon|evening))\b/i.test(text.trim());
}

export class GenesysBrain implements Brain {
  readonly name = "Genesys AVA";
  /** How long the AVA took to send its first words, from when the question was sent. */
  lastReplyMs: number | undefined;
  /** What the bot said to the warm-up message, for genesys:check. */
  lastWarmUpReply: string | undefined;
  private socket: WebSocket | null = null;
  private ready: Promise<WebSocket> | null = null;
  private token = randomUUID();
  private listeners = new Set<(message: Inbound) => void>();

  constructor(private readonly opts: GenesysOptions) {}

  get screenFirst(): boolean {
    return this.opts.waitForScreening ?? false;
  }

  /** A visitor arrived: open their chat now so the first question doesn't wait for it. */
  prepare(): Promise<void> {
    return this.connect().then(
      () => {},
      () => {}, // the first question reports any failure
    );
  }

  async *reply(_history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string> {
    const socket = await this.connect();
    const queue: string[] = [];
    let ended = false;
    let failure: Error | undefined;
    let gotText = false;
    let skippedGreeting: string | undefined;
    this.lastReplyMs = undefined;
    let sentAt = Date.now();
    let wake: () => void = () => {};
    let quietTimer: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      if (ended) return;
      ended = true;
      failure = err;
      wake();
    };
    const replyTimer = setTimeout(
      () =>
        finish(
          skippedGreeting
            ? new Error(`the AVA only greeted ("${skippedGreeting}") and never answered`)
            : new GenesysTimeoutError(this.opts.replyTimeoutMs),
        ),
      this.opts.replyTimeoutMs,
    );
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort);
    const onClose = () => finish(gotText ? undefined : new Error("Genesys closed the chat before answering"));
    socket.on("close", onClose);

    const listener = (message: Inbound) => {
      if (message.type === "response" && message.code !== undefined && message.code >= 400) {
        finish(new Error(`Genesys rejected the message (${message.code}): ${JSON.stringify(message.body)}`));
        return;
      }
      const body = message.body;
      if (message.type !== "message" || body?.direction !== "Outbound") return;
      // An AVA hand-off or the flow ending the chat: stop with what we have.
      if (body.events?.some((e) => e.presence?.type === "Disconnect")) {
        finish(gotText ? undefined : new Error("Genesys ended the chat without answering"));
        return;
      }
      const text = body.text?.trim();
      if (!text) return; // typing indicators, events, buttons without words
      // A welcome line is not an answer: keep waiting for the real one.
      if (!gotText && looksLikeGreeting(text) && !isHello(visitorText)) {
        skippedGreeting = text;
        return;
      }
      if (!gotText) this.lastReplyMs = Date.now() - sentAt;
      gotText = true;
      clearTimeout(replyTimer);
      queue.push(text);
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), this.opts.quietMs);
      wake();
    };
    this.listeners.add(listener);

    try {
      sentAt = Date.now();
      socket.send(
        JSON.stringify({ action: "onMessage", token: this.token, message: { type: "Text", text: visitorText } }),
      );
      const chunker = new SentenceChunker();
      while (true) {
        while (queue.length) {
          if (signal.aborted) return;
          // Each chat message is complete, so speak it whole, sentence by sentence.
          yield* chunker.push(`${queue.shift()} `);
          yield* chunker.flush();
        }
        if (ended) break;
        await new Promise<void>((resolve) => (wake = resolve));
      }
      if (failure) throw failure;
    } finally {
      clearTimeout(replyTimer);
      clearTimeout(quietTimer);
      signal.removeEventListener("abort", onAbort);
      socket.off("close", onClose);
      this.listeners.delete(listener);
      // Cut off mid-answer: the rest of it would arrive during the next
      // question and be spoken as its answer, so start a fresh chat.
      if (signal.aborted) this.endVisit();
    }
  }

  /** The visitor left: drop this chat so the next visitor starts a new one. */
  endVisit(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    // Closing the socket leaves the Genesys chat to expire on its own (Genesys
    // rejects a "Clear" presence event here); the new token below is what
    // keeps visitors apart.
    if (socket?.readyState === WebSocket.OPEN) socket.close();
    else socket?.terminate();
    this.token = randomUUID();
  }

  /**
   * Starts the bot with a throwaway message and waits out its welcome, so the
   * visitor's first question gets a real answer and the bot is already running.
   * Never fails: at worst the first question waits a little longer.
   */
  private warmUp(socket: WebSocket): Promise<void> {
    const text = this.opts.warmUpText ?? "Hello";
    if (!text) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined;
      const done = () => {
        clearTimeout(cap);
        clearTimeout(quiet);
        this.listeners.delete(listener);
        resolve();
      };
      const cap = setTimeout(done, this.opts.replyTimeoutMs);
      const listener = (message: Inbound) => {
        const reply = message.type === "message" && message.body?.direction === "Outbound" ? message.body.text?.trim() : "";
        if (!reply) return;
        this.lastWarmUpReply = this.lastWarmUpReply ? `${this.lastWarmUpReply} ${reply}` : reply;
        clearTimeout(quiet);
        quiet = setTimeout(done, this.opts.quietMs);
      };
      this.lastWarmUpReply = undefined;
      this.listeners.add(listener);
      socket.send(JSON.stringify({ action: "onMessage", token: this.token, message: { type: "Text", text } }));
    });
  }

  /** Opens the socket, starts a guest session and warms the bot up, once per visitor. */
  private connect(): Promise<WebSocket> {
    // Reuse the chat while it is opening or open (prepare() may have started it).
    const state = this.socket?.readyState;
    if (this.ready && (state === WebSocket.CONNECTING || state === WebSocket.OPEN)) return this.ready;
    const { region, deploymentId, origin, url, replyTimeoutMs } = this.opts;
    const socket = new WebSocket(url ?? webMessagingUrl(region, deploymentId), origin ? { origin } : undefined);
    this.socket = socket;
    socket.on("message", (data) => {
      let message: Inbound;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.opts.onRaw?.(message);
      // A finished visitor's chat may still be talking while it closes.
      if (socket !== this.socket) return;
      for (const listener of this.listeners) listener(message);
    });
    socket.on("error", () => {}); // surfaced through close and the timeouts
    const ready = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new GenesysTimeoutError(replyTimeoutMs));
      }, replyTimeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        if (this.socket === socket) {
          this.socket = null;
          this.ready = null;
        }
        reject(err);
      };
      socket.once("error", fail);
      socket.once("close", () => fail(new Error("Genesys closed the connection")));
      socket.once("open", () => {
        socket.send(JSON.stringify({ action: "configureSession", deploymentId, token: this.token }));
      });
      const onSession = (data: WebSocket.RawData) => {
        let message: Inbound;
        try {
          message = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (message.class !== "SessionResponse") return;
        socket.off("message", onSession);
        if (message.code !== 200) {
          socket.close();
          fail(new Error(`Genesys refused the session (${message.code}): ${JSON.stringify(message.body)}`));
          return;
        }
        clearTimeout(timer);
        socket.removeAllListeners("close");
        socket.on("close", () => {
          if (this.socket === socket) {
            this.socket = null;
            this.ready = null;
          }
        });
        this.warmUp(socket).then(() => resolve(socket));
      };
      socket.on("message", onSession);
    });
    ready.catch(() => {});
    this.ready = ready;
    return ready;
  }
}

/**
 * Tries the primary brain and switches to the backup for the turn when the
 * primary fails or is slow before saying anything. Once the primary has
 * spoken, a later failure just ends the reply.
 */
export class FallbackBrain implements Brain {
  /** Which brain answered the last turn, for the backstage screen. */
  lastAnsweredBy: string | undefined;
  /** Why the backup answered the last turn, when it did. */
  lastNote: string | undefined;

  get lastReplyMs(): number | undefined {
    return this.lastAnsweredBy === this.primary.name ? this.primary.lastReplyMs : undefined;
  }

  constructor(
    private readonly primary: Brain & { name: string },
    private readonly backup: Brain,
    private readonly backupName: string,
  ) {}

  get screenFirst(): boolean {
    return this.primary.screenFirst ?? false;
  }

  prepare(): void {
    this.primary.prepare?.();
  }

  async *reply(history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string> {
    this.lastAnsweredBy = this.primary.name;
    this.lastNote = undefined;
    const started = Date.now();
    let spoke = false;
    try {
      for await (const sentence of this.primary.reply(history, visitorText, signal)) {
        spoke = true;
        yield sentence;
      }
      if (spoke) {
        const ms = this.primary.lastReplyMs ?? Date.now() - started;
        console.log(`BRAIN: ${this.primary.name}'s first words arrived ${(ms / 1000).toFixed(1)} s after the question.`);
      }
      if (spoke || signal.aborted) return;
      this.lastNote = `${this.primary.name} sent no words`;
      console.warn(`BRAIN: ${this.lastNote}, so ${this.backupName} answered.`);
    } catch (err) {
      if (signal.aborted) return;
      this.lastNote = err instanceof Error ? err.message : String(err);
      console.warn(`BRAIN: ${this.primary.name} failed (${this.lastNote}), ${spoke ? "reply cut short" : `so ${this.backupName} answered`}.`);
      if (spoke) return;
      // A stuck chat would make every later turn wait too, so start over.
      this.primary.endVisit?.();
    }
    this.lastAnsweredBy = `${this.backupName} (backup)`;
    yield* this.backup.reply(history, visitorText, signal);
  }

  endVisit(): void {
    this.primary.endVisit?.();
  }
}
