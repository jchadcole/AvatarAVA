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
  /** Test hook: connect here instead of the region's Web Messaging address. */
  url?: string;
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

export class GenesysBrain implements Brain {
  readonly name = "Genesys AVA";
  /** Genesys keeps the conversation, so screen questions before they leave the booth. */
  readonly screenFirst = true;
  private socket: WebSocket | null = null;
  private ready: Promise<WebSocket> | null = null;
  private token = randomUUID();
  private listeners = new Set<(message: Inbound) => void>();

  constructor(private readonly opts: GenesysOptions) {}

  async *reply(_history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string> {
    const socket = await this.connect();
    const queue: string[] = [];
    let ended = false;
    let failure: Error | undefined;
    let gotText = false;
    let wake: () => void = () => {};
    let quietTimer: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      if (ended) return;
      ended = true;
      failure = err;
      wake();
    };
    const replyTimer = setTimeout(() => finish(new GenesysTimeoutError(this.opts.replyTimeoutMs)), this.opts.replyTimeoutMs);
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
      gotText = true;
      clearTimeout(replyTimer);
      queue.push(text);
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(), this.opts.quietMs);
      wake();
    };
    this.listeners.add(listener);

    try {
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
    }
  }

  /** The visitor left: drop this chat so the next visitor starts a new one. */
  endVisit(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Asks Genesys to end the conversation; the new token below is what
      // actually keeps visitors apart, so this is best effort.
      socket.send(
        JSON.stringify({
          action: "onMessage",
          token: this.token,
          message: { type: "Event", events: [{ eventType: "Presence", presence: { type: "Clear" } }] },
        }),
      );
      setTimeout(() => socket.close(), 200);
    } else {
      socket?.terminate();
    }
    this.token = randomUUID();
  }

  /** Opens the socket and starts a guest session, once per visitor. */
  private connect(): Promise<WebSocket> {
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) return this.ready;
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
        resolve(socket);
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
  lastError: string | undefined;

  constructor(
    private readonly primary: Brain & { name: string; screenFirst?: boolean; endVisit?(): void },
    private readonly backup: Brain,
    private readonly backupName: string,
  ) {}

  get screenFirst(): boolean {
    return this.primary.screenFirst ?? false;
  }

  async *reply(history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string> {
    this.lastAnsweredBy = this.primary.name;
    let spoke = false;
    try {
      for await (const sentence of this.primary.reply(history, visitorText, signal)) {
        spoke = true;
        yield sentence;
      }
      if (spoke || signal.aborted) return;
      this.lastError = `${this.primary.name} sent no words`;
    } catch (err) {
      if (signal.aborted) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`${this.primary.name} failed, ${spoke ? "reply cut short" : `${this.backupName} answers`}: ${this.lastError}`);
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
