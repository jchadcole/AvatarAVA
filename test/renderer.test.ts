import { describe, expect, it } from "vitest";
import { anamSessionBody } from "../src/server/anam.ts";
import { pickRenderer, readEnv, SANDBOX_AVATAR_ID } from "../src/server/config.ts";

const show = { renderer: "liveavatar" as const, avatarId: "la-avatar", anamAvatarId: "anam-avatar" };

describe("pickRenderer", () => {
  it("defaults to LiveAvatar, with the sandbox avatar in sandbox mode", () => {
    const env = readEnv({ LIVEAVATAR_API_KEY: "k" });
    expect(pickRenderer(env, show)).toEqual({ renderer: "liveavatar", avatarId: SANDBOX_AVATAR_ID });
  });

  it("uses Anam when the show asks for it", () => {
    const env = readEnv({ ANAM_API_KEY: "k" });
    expect(pickRenderer(env, { ...show, renderer: "anam" })).toEqual({ renderer: "anam", avatarId: "anam-avatar" });
  });

  it("lets AVA_RENDERER and ANAM_AVATAR_ID override the show", () => {
    const env = readEnv({ AVA_RENDERER: "ANAM", ANAM_API_KEY: "k", ANAM_AVATAR_ID: "other" });
    expect(pickRenderer(env, show)).toEqual({ renderer: "anam", avatarId: "other" });
  });

  it("explains what is missing", () => {
    expect(() => pickRenderer(readEnv({ AVA_RENDERER: "anam" }), show)).toThrow(/ANAM_API_KEY/);
    expect(() => pickRenderer(readEnv({ ANAM_API_KEY: "k" }), { ...show, renderer: "anam", anamAvatarId: undefined })).toThrow(
      /anamAvatarId/,
    );
    expect(() => pickRenderer(readEnv({}), show)).toThrow(/LIVEAVATAR_API_KEY/);
    expect(() => readEnv({ AVA_RENDERER: "tavus" })).toThrow(/liveavatar or anam/);
  });
});

describe("anamSessionBody", () => {
  it("asks for audio passthrough so Anam only renders our voice", () => {
    expect(anamSessionBody({ avatarId: "a1" })).toEqual({ personaConfig: { avatarId: "a1", enableAudioPassthrough: true } });
  });
});
