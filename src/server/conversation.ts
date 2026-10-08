import { randomUUID } from "node:crypto";
import { RefusalError, type Brain, type Turn } from "./brain.ts";
import type { CannedLineKey, ShowConfig } from "./config.ts";
import { precheck, quickScreen, screenOutput, type InputLabel } from "./guardrails.ts";
import type { Insight } from "./insights.ts";
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
  /** How long speech waits for the input classifier before it starts anyway. */
  classifierGateMs?: number;
  /** Audio for fixed lines, shared across kiosks' conversations (see warmLines). */
  lineAudio?: Map<string, Promise<Buffer>>;
  /** Receives what the backstage screen shows. */
  insight?(insight: Insight): void;
  /** Names the knowledge files an answer most likely came from. */
  sources?: { match(text: string): string[] };
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
  private readonly lineAudio: Map<string, Promise<Buffer>>;

  constructor(private readonly deps: ConversationDeps) {
    this.lineAudio = deps.lineAudio ?? new Map();
  }

  async greet(): Promise<void> {
    this.insight({ type: "visit", event: "start" });
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
      this.insight({ type: "visitor", text });
    }

    const check = precheck(text, show.maxVisitorChars);
    if (check === "empty" || check === "gibberish") {
      this.misheard++;
      this.log({ role: "system", text: check, label: check });
      this.insight({ type: "guard", stage: "precheck", label: check, acted: true });
      await this.sayLine(this.misheard >= 2 ? show.cannedLines.suggest : show.cannedLines.didNotCatch, ac);
      this.finishTurn(ac);
      return;
    }
    if (check === "too_long") text = text.slice(0, show.maxVisitorChars);
    this.misheard = 0;
    send({ type: "state", state: "thinking" });

    // The classifier and the reply start together. Speech waits for the
    // classifier only briefly; after that the avatar starts talking and a late
    // "abusive" or "injection" verdict cuts it off mid-reply.
    let verdict: InputLabel | undefined = quickScreen(text) ?? undefined;
    const flagged = () => verdict === "abusive" || verdict === "injection";
    if (verdict) this.insight({ type: "guard", stage: "pattern", label: verdict, acted: flagged(), ms: 0 });
    const spoken: string[] = [];
    let firstSentenceMs: number | undefined;
    let canned = false;
    let classified: Promise<void> = Promise.resolve();
    try {
      if (!flagged()) {
        const classifyStart = Date.now();
        classified = this.deps.classifier.classify(text, ac.signal).then(
          (label) => {
            verdict = label;
            if (this.turn === ac) {
              this.insight({ type: "guard", stage: "classifier", label, acted: flagged(), ms: Date.now() - classifyStart });
            }
            if (flagged()) ac.abort();
          },
          () => {}, // a failed classification never blocks the reply
        );
        const reply = this.deps.brain.reply(this.history, text, ac.signal)[Symbol.asyncIterator]();
        const first = reply.next(); // starts the Claude request now
        first.catch(() => {}); // handled below; avoids an unhandled rejection if we deflect first
        await raceTimeout(classified, this.deps.classifierGateMs ?? 800);
        if (!flagged() && !ac.signal.aborted) {
          for (let next = await first; !next.done; next = await reply.next()) {
            if (ac.signal.aborted) break;
            const sentence = next.value;
            const screen = screenOutput(sentence, show);
            if (!screen.ok) {
              ac.abort();
              this.log({ role: "system", text: sentence, label: `output_blocked: ${screen.reason}` });
              this.insight({ type: "guard", stage: "output", label: screen.reason, acted: true });
              canned = true;
              spoken.push(await this.sayLine(show.cannedLines.safeFallback));
              break;
            }
            const audio = await this.deps.tts.synthesize(sentence, ac.signal);
            if (ac.signal.aborted) break;
            this.speak(sentence, audio);
            if (!spoken.length) firstSentenceMs = Date.now() - startedAt;
            this.log({ role: "avatar", text: sentence, latencyMs: spoken.length ? undefined : firstSentenceMs });
            spoken.push(sentence);
          }
        }
      }
    } catch (err) {
      if (err instanceof RefusalError) {
        this.log({ role: "system", text: "model refusal", label: "refusal" });
        this.insight({ type: "guard", stage: "model", label: "refusal", acted: true });
        canned = true;
        spoken.push(await this.sayLine(show.cannedLines.safeFallback));
      } else if (!ac.signal.aborted) {
        console.error("turn failed", err);
        this.log({ role: "system", text: String(err), label: "error" });
        canned = true;
        spoken.push(await this.sayLine(show.cannedLines.error));
      }
    }

    // A short reply can finish before the classifier does. The avatar is still
    // talking, so wait for the verdict here rather than let it go unchecked.
    if (verdict === undefined && this.turn === ac && !ac.signal.aborted) await raceTimeout(classified, 5000);

    // The classifier sets `verdict` from a callback, so read it fresh here.
    const final = verdict as InputLabel | undefined;

    // A barge-in replaced this turn: the new turn owns the conversation now.
    if (this.turn !== ac) {
      if (spoken.length) this.remember(text, spoken.join(" "));
      return;
    }
    if (final === "off_topic") this.log({ role: "system", text: "off topic", label: final });
    if (final === "abusive" || final === "injection") {
      ac.abort();
      if (spoken.length) send({ type: "interrupt" });
      this.log({ role: "system", text: "input deflected", label: final });
      if (final === "abusive" && ++this.strikes >= show.maxStrikes) {
        this.answered(await this.sayLine(show.cannedLines.endSession), true, startedAt);
        this.endVisit("strikes");
        return;
      }
      const line = final === "abusive" ? show.cannedLines.deflectAbuse : show.cannedLines.deflectInjection;
      const said = await this.sayLine(line);
      this.remember(DEFLECTED_TURN, said);
      this.answered(said, true, startedAt);
    } else if (spoken.length) {
      this.remember(text, spoken.join(" "));
      this.answered(spoken.join(" "), canned, startedAt, firstSentenceMs);
    }
    this.finishTurn(ac);
  }

  /** Ends the visit and wipes its memory, so the next visitor starts fresh. */
  endVisit(reason: "idle" | "strikes" | "staff"): void {
    this.cancelTurn();
    this.clearIdleTimer();
    this.listening?.close();
    this.listening = null;
    this.log({ role: "system", text: "visit ended", label: reason });
    this.insight({ type: "visit", event: "end", reason });
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

  private answered(text: string, canned: boolean, startedAt: number, firstSentenceMs?: number): void {
    const sources = canned ? [] : (this.deps.sources?.match(text) ?? []);
    this.insight({ type: "answer", text, canned, firstSentenceMs, totalMs: Date.now() - startedAt, sources });
  }

  private insight(insight: Insight): void {
    this.deps.insight?.(insight);
  }

  private log(entry: Omit<LogEntry, "kiosk" | "visit">): void {
    this.deps.log.write({ kiosk: this.deps.kioskId, visit: this.visit, ...entry });
  }
}

/**
 * Synthesizes the greeting and every canned line ahead of time, so the first
 * visitor hears them without waiting on text-to-speech.
 */
export async function warmLines(show: ShowConfig, tts: Tts, cache: Map<string, Promise<Buffer>>): Promise<void> {
  // One at a time: voice plans cap parallel requests (ElevenLabs free allows 4),
  // and a burst at startup would push lines onto the backup voice.
  for (const text of new Set([show.greeting, ...Object.values(show.cannedLines)])) {
    if (cache.has(text)) continue;
    const audio = tts.synthesize(text);
    cache.set(text, audio);
    await audio.catch((err) => {
      cache.delete(text);
      console.warn(`Could not pre-synthesize "${text}":`, err);
    });
  }
}

/** Waits for the promise, but never longer than `ms`. */
function raceTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() =>
    clearTimeout(timer),
  );
}
