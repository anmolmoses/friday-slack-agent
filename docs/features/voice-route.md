# Voice Route — hands-free Mac control

A second, **independent** route for Friday: Anmol talks, she replies in her voice and
controls the Mac. Built on the **OpenAI Realtime API** (speech-to-speech). It does **not**
touch the Slack/Bolt server, session manager, or spawner — the Slack bot keeps working
exactly as before.

## What it does

- Low-latency voice conversation (server-side VAD, hands-free, with barge-in).
- Full Mac control via function tools: open apps, run shell, run AppleScript, type text,
  press key combos.
- Hands heavy engineering work to `dispatch_engineering`, which infers the repo and routes to
  Claude+Slack when configured or local Codex in Terminal when Slack is unavailable.
- Toggle on/off from a keyboard shortcut (skhd) or the CLI.

## Architecture

```
 mic ──ffmpeg(s16le 24k mono)──▶ daemon ──base64──▶  OpenAI Realtime WS (gpt-realtime-2)
 spkr ◀──native AVAudio player──── daemon ◀──output_audio.delta────┘   │
                                          ▲ function_call           │
                                          └── tools.ts ──────────────┘
                                              run_shell / run_applescript / open_app /
                                              type_text / key_combo / dispatch_engineering
 skhd hotkey ─▶ bin/friday-voice toggle ─(SIGUSR2)▶ daemon: flip listening on/off
```

The daemon is long-lived and starts **idle** (mic off, no WS). Toggling on connects the WS
and starts the mic; toggling off stops the mic and (by default) drops the WS so an idle
daemon costs nothing.

## Files

| File | Role |
|---|---|
| `src/voice/config.ts` | env → `VoiceConfig` (reuses `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, `REPOS`) |
| `src/voice/control.ts` | pidfile + state.json under `/tmp/friday-voice/` |
| `src/voice/persona.ts` | short spoken persona (loads `friday-personal/VOICE.md`) |
| `src/voice/tools.ts` | tool defs + executors (Mac control + smart engineering dispatch) |
| `src/voice/audio.ts` | ffmpeg mic capture + native PCM playback + barge-in flush |
| `src/voice/audio-player.swift` | tiny AVFoundation PCM player used instead of `ffplay` |
| `src/voice/realtime.ts` | OpenAI Realtime WS client (event names centralized in `EVT`) |
| `src/voice/daemon.ts` | orchestrator + lifecycle + signal handling |
| `src/voice/cli.ts` | `start` / `toggle` / `stop` / `status` |
| `bin/friday-voice` | shim skhd calls (absolute-path entry) |
| `friday-personal/VOICE.md` | editable persona (tone tweaks need no code change) |

## Commands

```bash
bun run voice            # start daemon in foreground (idle), logs to console
bin/friday-voice toggle  # toggle listening (starts a detached daemon if none)
bin/friday-voice status  # running? listening? ws connected? uptime
bin/friday-voice test-output  # speaks a canned line without using the mic
bin/friday-voice mic-test 4   # captures 4s locally and prints the peak mic level
bin/friday-voice stop    # SIGTERM the daemon
```

A detached daemon logs to `/tmp/friday-voice/daemon.log`.

## Config (env — all optional except the key)

| Var | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | already in `.env` |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | swap model in one place |
| `FRIDAY_VOICE` | `cedar` | TTS voice (cedar, marin, alloy, …) |
| `FRIDAY_VOICE_VAD` | `server_vad` | or `semantic_vad` |
| `FRIDAY_VOICE_VAD_THRESHOLD` | `0.05` | speech threshold for server VAD; raise if it false-triggers, lower if it misses you |
| `FRIDAY_VOICE_VAD_SILENCE_MS` | `700` | trailing silence before Friday answers |
| `FRIDAY_VOICE_MIC_INDEX` | `0` | avfoundation audio device index |
| `FRIDAY_VOICE_MIC_GAIN` | `4` | local gain applied before sending PCM to Realtime |
| `FRIDAY_VOICE_ECHO_SUPPRESSION_MS` | `1200` | keep Friday from interrupting herself while speaker audio is still playing |
| `FRIDAY_VOICE_PLAYBACK_PREBUFFER_MS` | `350` | small output prebuffer for smoother speech playback |
| `FRIDAY_VOICE_WS_IDLE_OFF` | `true` | drop WS when toggled off |
| `SLACK_VOICE_CHANNEL` | — | channel id for Claude dispatch audit thread; if unset, engineering dispatch falls back to Codex |

Find the mic index with: `ffmpeg -f avfoundation -list_devices true -i ""` (look under
"AVFoundation audio devices"). On this Mac, `0` = "MacBook Pro Microphone".

## One-time macOS permissions (TCC)

The **app that launches the daemon** (Terminal/iTerm, or skhd if launched from the hotkey)
needs:
- **Microphone** — ffmpeg captures the mic. First listen triggers the prompt; if it doesn't
  appear, grant it in System Settings → Privacy & Security → Microphone.
- **Accessibility** — `type_text` / `key_combo` drive System Events. Grant the launching app
  (and skhd) in System Settings → Privacy & Security → Accessibility.

## Keyboard shortcut (skhd)

```bash
brew install skhd
# add a binding (pick your key):
echo 'cmd + alt - space : /Users/anmol/Documents/GitHub/Friday/bin/friday-voice toggle' >> ~/.config/skhd/skhdrc
skhd --start-service        # then grant skhd Accessibility permission when prompted
```

Press the hotkey → Tink sound = listening ON, Bottle sound = OFF.

## Auto-start at login (launchd)

`~/Library/LaunchAgents/com.friday.voice.plist` runs the daemon **idle** at login
(`RunAtLoad`, `KeepAlive` off). It sets `WorkingDirectory` to the repo (so Bun auto-loads
`.env`) and a `PATH` covering `~/.bun/bin` + `/opt/homebrew/bin` (so `bun`/`ffmpeg`/`ffplay`
resolve under launchd's minimal env). Logs to `/tmp/friday-voice/daemon.log`.

```bash
launchctl load -w  ~/Library/LaunchAgents/com.friday.voice.plist   # enable
launchctl unload   ~/Library/LaunchAgents/com.friday.voice.plist   # disable
```

`friday-voice stop` stays stopped (KeepAlive is off); the hotkey re-launches a detached
daemon on demand. Idle daemon holds no WS, so it costs nothing until you toggle on.

## How Engineering Dispatch Works

Friday exposes `dispatch_engineering` as the preferred voice tool for substantial coding,
debugging, builds, PR reviews, and releases. It chooses a repo without asking when it can:

- GitHub/PR URL → configured repo name from the URL.
- Exact configured repo name in the request.
- Keyword aliases: backend/api/server → `gx-backend`; mobile/app/expo/iOS/Android → `gx-client-expo`;
  web/Next/frontend → `gx-client-next`; admin/dashboard → `gx-admin-client`; talent/candidate →
  `gx-talent-client`.
- No match → the Friday repo itself.

If `SLACK_VOICE_CHANNEL` is configured, `dispatch_engineering` routes through
`dispatch_to_claude` and reports in Slack. If Slack is not configured, it starts a local
`codex exec` session in Terminal via `dispatch_to_codex` instead of refusing the task.

## How `dispatch_to_claude` Works

It needs a Slack thread to report into (the existing Stop-hook posts results there). On the
first dispatch of a session it posts a seed message to `SLACK_VOICE_CHANNEL`, captures the
thread `ts`, and reuses it. `repo` (optional) maps to a configured repo's clone root; the
dispatch script then isolates a per-thread worktree exactly as for Slack-driven dispatches.
If `SLACK_VOICE_CHANNEL` is unset, the voice route falls back to local Codex dispatch.

## Realtime API notes

- GA endpoint: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2`, bearer auth, **no**
  `OpenAI-Beta` header. Bun's `WebSocket` supports the `headers` option.
- GA nests audio config: `session.audio.input.format = {type:"audio/pcm", rate:24000}`,
  `turn_detection` under `audio.input`, `voice` under `audio.output`.
- Output audio arrives as `response.output_audio.delta` (the client also accepts the legacy
  `response.audio.delta`). All event strings live in `EVT` in `realtime.ts` — if OpenAI
  shifts the schema, that's the one place to edit. Server `error` events are logged verbatim.

## Verified

- `bun run typecheck` clean.
- Daemon start (detached) → toggle ON → **WS connected to gpt-realtime-2 (auth accepted, no
  schema error)** → toggle OFF (clean WS close 1000) → stop → pid cleared. See
  `/tmp/friday-voice/daemon.log`.
- Still TODO live: a real spoken exchange + a Mac-control tool call (needs mic/Accessibility
  grants on the launching app).
