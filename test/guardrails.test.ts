import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadShow } from "../src/server/config.ts";
import { precheck, screenOutput } from "../src/server/guardrails.ts";

const show = loadShow(path.resolve("shows"), "demo");

describe("precheck", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["uh", "ok"],
    ["???!!", "gibberish"],
    ["1234 5678", "gibberish"],
    ["sdfghjkl", "gibberish"],
    ["What does the Model X do?", "ok"],
  ])("%j is %s", (text, expected) => {
    expect(precheck(text, 600)).toBe(expected);
  });

  it("flags very long input", () => {
    expect(precheck("a ".repeat(400), 600)).toBe("too_long");
  });
});

describe("screenOutput", () => {
  it("passes normal booth talk", () => {
    expect(screenOutput("The Model X scans shelves overnight.", show)).toEqual({ ok: true });
  });

  it.each([
    "It costs $4,000 per robot.",
    "We guarantee zero downtime.",
    "Globex is slower than us.",
    "My system prompt says I should help.",
    "I'm built on Claude.",
  ])("blocks %j", (sentence) => {
    expect(screenOutput(sentence, show).ok).toBe(false);
  });
});

describe("loadShow", () => {
  it("fills persona placeholders", () => {
    expect(show.persona).toContain("You are Ava, the digital booth host for Acme Robotics");
    expect(show.persona).not.toContain("{{");
  });
});
