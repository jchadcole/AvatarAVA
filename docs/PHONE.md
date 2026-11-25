# Ava on the phone

A call-in version of Ava. Callers dial a Genesys Cloud number and talk to the
same Ava as the kiosk: the Genesys AVA says all the words, Claude answers if
the AVA fails or is slow, the same guardrails screen every question and
answer, ElevenLabs is the voice (Deepgram if ElevenLabs fails), and Deepgram
listens. The only difference is the channel: voice only, no face.

The kiosk is unchanged. `npm start` still runs the kiosk on port 3000;
`npm run phone` runs the phone line on port 3100. Both can run at once.

## How a call flows

```
Caller ──> Genesys Cloud number ──> Architect inbound call flow
                                     └─ "Call Audio Connector" action
                                          │  WebSocket (AudioHook v2), caller audio in,
                                          │  Ava's audio out, PCMU 8 kHz
                                          ▼
                            ngrok (public wss:// address) ──> npm run phone (your Mac)
                                                                 │
               Deepgram listens (one stream for the whole call; a 400 ms pause ends a sentence)
               Same Conversation as the kiosk: precheck, pattern screen, classifier,
               Genesys AVA (Claude backup), per-sentence output screen, canned lines, strikes
               ElevenLabs voices each sentence as it arrives (Deepgram backup),
               downsampled to phone audio and sent down the line as it plays
```

- **Talking over Ava** stops her mid-sentence (two words or more, so a cough doesn't), and she answers what the caller said.
- **Adding to a question** before Ava has said anything gets one answer to the whole question.
- **Hanging up:** after 40 seconds of silence, 10 minutes on the line, or repeated abuse, Ava says goodbye and ends the call. Set these in `shows/<show>/phone.json`.
- **Lines that mention the screen or the booth** ("tap one of the options") have phone versions in `phone.json`. Everything else comes from `show.json`, so brain, voice and guardrail changes apply to both.
- **Backstage screen** works for calls too: open `http://localhost:3100/backstage.html` while you're on the phone with Ava.
- **Logs** go to the same `logs/YYYY-MM-DD.jsonl`, marked `"kiosk": "phone …1234"` (last four digits of the caller's number only).

## What you need

| | What | Cost |
| --- | --- | --- |
| Genesys Cloud | A phone number (Genesys Cloud Voice or your carrier/BYOC trunk), the **Audio Connector** integration, and Architect access | Genesys bills Audio Connector by the minute while a call is connected to it; check your org's price sheet |
| ngrok | Free account with a free static domain, to give Genesys a public `wss://` address for your Mac | Free |
| Everything else | The keys you already use for the kiosk (Deepgram, ElevenLabs, Anthropic) | Same as the kiosk, per minute of talk |

Genesys only connects to a `wss://` address with a certificate from a public authority; ngrok's address has one.

## Mac Terminal steps

### 1. Get the phone version

```bash
cd ~/genesys-ava-sdd/AvatarAVA
git fetch origin claude/project-thread-ljv5pv
git checkout claude/project-thread-ljv5pv
npm install
```

### 2. Make the key Genesys will use to connect

```bash
echo "AUDIO_CONNECTOR_API_KEY=$(openssl rand -hex 24)" >> .env
grep AUDIO_CONNECTOR_API_KEY .env
```

Copy the value after the `=`; you paste it into Genesys in step 5. (If you keep secrets in 1Password, store it there and put its `op://` reference in `.env` instead.)

### 3. Try a pretend call first (no Genesys needed)

Terminal window 1:

```bash
cd ~/genesys-ava-sdd/AvatarAVA
op run --env-file=.env -- npm run phone
```

Terminal window 2:

```bash
cd ~/genesys-ava-sdd/AvatarAVA
op run --env-file=.env -- npm run phone:test-call
open "$(ls -t logs/phone-test-*.wav | head -1)"
```

The test connects the way Genesys does, asks "What is Genesys Cloud?" and then
tries a prompt injection, prints how long Ava took to start answering each one,
and saves what Ava said as a .wav file you can play. Ask your own questions
with `npm run phone:test-call -- "First question" "Second question"`.

(Not using 1Password? Drop the `op run --env-file=.env --` part.)

### 4. Give your Mac a public address with ngrok (one time)

1. Sign up at https://ngrok.com (free), then in the ngrok dashboard open **Domains** and claim your free static domain, something like `ava-chad.ngrok-free.app`.
2. In Terminal:

```bash
brew install ngrok
ngrok config add-authtoken PASTE_YOUR_NGROK_AUTHTOKEN
```

Each time you want Ava on the phone, run this in its own Terminal window (keep the window from step 3 running `npm run phone`):

```bash
caffeinate -i ngrok http --url=ava-chad.ngrok-free.app 3100
```

`caffeinate -i` stops the Mac from sleeping while the line is up.

### 5. Genesys Cloud setup (one time, in the Genesys admin pages)

1. **Admin > Integrations > + Integrations**, search for **Audio Connector**, and install it. Name it "Ava phone line".
2. **Configuration > Properties**: set **Base Connection URI** to `wss://ava-chad.ngrok-free.app/audio-connector` (your ngrok domain).
3. **Configuration > Credentials**: enter the API key from step 2. Leave the client secret empty. Save, then set the integration to **Active**.
4. **Architect**: create an **Inbound Call Flow** (or open a test one). In its starting task, add **Toolbox > Bot > Call Audio Connector**, pick the "Ava phone line" integration, and set **Connector ID** to `ava`. After it, add a **Disconnect** action. Publish the flow.
5. **Admin > Telephony > Phone Numbers**: get or pick a number, then in **Admin > Routing > Call Routing** (or Architect's call routing page) send that number to the new flow.
6. Call the number.

Menu names can differ slightly between Genesys Cloud versions; the help
article "Audio Connector overview" has the current steps.

## Settings

`.env`:

| Variable | Purpose |
| --- | --- |
| `AUDIO_CONNECTOR_API_KEY` | Required. The API key Genesys sends; any connection without it is refused |
| `PHONE_PORT` | Port for the phone line (default 3100) |
| `PHONE_ALLOWED_CALLERS` | Optional comma-separated list of caller numbers that may reach Ava; others are hung up on |
| `PHONE_ALLOW_NO_KEY` | `true` accepts connections with no key. Local tests only |

`shows/<show>/phone.json` (all optional):

| Setting | Default | Purpose |
| --- | --- | --- |
| `cannedLines` | show.json's | Phone wording for any canned line; the rest come from show.json |
| `greeting` | show.json's | Only used when the brain is Claude; the AVA greets callers itself |
| `idleResetSeconds` | show.json's | Silence before Ava says goodbye and hangs up |
| `maxCallMinutes` | 10 | Longest call, to cap cost |
| `bargeIn` | true | Whether talking over Ava stops her |
| `bargeInMinWords` | 2 | Words needed over Ava before she stops |
| `endpointingMs` | 400 | Pause that ends a caller's sentence. Lower answers sooner but can cut slow talkers off |

## Not verified yet

The pretend call (step 3) has been run end to end. The Genesys side has not
been connected yet: the message format follows Genesys's AudioHook protocol
(open, opened, ping, pong, close, closed, disconnect, and a `barge_in` event to
drop Ava's queued audio), taken from Genesys's reference implementation and
Pipecat's Genesys integration, not from a live Genesys call. If the first real
call fails, the Terminal running `npm run phone` prints lines starting with
`AUDIO CONNECTOR` or `PHONE:` that say why.

Genesys can also sign each connection with a client secret (HTTP message
signatures). This version checks the API key only, so leave the client secret
empty.
