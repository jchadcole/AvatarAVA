import type Anthropic from "@anthropic-ai/sdk";
import type { ShowConfig } from "./config.ts";
import { SentenceChunker } from "./speech.ts";

export type Turn = { role: "user" | "assistant"; content: string };

export class RefusalError extends Error {
  constructor() {
    super("Claude declined to answer");
  }
}

/** Streams the avatar's spoken reply, one sentence at a time. */
export interface Brain {
  reply(history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string>;
}

export class ClaudeBrain implements Brain {
  private readonly system: string;

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly effort: "low" | "medium" | "high" | "xhigh" | "max",
    show: ShowConfig,
  ) {
    // Frozen for the whole show so the prompt cache stays warm across visitors.
    this.system = `${show.persona.trim()}\n\n<booth_knowledge>\n${show.knowledge.trim()}\n</booth_knowledge>`;
  }

  async *reply(history: Turn[], visitorText: string, signal: AbortSignal): AsyncIterable<string> {
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 2048,
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages: [...history, { role: "user", content: visitorText }],
        output_config: { effort: this.effort },
        // If a safety classifier declines, retry server-side on Anthropic's recommended model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    const chunker = new SentenceChunker();
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield* chunker.push(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new RefusalError();
    yield* chunker.flush();
  }
}
