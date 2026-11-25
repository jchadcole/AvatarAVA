import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ShowConfig } from "../config.ts";

/**
 * Phone-only settings, read from shows/<show>/phone.json when it exists.
 * Everything else (brain, voice, guardrails, knowledge) comes from show.json,
 * exactly as the kiosk uses it.
 */
const PhoneFile = z.object({
  /** Spoken first when the brain is Claude. The Genesys AVA greets callers itself. */
  greeting: z.string().optional(),
  /** Replaces kiosk lines that mention the screen or the booth, e.g. "tap one of the options". */
  cannedLines: z
    .object({
      didNotCatch: z.string(),
      suggest: z.string(),
      deflectAbuse: z.string(),
      endSession: z.string(),
      deflectInjection: z.string(),
      safeFallback: z.string(),
      error: z.string(),
      goodbye: z.string(),
    })
    .partial()
    .default({}),
  /** Silence (after Ava finishes sending a reply) before Ava says goodbye and hangs up. */
  idleResetSeconds: z.number().int().positive().optional(),
  /** Longest call before Ava says goodbye and hangs up, to cap cost. */
  maxCallMinutes: z.number().positive().default(10),
  /** true: the caller can talk over Ava and she stops to listen. */
  bargeIn: z.boolean().default(true),
  /** Words the caller must say over Ava before she stops, so a cough doesn't cut her off. */
  bargeInMinWords: z.number().int().positive().default(2),
  /** Silence that ends the caller's sentence. Lower answers sooner but may cut slow talkers off. */
  endpointingMs: z.number().int().min(10).max(5000).default(400),
});

export type PhoneSettings = Omit<z.infer<typeof PhoneFile>, "greeting" | "cannedLines" | "idleResetSeconds">;

/** The show as the phone line uses it: show.json with phone.json's overrides on top. */
export function loadPhoneShow(showsDir: string, name: string, show: ShowConfig): { show: ShowConfig; phone: PhoneSettings } {
  const file = path.join(showsDir, name, "phone.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const { greeting, cannedLines, idleResetSeconds, ...phone } = PhoneFile.parse(raw);
  return {
    show: {
      ...show,
      greeting: greeting ?? show.greeting,
      cannedLines: { ...show.cannedLines, ...cannedLines },
      idleResetSeconds: idleResetSeconds ?? show.idleResetSeconds,
      // Nothing to tap on a phone call.
      suggestedQuestions: [],
    },
    phone,
  };
}
