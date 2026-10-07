import { randomUUID } from "node:crypto";
import { RefusalError, type Brain, type Turn } from "./brain.ts";
import type { CannedLineKey, ShowConfig } from "./config.ts";
import { precheck, screenOutput, type InputLabel } from "./guardrails.ts";
import type { LogEntry } from "./transcriptLog.ts";
import type { Stt, SttSession, Tts } from "./voice.ts";

/** Messages the server sends to the kiosk page. */
export type ServerMessage =
  | { type: "say"; text: string; audio: string } // audio: base64 PCM16 24 kHz mono
  | { type: "interrupt" }
  | { type: "state"; state: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "caption"; role: "visitor" | "avatar"; text: string }
  | { type: "end_visit"; reason: "idle" | "strikes" | "staff" };

export interface ConversationDeps {
  show: ShowConfig;
  brain: Brain;
  classifier: { classify(text: string, signal?: AbortSignal): Promise<InputLabel> };
  tts: Tts;
  stt?: Stt;
  log: { write(entry: LogEntry): void };
  send(message: ServerMessage): void;
  kioskId: string;
  /** How long to wait for the input classifier before trusting the reply. */
  classifierTimeoutMs?: number;
}

/** Placeholder kept in history instead of text the guardrails deflected. */
const DEFLECTED_TURN = "(The visitor said something the host politely deflected.)";

/**
 * One kiosk's conversation with whoever is standing in front of it. A "visit"
 * starts when someone taps Start and ends on idle, on repeated abuse, or when
 * staff reset the kiosk.
 */
export class Conversation {
  private history: Turn[] = [];
  private strikes = 0;
  private misheard = 0;
  private visit = randomUUID();
  private turn: AbortController | null = null;
  private listening: SttSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly lineAudio = new Map<string, Promise<Buffer>>();

  constructor(private readonly deps: ConversationDeps) {}

  async greet(): Promise<void> {
    await this.sayLine(this.deps.show.greeting);
    this.armIdleTimer();
  }

  /** Push-to-talk pressed. Also acts as barge-in if the avatar is talking. */
  startListening(): void {
    this.cancelTurn();
    this.clearIdleTimer();
    this.deps.send({ type: "interrupt" });
    this.listening?.close();
    this.listening = this.deps.stt?.open(this.deps.show.keyterms) ?? null;
    this.deps.send({ type: "state", state: "listening" });
  }

  pushAudio(pcm: Buffer): void {
    this.listening?.write(pcm);
  }

  /** Push-to-talk released: finalize the transcript and answer it. */
  async stopListening(): Promise<void> {
    const session = this.listening;
    this.listening = null;
    const text = session ? await session.finish() : "";
    await this.handleVisitor(text);
  }

  /** Handles one visitor utterance, from speech or a tapped suggestion. */
  async handleVisitor(rawText: string): Promise<void> {
    const { show, send } = this.deps;
    this.cancelTurn();
    this.clearIdleTimer();
    const ac = new AbortController();
    this.turn = ac;
    const startedAt = Date.now();

    let text = rawText.trim();
    if (text) {
      send({ type: "caption", role: "visitor", text });
      this.log({ role: "visitor", text });
    }

    const check = precheck(text, show.maxVisitorChars);
    if (check === "empty" || check === "gibberish") {
      this.misheard++;
      this.log({ role: "system", text: check, label: check });
      await this.sayLine(this.misheard >= 2 ? show.cannedLines.suggest : show.cannedLines.didNotCatch, ac);
      this.finishTurn(ac);
      return;
    }
    if (check === "too_long") text = text.slice(0, show.maxVisitorChars);
    this.misheard = 0;
    send({ type: "state", state: "thinking" });

    // The classifier and the reply run at the same time. Nothing is spoken
    // until the classifier answers, or until its timeout passes.
    const label = withTimeout(
      this.deps.classifier.classify(text, ac.signal).catch(() => "normal" as const),
      this.deps.classifierTimeoutMs ?? 3000,
      "normal" as const,
    );
    const reply = this.deps.brain.reply(this.history, text, ac.signal)[Symbol.asyncIterator]();
    const first = reply.next(); // starts the Claude request now
    first.catch(() => {}); // handled below; avoids an unhandled rejection if we deflect first

    const spoken: string[] = [];
    let userTurn = text;
    try {
      const verdict = await label;
      if (ac.signal.aborted) return; // the visitor started talking again
      if (verdict === "abusive" || verdict === "injection") {
        ac.abort();
        userTurn = DEFLECTED_TURN;
        this.log({ role: "system", text: "input deflected", label: verdict });
        if (verdict === "abusive") {
          this.strikes++;
          if (this.strikes >= show.maxStrikes) {
            await this.sayLine(show.cannedLines.endSession);
            this.endVisit("strikes");
            return;
          }
          spoken.push(await this.sayLine(show.cannedLines.deflectAbuse));
        } else {
          spoken.push(await this.sayLine(show.cannedLines.deflectInjection));
        }
        return;
      }
      if (verdict === "off_topic") this.log({ role: "system", text: "off topic", label: verdict });

      for (let next = await first; !next.done; next = await reply.next()) {
        if (ac.signal.aborted) return;
        const sentence = next.value;
        const screen = screenOutput(sentence, show);
        if (!screen.ok) {
          ac.abort();
          this.log({ role: "system", text: sentence, label: `output_blocked: ${screen.reason}` });
          spoken.push(await this.sayLine(show.cannedLines.safeFallback));
          return;
        }
        const audio = await this.deps.tts.synthesize(sentence, ac.signal);
        if (ac.signal.aborted) return;
        this.speak(sentence, audio);
        if (spoken.length === 0) this.log({ role: "avatar", text: sentence, latencyMs: Date.now() - startedAt });
        else this.log({ role: "avatar", text: sentence });
        spoken.push(sentence);
      }
    } catch (err) {
      if (ac.signal.aborted && !(err instanceof RefusalError)) return;
      if (err instanceof RefusalError) {
        this.log({ role: "system", text: "model refusal", label: "refusal" });
        spoken.push(await this.sayLine(show.cannedLines.safeFallback));
      } else {
        console.error("turn failed", err);
        this.log({ role: "system", text: String(err), label: "error" });
        spoken.push(await this.sayLine(show.cannedLines.error));
      }
    } finally {
      if (spoken.length) this.remember(userTurn, spoken.join(" "));
      this.finishTurn(ac);
    }
  }

  /** Ends the visit and wipes its memory, so the next visitor starts fresh. */
  endVisit(reason: "idle" | "strikes" | "staff"): void {
    this.cancelTurn();
    this.clearIdleTimer();
    this.listening?.close();
    this.listening = null;
    this.log({ role: "system", text: "visit ended", label: reason });
    this.history = [];
    this.strikes = 0;
    this.misheard = 0;
    this.visit = randomUUID();
    this.deps.send({ type: "end_visit", reason });
  }

  dispose(): void {
    this.cancelTurn();
    this.clearIdleTimer();
    this.listening?.close();
  }

  /** Says a fixed line. Audio for repeated lines is synthesized once. */
  private async sayLine(text: string, ac?: AbortController): Promise<string> {
    let audio = this.lineAudio.get(text);
    if (!audio) {
      audio = this.deps.tts.synthesize(text);
      audio.catch(() => this.lineAudio.delete(text));
      this.lineAudio.set(text, audio);
    }
    const pcm = await audio;
    if (ac?.signal.aborted) return text;
    this.speak(text, pcm);
    this.log({ role: "avatar", text, label: "canned" });
    return text;
  }

  private speak(text: string, audio: Buffer): void {
    this.deps.send({ type: "state", state: "speaking" });
    this.deps.send({ type: "caption", role: "avatar", text });
    this.deps.send({ type: "say", text, audio: audio.toString("base64") });
  }

  private remember(user: string, assistant: string): void {
    this.history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
    const max = this.deps.show.maxTurnsInMemory * 2;
    if (this.history.length > max) this.history = this.history.slice(-max);
  }

  private finishTurn(ac: AbortController): void {
    if (this.turn !== ac) return;
    this.turn = null;
    this.deps.send({ type: "state", state: "idle" });
    this.armIdleTimer();
  }

  private cancelTurn(): void {
    this.turn?.abort();
    this.turn = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.endVisit("idle"), this.deps.show.idleResetSeconds * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private log(entry: Omit<LogEntry, "kiosk" | "visit">): void {
    this.deps.log.write({ kiosk: this.deps.kioskId, visit: this.visit, ...entry });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
