import type { StampedInsight } from "../server/insights.ts";

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const feed = $("feed");
const connection = $("connection");

const STAGE_NAMES = {
  precheck: "Speech check",
  pattern: "Instant rule screen",
  classifier: "Safety classifier",
  output: "Answer screen",
  model: "Model safety",
} as const;

const LABEL_NAMES: Record<string, string> = {
  normal: "on topic",
  off_topic: "off topic, redirected",
  abusive: "abusive",
  injection: "tried to rewrite the rules",
  empty: "nothing heard",
  gibberish: "speech unclear",
  refusal: "declined",
};

const totals = { questions: 0, catches: 0, answered: 0, grounded: 0, latencies: [] as number[] };

/** The card for the question being handled now; guard and answer events land on it. */
let current: { card: HTMLElement; checks: HTMLElement } | null = null;

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function newCard(question: string): { card: HTMLElement; checks: HTMLElement } {
  $("empty")?.remove();
  const card = element("article", "turn");
  card.append(element("p", "question", question));
  const checks = element("div", "checks");
  card.append(checks);
  feed.prepend(card);
  while (feed.children.length > 80) feed.lastElementChild?.remove();
  return { card, checks };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function render(insight: StampedInsight): void {
  switch (insight.type) {
    case "visit":
      $("empty")?.remove();
      feed.prepend(
        element("p", "divider", insight.event === "start" ? "New visitor" : `Visit ended (${insight.reason ?? "done"})`),
      );
      current = null;
      break;
    case "visitor":
      totals.questions++;
      current = newCard(insight.text);
      break;
    case "guard": {
      current ??= newCard("(no words heard)");
      const label = LABEL_NAMES[insight.label] ?? insight.label;
      const timing = insight.ms ? ` · ${insight.ms} ms` : "";
      const tone = insight.acted ? "acted" : insight.label === "normal" ? "" : "notice";
      current.checks.append(element("span", `chip ${tone}`, `${STAGE_NAMES[insight.stage]}: ${label}${timing}`));
      if (insight.acted) {
        totals.catches++;
        current.card.classList.add("stopped");
      }
      break;
    }
    case "answer": {
      current ??= newCard("(no words heard)");
      current.card.append(element("p", "answer", insight.text));
      const meta = element("div", "meta");
      if (insight.canned) {
        meta.append(element("span", "", "Approved fixed line"));
      } else {
        totals.answered++;
        if (insight.sources.length) totals.grounded++;
        meta.append(
          element(
            "span",
            "",
            insight.sources.length
              ? `Closest knowledge: ${insight.sources.map((s) => s.replace(/^knowledge\//, "")).join(", ")}`
              : "No close knowledge match",
          ),
        );
      }
      if (insight.brain) {
        meta.append(element("span", insight.brain.includes("backup") ? "backup-voice" : "", `Brain: ${insight.brain}`));
      }
      for (const voice of insight.voices) {
        meta.append(element("span", voice.includes("backup") ? "backup-voice" : "", `Voice: ${voice}`));
      }
      if (insight.firstSentenceMs !== undefined) {
        totals.latencies.push(insight.firstSentenceMs);
        meta.append(element("span", "", `First sentence ready in ${seconds(insight.firstSentenceMs)}`));
      }
      current.card.append(meta);
      break;
    }
  }
  updateTotals();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function updateTotals(): void {
  $("stat-questions").textContent = String(totals.questions);
  $("stat-catches").textContent = String(totals.catches);
  $("stat-grounded").textContent = totals.answered
    ? `${Math.round((100 * totals.grounded) / totals.answered)}%`
    : "–";
  $("stat-latency").textContent = totals.latencies.length ? seconds(median(totals.latencies)) : "–";
}

function connect(): void {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/backstage-ws`);
  socket.onopen = () => {
    connection.textContent = "Live";
    connection.classList.add("live");
  };
  socket.onmessage = (event) => render(JSON.parse(event.data) as StampedInsight);
  socket.onclose = () => {
    connection.textContent = "Reconnecting…";
    connection.classList.remove("live");
    setTimeout(connect, 2000);
  };
}

connect();
void fetch("/api/show")
  .then((res) => res.json())
  .then((info: { voice?: string }) => {
    const badge = $("voice-badge");
    if (!info.voice) return;
    badge.textContent = `Voice: ${info.voice}`;
    badge.hidden = false;
  });
