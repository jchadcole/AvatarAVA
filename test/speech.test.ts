import { describe, expect, it } from "vitest";
import { SentenceChunker, cleanForSpeech } from "../src/server/speech.ts";

describe("SentenceChunker", () => {
  it("emits sentences as soon as they complete", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Hi there, welcome to the booth! The Model")).toEqual(["Hi there, welcome to the booth!"]);
    expect(chunker.push(" X scans 2.5 aisles an hour. Want")).toEqual(["The Model X scans 2.5 aisles an hour."]);
    expect(chunker.flush()).toEqual(["Want"]);
  });

  it("lets a long first sentence start at a clause break, then goes back to whole sentences", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Agent Copilot works right alongside your agents, surfacing knowledge")).toEqual([
      "Agent Copilot works right alongside your agents,",
    ]);
    expect(chunker.push(" and next steps, live. Afterward, it writes the summary. ")).toEqual([
      "surfacing knowledge and next steps, live.",
      "Afterward, it writes the summary.",
    ]);
  });

  it("keeps short openers and number commas whole", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Sure, happy to help with that ")).toEqual([]);
    expect(chunker.push("question about 2,500 seats. ")).toEqual(["Sure, happy to help with that question about 2,500 seats."]);
    expect(new SentenceChunker(12, 0).push("Agent Copilot works right alongside your agents, surfacing")).toEqual([]);
  });

  it("merges very short fragments into the next sentence", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Yes. That works well for big warehouses. ")).toEqual([
      "Yes. That works well for big warehouses.",
    ]);
  });
});

describe("cleanForSpeech", () => {
  it("strips markdown, links, emoji and stage directions but keeps bold words", () => {
    expect(cleanForSpeech("**Model X** is great 🎉 [smiles] see https://acme.example *waves*")).toBe(
      "Model X is great see",
    );
  });
});
