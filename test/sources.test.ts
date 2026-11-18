import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadShow } from "../src/server/config.ts";
import { SourceMatcher } from "../src/server/sources.ts";

describe("SourceMatcher", () => {
  const matcher = new SourceMatcher([
    { name: "knowledge/robots.md", text: "The Model X robot scans shelves overnight and flags empty facings." },
    { name: "knowledge/pricing-policy.md", text: "Booth staff handle pricing questions; quotes come from the sales team." },
    { name: "knowledge/company.md", text: "Founded in 2010, the company serves retailers across North America." },
  ]);

  it("names the file whose distinctive words the answer shares", () => {
    expect(matcher.match("Model X scans shelves overnight to find empty facings.")).toEqual(["knowledge/robots.md"]);
  });

  it("returns nothing when the answer barely overlaps any file", () => {
    expect(matcher.match("Happy to help! Enjoy the show.")).toEqual([]);
  });

  it("loads every knowledge file of the demo show", () => {
    const show = loadShow(path.resolve("shows"), "demo");
    expect(show.knowledgeFiles.length).toBeGreaterThan(1);
    expect(show.knowledge).toContain(`<source name="${show.knowledgeFiles[0].name}">`);
    const real = new SourceMatcher(show.knowledgeFiles);
    const sample = show.knowledgeFiles.at(-1)!;
    expect(real.match(sample.text.slice(0, 600))).toContain(sample.name);
  });
});
