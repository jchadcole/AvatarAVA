/**
 * Asks the show's Genesys AVA one question and prints the answer and timing,
 * without the avatar or microphone. Usage:
 *   npm run genesys:check -- "What is Genesys Cloud?"
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShow, pickGenesys, readEnv } from "../src/server/config.ts";
import { GenesysBrain, looksLikeGreeting, webMessagingUrl } from "../src/server/genesys.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = readEnv();
const show = loadShow(path.join(root, "shows"), env.showName);
const settings = pickGenesys({ ...env, brain: "genesys" }, show);
if (!settings) throw new Error("unreachable");
const question = process.argv.slice(2).join(" ") || "What is Genesys Cloud?";

// This check always asks the AVA; say plainly whether npm start will too.
const appBrain = env.brain ?? show.brain;
console.log(`Show file: shows/${env.showName}/show.json ("brain": "${show.brain}"${env.brain ? `, AVA_BRAIN=${env.brain} in .env` : ""})`);
console.log(
  appBrain === "genesys"
    ? "npm start will answer with: the Genesys AVA (Claude only as backup)"
    : `npm start will answer with: CLAUDE, not the AVA. Set "brain": "genesys" in shows/${env.showName}/show.json to use the AVA.`,
);
console.log(`Connecting to ${webMessagingUrl(settings.region, settings.deploymentId)}`);
if (settings.warmUpText) console.log(`Warm-up: sending "${settings.warmUpText}" first, as the app does when a visitor taps Start.`);
console.log(`Asking: ${question}\n`);

const started = Date.now();
const seconds = () => ((Date.now() - started) / 1000).toFixed(1);
const brain = new GenesysBrain({
  ...settings,
  origin: settings.origin || undefined,
  // Show everything Genesys sends back, so a wrong bot or a hand-off is visible.
  onRaw: (raw) => {
    const m = raw as { type?: string; class?: string; code?: number; body?: Record<string, unknown> };
    const body = m.body ?? {};
    const parts = [`${seconds()} s`, m.class ?? m.type, body.direction, body.type, body.originatingEntity].filter(Boolean);
    const text = typeof body.text === "string" ? `: ${body.text}` : m.code && m.code >= 400 ? `: ${JSON.stringify(body)}` : "";
    console.log(`  [genesys] ${parts.join(" | ")}${text}`);
  },
});
const answer: string[] = [];
// The app opens the chat and warms the bot up while Ava greets the visitor,
// so time the question from when that is done.
await brain.prepare();
const asked = Date.now();
console.log(`  [genesys] ${seconds()} s | --- your question is sent now ---`);
const sinceAsked = () => ((Date.now() - asked) / 1000).toFixed(1);
let first: string | undefined;
try {
  for await (const sentence of brain.reply([], question, new AbortController().signal)) {
    first ??= sinceAsked();
    answer.push(sentence);
  }
  if (brain.lastWarmUpReply) {
    console.log(`\nBot's welcome line (sent at Start and skipped, so Ava never says it as an answer): ${brain.lastWarmUpReply}`);
  }
  if (!answer.length) {
    console.log("\nGENESYS CHECK FAILED: the AVA sent no words. Check the bot flow and that the AVA is published.");
    process.exitCode = 1;
  } else {
    console.log(`\nAVA ANSWER (exactly what Ava would say):\n${answer.join(" ")}\n`);
    if (looksLikeGreeting(answer.join(" "))) {
      console.log("Note: this looks like a welcome line rather than an answer, so the app would let Claude answer instead.");
    }
    console.log(`GENESYS CHECK OK: first words ${first} s after the question, whole answer after ${sinceAsked()} s.`);
    if (Number(first) * 1000 > settings.replyTimeoutMs) {
      console.log(`Note: that is slower than replyTimeoutMs (${settings.replyTimeoutMs} ms), so in the app Claude would answer instead. Raise replyTimeoutMs in show.json.`);
    }
  }
} catch (err) {
  console.log(`\nGENESYS CHECK FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  brain.endVisit();
  setTimeout(() => process.exit(), 300);
}
