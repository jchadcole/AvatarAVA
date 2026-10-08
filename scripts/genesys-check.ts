/**
 * Asks the show's Genesys AVA one question and prints the answer and timing,
 * without the avatar or microphone. Usage:
 *   npm run genesys:check -- "What is Genesys Cloud?"
 */
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadShow, pickGenesys, readEnv } from "../src/server/config.ts";
import { GenesysBrain, webMessagingUrl } from "../src/server/genesys.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = readEnv();
const show = loadShow(path.join(root, "shows"), env.showName);
const settings = pickGenesys({ ...env, brain: "genesys" }, show);
if (!settings) throw new Error("unreachable");
const question = process.argv.slice(2).join(" ") || "What is Genesys Cloud?";

console.log(`Connecting to ${webMessagingUrl(settings.region, settings.deploymentId)}`);
console.log(`Asking: ${question}`);
const brain = new GenesysBrain({ ...settings, origin: settings.origin || undefined });
const started = Date.now();
let first: number | undefined;
try {
  for await (const sentence of brain.reply([], question, new AbortController().signal)) {
    first ??= Date.now() - started;
    console.log(`  AVA: ${sentence}`);
  }
  if (first === undefined) {
    console.log("GENESYS CHECK FAILED: the AVA sent no words. Check the bot flow and that the AVA is published.");
    process.exitCode = 1;
  } else {
    console.log(`GENESYS CHECK OK: first words after ${(first / 1000).toFixed(1)} s, whole answer after ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  }
} catch (err) {
  console.log(`GENESYS CHECK FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  brain.endVisit();
  setTimeout(() => process.exit(), 300);
}
