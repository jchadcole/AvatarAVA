import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadShow } from "../src/server/config.ts";

const showsDir = path.join(import.meta.dirname, "..", "shows");

function tempShow(screen?: object): string {
  const base = JSON.parse(fs.readFileSync(path.join(showsDir, "demo", "show.json"), "utf8"));
  delete base.screen;
  if (screen) base.screen = screen;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "show-"));
  fs.mkdirSync(path.join(dir, "t"));
  fs.writeFileSync(path.join(dir, "t", "show.json"), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, "t", "persona.md"), "You are {{avatarName}}.");
  fs.writeFileSync(path.join(dir, "t", "knowledge.md"), "Facts.");
  return dir;
}

describe("kiosk screen settings", () => {
  it("defaults to 'Meet <avatar>' with the name in the accent color", () => {
    const show = loadShow(tempShow(), "t");
    expect(show.screen.headline).toBe("Meet Ava");
    expect(show.screen.accentText).toBe("Ava");
    expect(show.screen.logo).toBe("");
  });

  it("fills placeholders and keeps the show's own text", () => {
    const show = loadShow(tempShow({ headline: "Talk to {{avatarName}} at {{eventName}}", subtitle: "{{company}} booth" }), "t");
    expect(show.screen.headline).toBe("Talk to Ava at Demo Show");
    expect(show.screen.subtitle).toBe("Genesys booth");
    expect(show.screen.accentColor).toBe("#ff4f1f");
  });

  it("reads the demo show's header", () => {
    const show = loadShow(showsDir, "demo");
    expect(show.screen).toMatchObject({ headline: "Meet AVA", accentText: "AVA", logoText: "GENESYS" });
  });
});
