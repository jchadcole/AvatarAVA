/**
 * What the backstage screen shows as the avatar talks: each question, which
 * guardrail looked at it and what it decided, and the answer with its likely
 * knowledge sources and timing. Text only, the same as the transcript log.
 */
export type Insight =
  | { type: "visit"; event: "start" | "end"; reason?: string }
  | { type: "visitor"; text: string }
  | {
      type: "guard";
      /** precheck: empty or garbled speech. pattern: instant rule-rewrite screen. output: per-sentence screen. */
      stage: "precheck" | "pattern" | "classifier" | "output" | "model";
      label: string;
      /** True when this check changed what the avatar said. */
      acted: boolean;
      ms?: number;
    }
  | { type: "answer"; text: string; canned: boolean; firstSentenceMs?: number; totalMs: number; sources: string[] };

export type StampedInsight = Insight & { ts: string };

/** Fans insights out to every open backstage screen. */
export class InsightHub {
  private readonly listeners = new Set<(insight: StampedInsight) => void>();

  publish(insight: Insight): void {
    const stamped = { ...insight, ts: new Date().toISOString() };
    for (const listener of this.listeners) listener(stamped);
  }

  subscribe(listener: (insight: StampedInsight) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
