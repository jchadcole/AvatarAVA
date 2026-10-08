import fs from "node:fs";
import path from "node:path";

export interface LogEntry {
  kiosk: string;
  visit: string;
  role: "visitor" | "avatar" | "system";
  text: string;
  /** Guardrail outcome, such as "abusive" or "output_blocked: price mentioned". */
  label?: string;
  /** Milliseconds from end of visitor speech to the first sentence being sent. */
  latencyMs?: number;
}

/**
 * Appends one JSON line per event to logs/YYYY-MM-DD.jsonl. Text only: no
 * audio and no images are ever stored.
 */
export class TranscriptLog {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  write(entry: LogEntry): void {
    const ts = new Date().toISOString();
    const file = path.join(this.dir, `${ts.slice(0, 10)}.jsonl`);
    fs.appendFile(file, JSON.stringify({ ts, ...entry }) + "\n", (err) => {
      if (err) console.error("transcript log write failed", err);
    });
  }
}
