import { afterEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTts, FallbackTts, type Tts } from "../src/server/voice.ts";

afterEach(() => vi.unstubAllGlobals());

describe("ElevenLabsTts", () => {
  it("streams raw 24 kHz PCM for the show's voice and joins the chunks", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob([new Uint8Array([1, 2]), new Uint8Array([3])])));
    vi.stubGlobal("fetch", fetchMock);
    const audio = await new ElevenLabsTts("key", "voice-123", "eleven_flash_v2_5").synthesize("Hello there.");
    expect([...audio]).toEqual([1, 2, 3]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/voice-123/stream?output_format=pcm_24000",
    );
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe("key");
    expect(JSON.parse(init.body as string)).toEqual({ text: "Hello there.", model_id: "eleven_flash_v2_5" });
  });

  it("throws on an error response so the fallback can take over", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("voice not found", { status: 404 })));
    await expect(new ElevenLabsTts("key", "bad", "m").synthesize("Hi")).rejects.toThrow(/404/);
  });
});

describe("FallbackTts", () => {
  const backup: Tts = { synthesize: async () => Buffer.from("backup") };
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  it("uses the premium voice when it works", async () => {
    const tts = new FallbackTts({ synthesize: async () => Buffer.from("premium") }, backup);
    expect((await tts.synthesize("Hi")).toString()).toBe("premium");
  });

  it("falls back on an error or a slow response", async () => {
    quiet();
    const failing = new FallbackTts({ synthesize: async () => Promise.reject(new Error("down")) }, backup);
    expect((await failing.synthesize("Hi")).toString()).toBe("backup");
    const slow = new FallbackTts(
      {
        synthesize: (_t, signal) =>
          new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
      },
      backup,
      { timeoutMs: 20 },
    );
    expect((await slow.synthesize("Hi")).toString()).toBe("backup");
  });

  it("skips the premium voice for a cooldown after repeated failures, then tries again", async () => {
    quiet();
    let clock = 0;
    const primary = vi.fn(async () => {
      throw new Error("down");
    });
    const tts = new FallbackTts({ synthesize: primary }, backup, { maxFailures: 2, cooldownMs: 1000, now: () => clock });
    await tts.synthesize("a");
    await tts.synthesize("b");
    await tts.synthesize("c");
    expect(primary).toHaveBeenCalledTimes(2);
    clock = 1000;
    await tts.synthesize("d");
    expect(primary).toHaveBeenCalledTimes(3);
  });

  it("labels each line with the voice that spoke it and keeps the failure reason", async () => {
    quiet();
    let fail = false;
    const tts = new FallbackTts(
      { synthesize: async () => (fail ? Promise.reject(new Error("401 invalid key")) : Buffer.from("premium")) },
      { synthesize: async () => Buffer.from("backup") },
      { primaryName: "ElevenLabs", backupName: "Deepgram" },
    );
    expect(tts.voiceOf(await tts.synthesize("a"))).toBe("ElevenLabs");
    fail = true;
    expect(tts.voiceOf(await tts.synthesize("b"))).toBe("Deepgram (backup)");
    expect(tts.lastError).toContain("401 invalid key");
  });

  it("does not fall back when the turn itself was cancelled", async () => {
    const ac = new AbortController();
    const tts = new FallbackTts(
      {
        synthesize: (_t, signal) =>
          new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
      },
      backup,
    );
    const pending = tts.synthesize("Hi", ac.signal);
    ac.abort();
    await expect(pending).rejects.toThrow("aborted");
  });
});
