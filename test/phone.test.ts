import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShow } from "../src/server/config.ts";
import type { ServerMessage } from "../src/server/conversation.ts";
import { linearToMulaw, mulawToLinear, pcm24kToMulaw8k } from "../src/server/phone/audio.ts";
import { apiKeyMatches, AudioConnectorSession, chooseMedia, type Media } from "../src/server/phone/audioConnector.ts";
import { PacedPlayer, PhoneCall, type CallConversation } from "../src/server/phone/call.ts";
import type { CallListenerEvents } from "../src/server/phone/listener.ts";
import { loadPhoneShow } from "../src/server/phone/phoneShow.ts";

afterEach(() => vi.useRealTimers());

describe("phone audio", () => {
  it("round-trips mu-law within G.711 precision", () => {
    for (const s of [0, 100, -100, 1000, -5000, 20000, -32768, 32767]) {
      const back = mulawToLinear(linearToMulaw(s));
      expect(Math.abs(back - s)).toBeLessThanOrEqual(Math.max(8, Math.abs(s) * 0.04));
    }
  });

  it("downsamples 24 kHz speech to a third as many 8 kHz samples, keeping a 1 kHz tone", () => {
    const pcm = Buffer.alloc(2400 * 2);
    for (let i = 0; i < 2400; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 1000 * i) / 24000)), i * 2);
    const out = pcm24kToMulaw8k(pcm);
    expect(out.length).toBe(800);
    const peak = Math.max(...[...out.subarray(100, 700)].map((b) => Math.abs(mulawToLinear(b))));
    expect(peak).toBeGreaterThan(8000);
    expect(peak).toBeLessThan(11000);
  });
});

class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: (Record<string, any> | Buffer)[] = [];
  send(data: string | Buffer) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  text(msg: object) {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
  messages() {
    return this.sent.filter((m) => !Buffer.isBuffer(m)) as Record<string, any>[];
  }
}

const mono: Media = { type: "audio", format: "PCMU", channels: ["external"], rate: 8000 };

describe("Genesys Audio Connector session", () => {
  function open(media: Media[] = [mono]) {
    const ws = new FakeSocket();
    const handler = { start: vi.fn(), audio: vi.fn(), close: vi.fn() };
    const session = new AudioConnectorSession(ws as any, "sess-1", () => handler, { log: () => {} });
    ws.text({ version: "2", type: "open", seq: 1, serverseq: 0, id: "sess-1", position: "PT0S", parameters: { media, supportedLanguages: true } });
    return { ws, handler, session };
  }

  it("answers open with the chosen media and starts the call", () => {
    const { ws, handler } = open();
    const [opened] = ws.messages();
    expect(opened).toMatchObject({ version: "2", type: "opened", seq: 1, clientseq: 1, id: "sess-1" });
    expect(opened.parameters).toEqual({ media: [mono], startPaused: false, supportedLanguages: ["en-US"] });
    expect(handler.start).toHaveBeenCalledOnce();
  });

  it("answers ping with pong and close with closed", () => {
    const { ws, handler } = open();
    ws.text({ version: "2", type: "ping", seq: 2, serverseq: 1, id: "sess-1", parameters: {} });
    ws.text({ version: "2", type: "close", seq: 3, serverseq: 2, id: "sess-1", parameters: { reason: "end" } });
    expect(ws.messages().map((m) => [m.type, m.seq, m.clientseq])).toEqual([
      ["opened", 1, 1],
      ["pong", 2, 2],
      ["closed", 3, 3],
    ]);
    expect(handler.close).toHaveBeenCalledOnce();
  });

  it("keeps only the caller's channel from stereo audio", () => {
    const { ws, handler } = open([{ ...mono, channels: ["external", "internal"] }]);
    ws.emit("message", Buffer.from([1, 9, 2, 9, 3, 9]), true);
    expect([...handler.audio.mock.calls[0][0]]).toEqual([1, 2, 3]);
  });

  it("sends audio as binary, barge-in as an event, and hangs up with disconnect", () => {
    const { ws, session } = open();
    session.sendAudio(Buffer.from([7, 7]));
    session.clearAudio();
    session.hangUp("idle");
    expect(Buffer.isBuffer(ws.sent[1])).toBe(true);
    const [, event, disconnect] = ws.messages();
    expect(event).toMatchObject({ type: "event", parameters: { entities: [{ type: "barge_in", data: {} }] } });
    expect(disconnect).toMatchObject({ type: "disconnect", parameters: { reason: "completed", info: "idle" } });
  });

  it("refuses offers it can't play and checks the API key", () => {
    expect(chooseMedia([{ ...mono, format: "L16" }])).toBeNull();
    expect(chooseMedia([{ ...mono, channels: ["external", "internal"] }, mono])).toEqual(mono);
    expect(apiKeyMatches("secret", "secret")).toBe(true);
    expect(apiKeyMatches("secreT", "secret")).toBe(false);
    expect(apiKeyMatches(undefined, "secret")).toBe(false);
  });
});

describe("PacedPlayer", () => {
  it("stays only a little ahead of playback and drops the rest on clear", () => {
    vi.useFakeTimers();
    const sent: Buffer[] = [];
    const player = new PacedPlayer((b) => sent.push(b), { chunkMs: 100, leadMs: 300 });
    player.enqueue(Buffer.alloc(8000)); // 1 s of audio
    expect(sent.length).toBe(3);
    vi.advanceTimersByTime(200);
    expect(sent.length).toBe(5);
    expect(player.playing).toBe(true);
    player.clear();
    vi.advanceTimersByTime(2000);
    expect(sent.length).toBe(5);
    expect(player.playing).toBe(false);
  });
});

function setupCall(settings: Partial<{ bargeIn: boolean; bargeInMinWords: number }> = {}) {
  let send!: (m: ServerMessage) => void;
  let events!: CallListenerEvents;
  const conversation: CallConversation & Record<string, any> = {
    greet: vi.fn(async () => {}),
    startListening: vi.fn(() => send({ type: "interrupt" })),
    handleVisitor: vi.fn(async () => {}),
    endVisit: vi.fn(),
    dispose: vi.fn(),
  };
  const line = { sendAudio: vi.fn(), clearAudio: vi.fn(), hangUp: vi.fn() };
  const call = new PhoneCall({
    makeConversation: (s) => ((send = s), conversation),
    stt: { open: (_k, e) => ((events = e), { write: vi.fn(), close: vi.fn() }) },
    keyterms: [],
    line,
    settings: { maxCallMinutes: 10, bargeIn: true, bargeInMinWords: 2, endpointingMs: 400, ...settings },
    voiceLine: async () => Buffer.alloc(4800),
    goodbye: "Bye!",
  });
  call.start();
  const say = (ms = 1000) => send({ type: "say", text: "Hi.", audio: Buffer.alloc(ms * 48).toString("base64") });
  return { call, conversation, line, events: () => events, send: (m: ServerMessage) => send(m), say };
}

describe("PhoneCall", () => {
  it("greets on start and answers each finished sentence", () => {
    const { conversation, events } = setupCall();
    expect(conversation.greet).toHaveBeenCalledOnce();
    events().onUtterance("What is Genesys Cloud?");
    expect(conversation.handleVisitor).toHaveBeenCalledWith("What is Genesys Cloud?");
  });

  it("stops Ava when the caller talks over her", () => {
    vi.useFakeTimers();
    const { conversation, line, events, say } = setupCall();
    say();
    events().onSpeech("um", false);
    expect(conversation.startListening).not.toHaveBeenCalled();
    events().onSpeech("wait, what", false);
    expect(conversation.startListening).toHaveBeenCalledOnce();
    expect(line.clearAudio).toHaveBeenCalledOnce();
    events().onSpeech("wait, what about", false);
    expect(conversation.startListening).toHaveBeenCalledOnce();
  });

  it("doesn't barge in when Ava is quiet or barge-in is off", () => {
    vi.useFakeTimers();
    const quiet = setupCall();
    quiet.events().onSpeech("hello there", false);
    expect(quiet.conversation.startListening).not.toHaveBeenCalled();
    const off = setupCall({ bargeIn: false });
    off.say();
    off.events().onSpeech("hello there", false);
    expect(off.conversation.startListening).not.toHaveBeenCalled();
  });

  it("joins a follow-on sentence to the question Ava hasn't answered yet", () => {
    const { conversation, events, say } = setupCall();
    events().onUtterance("What does the AVA do");
    events().onUtterance("for banks?");
    expect(conversation.handleVisitor).toHaveBeenLastCalledWith("What does the AVA do for banks?");
    say();
    events().onUtterance("And retail?");
    expect(conversation.handleVisitor).toHaveBeenLastCalledWith("And retail?");
  });

  it("says goodbye and hangs up when the visit ends", async () => {
    vi.useFakeTimers();
    const { line, send } = setupCall();
    send({ type: "end_visit", reason: "idle" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(line.sendAudio).toHaveBeenCalled();
    expect(line.hangUp).toHaveBeenCalledWith("idle");
  });
});

describe("phone.json", () => {
  it("overrides the screen-only lines and keeps the rest of the show", () => {
    const shows = path.resolve("shows");
    const show = loadShow(shows, "demo");
    const { show: phoneShow, phone } = loadPhoneShow(shows, "demo", show);
    expect(phoneShow.cannedLines.suggest).not.toMatch(/screen|tap/i);
    expect(phoneShow.cannedLines.deflectAbuse).toBe(show.cannedLines.deflectAbuse);
    expect(phoneShow.brain).toBe(show.brain);
    expect(phoneShow.suggestedQuestions).toEqual([]);
    expect(phone.bargeIn).toBe(true);
  });
});
