import type { KnowledgeFile } from "./config.ts";

const STOPWORDS = new Set(
  "about after also been being both could does each from have here into just like make more most much only other over same some such than that their them then there these they this those through very want were what when where which while will with would your".split(
    " ",
  ),
);

/** Distinct lowercase words of four or more letters, minus common filler. */
function terms(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/**
 * Guesses which knowledge files a spoken answer drew on, for the backstage
 * screen. It scores each file by the answer's words it shares, weighting words
 * that appear in few files, so it names the closest match rather than proving
 * where a fact came from.
 */
export class SourceMatcher {
  private readonly files: { name: string; terms: Set<string> }[];
  private readonly weight = new Map<string, number>();

  constructor(files: KnowledgeFile[]) {
    this.files = files.map((f) => ({ name: f.name, terms: terms(f.text) }));
    const counts = new Map<string, number>();
    for (const file of this.files) for (const t of file.terms) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [t, n] of counts) this.weight.set(t, Math.log(this.files.length / n));
  }

  /** Up to `limit` file names, best first; empty when nothing matches well. */
  match(text: string, limit = 2): string[] {
    const answer = terms(text);
    const scored = this.files.map((file) => {
      let score = 0;
      let shared = 0;
      for (const t of answer) {
        const w = this.weight.get(t) ?? 0;
        if (w > 0 && file.terms.has(t)) {
          score += w;
          shared++;
        }
      }
      return { name: file.name, score, shared };
    });
    return scored
      .filter((s) => s.shared >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.name);
  }
}
