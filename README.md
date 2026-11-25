# AvatarAva

A trade-show booth demo where visitors talk to a realistic human avatar. This is the **pilot**: a hosted LiveAvatar face driven by our own speech-to-text, Claude brain, guardrails and voice, so the brain carries over unchanged when we move to a local MetaHuman build later.

## How it works

```
Kiosk browser                        Kiosk server (Node)                     Cloud
-------------                        -------------------                     -----
Hold-to-talk mic  --PCM 16 kHz-->    Deepgram STT session      ------->      Deepgram
                                     Conversation:
                                       1. local precheck (empty, gibberish, too long)
                                       2. Claude input classifier  --+   --> Claude
                                       3. Claude reply, streamed     |       (in parallel)
                                          sentence by sentence  <----+
                                       4. output screen per sentence
                                     Deepgram TTS (PCM 24 kHz) ------->      Deepgram
LiveAvatar web SDK <--say(audio)--   
  repeatAudio() ---------------------------------------------------->      LiveAvatar (LITE)
  <video> <-- lip-synced avatar stream (LiveKit) <-------------------
```

- **Face:** [LiveAvatar](https://www.liveavatar.com/) in LITE ("Avatar Only") mode. The server mints a session token with the API key; the browser only sees the token and uses `@heygen/liveavatar-web-sdk` to show the video and send our audio.
- **Brain:** Claude by default (or a Genesys AVA, see below), with the persona and booth knowledge in a cached system prompt (`shows/<show>/persona.md`, `knowledge.md`). Replies stream and are spoken sentence by sentence.
- **Guardrails:** a local precheck (empty, gibberish, too long) and an instant pattern screen for obvious rule-rewriting attempts; a Claude input classifier (`normal`, `off_topic`, `abusive`, `injection`) that starts with the reply, gets a short head start (800 ms), and can cut the avatar off mid-reply if it flags the input late; a per-sentence output screen (blocked terms, competitors, prices, prompt leaks); canned deflection lines; a strike limit that ends the visit; and server-side model fallback on refusals.
- **Visits:** a visitor taps Start, talks with push-to-talk (button or spacebar) or taps a suggested question. Memory is wiped when the visit ends on idle, on repeated abuse, or on a staff reset (tap the top-left corner three times).
- **Logs:** text-only transcripts with guardrail labels and first-sentence latency, one JSON line per event in `logs/YYYY-MM-DD.jsonl`. No audio or video is stored.

## Run it

Requires Node 20+ and Chrome on the kiosk.

```bash
npm install
cp .env.example .env   # then fill in the three API keys
npm start              # http://localhost:3000
```

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude brain and input classifier. In a Claude cloud environment, name it `AVA_ANTHROPIC_API_KEY` instead. |
| `LIVEAVATAR_API_KEY` | Avatar sessions |
| `DEEPGRAM_API_KEY` | Speech-to-text, and the avatar's voice when ElevenLabs is off (or its backup when on) |
| `ELEVENLABS_API_KEY` | Optional premium voice. When set, the host speaks with ElevenLabs and Deepgram covers any line ElevenLabs fails on or takes more than 4 seconds for |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | Optional overrides for the show's `elevenLabsVoiceId` and the model (default `eleven_flash_v2_5`, the fastest) |
| `LIVEAVATAR_SANDBOX` | `true` (default) uses free ~1 minute sessions with the sandbox avatar. Set `false` to use the show's own avatar. |
| `LIVEAVATAR_AVATAR_ID` | Optional override for the show's `avatarId` |
| `LIVEAVATAR_PREWARM` | `true` keeps an avatar session open between visits, so Start is instant and the idle avatar is on screen. It uses LiveAvatar credits the whole time the page is open, so turn it on for presenter-led demos, not all-day booths. Ignored in sandbox mode. |
| `DEEPGRAM_TTS_MODEL` | Optional override for the show's `voice` |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT` | Defaults `claude-opus-5-5` at `low` effort for fast spoken replies |
| `CLAUDE_CLASSIFIER_MODEL` | Model for the input safety classifier (default `claude-haiku-4-5`, chosen for speed) |
| `SHOW` | Which folder under `shows/` to load (default `demo`) |

The kiosk server runs on the booth PC. Open it full screen in Chrome kiosk mode, for example `chrome --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000`.

## Backstage screen

Open `http://localhost:3000/backstage.html` on a second screen (or in a second Chrome window on the same PC) to show what happens under the hood while the avatar talks:

- each visitor question, the guardrail checks it went through (speech check, instant rule screen, safety classifier, answer screen, model safety) with their verdicts and timing, highlighted in red when a check changed what the avatar said;
- each answer, marked as either a fixed approved line or a generated answer, with the knowledge files it most closely matches and how long the first sentence took;
- running totals: questions, share of answers matching approved knowledge, guardrail interventions, and the median time to the first sentence.

The source match is a word-overlap estimate of which file an answer drew on, not proof. The screen only listens; it cannot change the kiosk. It shows the same text the transcript log keeps and nothing more.

## Per-show content

Copy `shows/demo` to `shows/<your-show>` and edit:

- `show.json`: optionally `about`, one line on what the booth covers (the safety classifier uses it to tell on-topic from off-topic questions; default: the company, its products, demos and the event); the LiveAvatar `avatarId` (ignored in sandbox mode), the Deepgram `voice` (any [Aura-2 voice](https://developers.deepgram.com/docs/tts-models), default `aura-2-orpheus-en`), names, greeting, suggested questions, product keyterms for speech recognition, blocked terms, competitors, idle timeout, strike limit, and every canned line.
- `show.json` `"screen"`: what the kiosk shows above the avatar. `headline` (e.g. `"Meet AVA"`), `accentText` (the words drawn in `accentColor`), `logo` (an image in `shows/<your-show>/assets/`, e.g. `"logo.svg"`, or an https URL), `logoText` (shown when there is no logo image), `subtitle` (optional smaller line), `backgroundColor`, `waveColor` (the sound wave under the transcript) `videoFit` (`"cover"` fills the frame, `"contain"` shows the whole video) and `avaName` and `visitorName` (the names on each transcript line; default the avatar's name and "You"), `avatarShare` (how much of the height under the header the avatar gets, 0.3 to 0.8, default 0.6; the transcript gets the rest). Text may use `{{avatarName}}`, `{{company}}` and `{{eventName}}`. The server re-reads the `"screen"` section each time the kiosk page loads, so edit it and reload the page; no restart needed (other show.json settings, including the spoken greeting and `avatarName`, still need a restart). The kiosk page is laid out for a portrait screen (e.g. 1080 x 1920, full screen); on a landscape screen it shows as a centered portrait column. The live transcript under the avatar shows the visitor's words as they are recognized and Ava's words as she says them.
- `persona.md`: how the host speaks and stays in character. `{{avatarName}}`, `{{company}}`, `{{eventName}}` and `{{competitors}}` are filled in from `show.json`.
- `knowledge.md` and the `knowledge/` folder: the only facts the avatar may answer from. Drop plain-text or Markdown files (`.md`, `.txt`) into `knowledge/`, one topic per file if you like; every file is loaded in name order when the server starts. Convert PDFs, slides and web pages to text first, and keep the total to what a booth host needs (the server warns above about 400,000 characters). If a visitor asks something the files don't cover, the avatar says it isn't sure and offers a booth teammate. The demo show uses a summary of the public genesys.com site (October 2026); each file names its source page.

## Genesys AVA as the brain (optional)

A show can take its answers from a Genesys Cloud Agentic Virtual Agent (AVA) instead of Claude. Everything else stays the same: Deepgram listens, our guardrails screen the question and every sentence of the answer, and ElevenLabs and LiveAvatar speak it.

- The server opens a guest chat on a Genesys **Web Messaging** deployment for each visitor and sends the screened question. The deployment's inbound message flow hands it to a digital bot flow that calls the AVA, and the AVA's reply comes back on the same chat. When the visit ends, the chat is dropped and the next visitor gets a new one.
- The visitor's chat opens when they tap Start, and each question goes to Genesys at once, while the safety classifier checks it. A flagged question is never answered aloud (Ava says her deflection line instead), but Genesys does see it. Set `"waitForScreening": true` to hold every question until the classifier passes it, so flagged questions never leave the booth; that adds 1-3 seconds per answer.
- **The AVA does the talking.** When the visitor taps Start, the app sends the bot a quiet "Hello" (`warmUpText`) and Ava speaks the AVA's whole welcome, word for word, as her greeting. The show's `greeting` and `suggestedQuestions` are not used. The buttons under the transcript are the AVA's own quick replies (and card buttons), updated after every answer, and hidden when the AVA sends none. So the avatar's name, greeting, questions and answers are all set in the AVA; `show.json` only sets the text on the screen. If the AVA sends no welcome, Ava stays quiet until the visitor speaks, and Terminal says so.
- Only safety lines are still the app's own: what Ava says when she didn't hear, when a question is deflected by the guardrails, or when an answer fails a check (`cannedLines`). They are kept neutral so they fit any AVA.
- If the AVA has not started answering within `replyTimeoutMs` (default 10 seconds), or Genesys errors, Claude answers that turn instead, from the show's `persona.md` and knowledge. The backstage screen shows which brain answered.
- The AVA's replies arrive as whole chat messages rather than word by word, so expect Ava to start talking later than with Claude.

To turn it on, set this in `shows/<show>/show.json` (or `AVA_BRAIN`, `GENESYS_REGION`, `GENESYS_DEPLOYMENT_ID` and `GENESYS_ORIGIN` in `.env`):

```json
"brain": "genesys",
"genesys": {
  "region": "mypurecloud.com",
  "deploymentId": "<Messenger deployment ID>",
  "origin": "",
  "replyTimeoutMs": 10000,
  "waitForScreening": false,
  "warmUpText": "Hello"
}
```

`region` is your org's domain (the part after `apps.` in the Genesys Cloud address you log in at, e.g. `usw2.pure.cloud`). `origin` is only needed if the deployment restricts domains: set it to one of the allowed domains, e.g. `https://booth.example.com`. Nothing here is a password; the deployment ID is the only key, so keep domain restriction or a short session lifetime on in Genesys.

Check the connection without the avatar: `npm run genesys:check -- "What is Genesys Cloud?"` prints the AVA's answer and how long it took.

## Using your own avatar

Sandbox mode only allows LiveAvatar's sample avatar. To show your own host:

1. In the LiveAvatar dashboard, create a custom avatar. An **image avatar** needs one photo of the person (no consent recording); a **video avatar** needs about two minutes of footage plus a consent recording from the person filmed. Use a photo or footage you have the rights to, and get branded clothing from your own brand team rather than generating logos.
2. Copy the new avatar's ID into `"avatarId"` in `shows/<show>/show.json`.
3. Set `LIVEAVATAR_SANDBOX=false` in `.env` and restart. The server log prints which avatar it is using.

The avatar's voice comes from ElevenLabs when `ELEVENLABS_API_KEY` is set (`"elevenLabsVoiceId"` in `show.json`, default "Brian"), otherwise from Deepgram (`"voice"`). Pick a voice that suits the person; any voice in your ElevenLabs voice library works, including a licensed clone of the presenter. If ElevenLabs fails or is slow, that line is spoken with the Deepgram voice instead, and after three failures in a row the kiosk stays on Deepgram for a minute before trying again, so the avatar never goes silent.

## Comparing faces: LiveAvatar or Anam

The face is swappable. Both options only draw the avatar and lip-sync it to the audio we send, so the brain, guardrails and ElevenLabs voice stay exactly the same, and a side-by-side test compares the faces alone.

| | LiveAvatar (default) | Anam |
| --- | --- | --- |
| Mode | LITE ("Avatar Only") | Audio passthrough |
| Key | `LIVEAVATAR_API_KEY` | `ANAM_API_KEY` |
| Avatar | `"avatarId"` in `show.json` | `"anamAvatarId"` in `show.json` |

To try Anam:

1. In [Anam Lab](https://lab.anam.ai), create an API key and pick a stock avatar or create a custom one from footage you have the rights to. Copy its avatar ID.
2. Put the ID in `"anamAvatarId"` in `shows/<show>/show.json` and `ANAM_API_KEY` in `.env`.
3. Set `"renderer": "anam"` in `show.json`, or start with `AVA_RENDERER=anam npm start` for a quick comparison. The server log's `FACE:` line says which face is running.

For a fair test, run each face with the same questions and watch for three things: how natural the mouth and head look, how long the first words take after you let go of the button (the backstage screen shows it), and whether cutting in stops the avatar cleanly.

Anam has no "finished speaking" event for passthrough audio, so the kiosk estimates it from the audio length. LiveAvatar's prewarm and sandbox settings don't apply to Anam.

## Licensing for shows

Use a paid ElevenLabs plan for any show or recorded demo. Audio made on the free plan has no commercial rights, even after upgrading, so the server prints a `PLAN CHECK` warning at startup when the key is on the free plan. For a cloned presenter voice, get the presenter's written consent and use ElevenLabs' professional voice cloning on a plan that includes it.

## Develop

```bash
npm test          # unit tests for chunking, guardrails and the conversation flow
npm run typecheck
npm run dev       # rebuilds the client, restarts the server on change
```

## Known gaps in this pilot

- The Anam face is built from Anam's SDK types and docs but not yet tested against a live Anam account; the cloud test environment can't reach api.anam.ai.
- Not yet tested end to end against live LiveAvatar and Deepgram accounts. First thing to check: whether sentence-by-sentence `repeatAudio` calls queue cleanly on the avatar or need to be merged into one utterance.
- Push-to-talk only; hands-free voice detection and camera-based presence come later.
- No offline mode yet: if the network drops, the page shows a "taking a break" message.
- The first sentence takes about 2.5 seconds in a cloud test (October 2026): about 0.8 s classifier head start, about 1 s for Claude's first words, and the rest for text-to-speech. The first spoken chunk now ends at a clause break when the opening sentence is long, which roughly halved the wait. With ElevenLabs on, a line is voiced in about 0.4 to 0.7 s instead of Deepgram's 2 to 3 s, and the first sentence lands in about 1.6 to 3 s, most of it the classifier head start and Claude.
- No admin page or dashboard yet; content is edited in `shows/` and logs are JSONL files.
