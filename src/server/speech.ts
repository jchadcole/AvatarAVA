/**
 * Turns streamed model text into speakable sentences, so text-to-speech can
 * start on the first sentence instead of waiting for the whole reply.
 */
export class SentenceChunker {
  private buffer = "";

  constructor(private readonly minChars = 12) {}

  /** Adds streamed text and returns any sentences that are now complete. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    // A sentence ends at . ! or ? (optionally followed by a closing quote or
    // bracket) and then whitespace. Decimals like "2.5" have no space after
    // the dot, so they never split.
    const boundary = /[.!?]+["')\]]?\s+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence.length >= this.minChars) {
        out.push(sentence);
        start = end;
      }
    }
    this.buffer = this.buffer.slice(start);
    return out.map(cleanForSpeech).filter(Boolean);
  }

  /** Returns whatever is left once the stream has ended. */
  flush(): string[] {
    const rest = cleanForSpeech(this.buffer.trim());
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

/** Removes formatting the model should not produce but sometimes does. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/(\*\*|__)([^*_]+)\1/g, "$2") // bold keeps its words
    .replace(/\[[^\]]*\]|\*[^*]+\*/g, " ") // stage directions like [smiles] or *waves*
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#*_`>|~]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
