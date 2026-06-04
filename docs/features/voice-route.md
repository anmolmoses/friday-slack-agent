# Voice Route — hands-free Mac control

A second, **independent** route for Friday: Anmol talks, she replies in her voice and
controls the Mac. Built on the **OpenAI Realtime API** (speech-to-speech). It does **not**
touch the Slack/Bolt server, session manager, or spawner — the Slack bot keeps working
exactly as before.

## What it does

- Low-latency voice conversation (server-side VAD, hands-free, optional noise-gated interruption).
- Full Mac control via function tools: open apps, run shell, run AppleScript, type text,
  press key combos, screenshot the screen, and move/click/drag the mouse with an orange
  control glow.
- Internet/browser tools: search the web, open URLs, extract readable page text, and take
  Playwright browser screenshots.
- Opt-in camera vision: capture one Mac camera frame, attach it to Realtime as image input,
  and store confirmed visual-person memories.
- Memory tools: search local Friday memory, recall associative engram context, and write
  durable voice memories that trigger incremental engram indexing.
- Voice turns use Engram without blocking speech: a startup primer and memory tools support
  recall, while background transcripts capture completed voice exchanges into the index.
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
	                                              type_text / key_combo / web_search /
	                                              browser_* / screen_screenshot / mouse_control /
	                                              camera_* / visual_person_* /
	                                              memory_search / engram_recall / remember /
	                                              dispatch_engineering
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
| `src/voice/audio.ts` | ffmpeg mic capture + native PCM playback |
| `src/voice/audio-player.swift` | tiny AVFoundation PCM player used instead of `ffplay` |
| `src/voice/mouse-control.swift` | native mouse move/click/drag helper with orange control ring |
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
| `FRIDAY_VOICE` | `shimmer` | TTS voice. Current Realtime voices include shimmer, coral, sage, marin, cedar, alloy, ash, ballad, echo, and verse. |
| `FRIDAY_VOICE_VAD` | `server_vad` | or `semantic_vad` |
| `FRIDAY_VOICE_VAD_THRESHOLD` | `0.05` | speech threshold for server VAD; raise if it false-triggers, lower if it misses you |
| `FRIDAY_VOICE_VAD_SILENCE_MS` | `700` | trailing silence before Friday answers |
| `FRIDAY_VOICE_MIC_INDEX` | `0` | avfoundation audio device index |
| `FRIDAY_VOICE_MIC_GAIN` | `4` | local gain applied before sending PCM to Realtime |
| `FRIDAY_VOICE_NOISE_REDUCTION` | `far_field` | OpenAI input noise reduction: `far_field` for laptop mic, `near_field` for headset mic, `off` to disable |
| `FRIDAY_VOICE_CAMERA` | `false` | master switch for camera/vision tools; set `true` to enable |
| `FRIDAY_VOICE_CAMERA_INDEX` | `0` | avfoundation video device index |
| `FRIDAY_VOICE_CAMERA_WIDTH` | `1280` | camera snapshot width |
| `FRIDAY_VOICE_CAMERA_HEIGHT` | `720` | camera snapshot height |
| `FRIDAY_VOICE_CAMERA_WARMUP_MS` | `1500` | wait this long after opening the camera before saving a frame so auto-exposure settles |
| `FRIDAY_VOICE_ECHO_SUPPRESSION_MS` | `1200` | keep Friday from hearing herself while speaker audio is still playing |
| `FRIDAY_VOICE_INTERRUPTION` | `false` | enable local, noise-gated interruption while Friday is speaking |
| `FRIDAY_VOICE_INTERRUPT_MIN_LEVEL` | `0.75` | local post-gain mic RMS threshold required to interrupt |
| `FRIDAY_VOICE_INTERRUPT_FRAMES` | `40` | consecutive mic chunks above threshold before interrupting |
| `FRIDAY_VOICE_INTERRUPT_BUFFER_MS` | `650` | recent mic audio replayed to Realtime after an accepted interrupt |
| `FRIDAY_VOICE_INTERRUPT_COOLDOWN_MS` | `8000` | minimum gap between accepted interruptions |
| `FRIDAY_VOICE_INTERRUPT_MIN_ASSISTANT_MS` | `1500` | no interruption during the first part of FRIDAY's response |
| `FRIDAY_VOICE_INTERRUPT_MAX_PER_RESPONSE` | `1` | maximum accepted interruptions during one FRIDAY response |
| `FRIDAY_VOICE_PLAYBACK_PREBUFFER_MS` | `350` | small output prebuffer for smoother speech playback |
| `FRIDAY_VOICE_WS_IDLE_OFF` | `true` | drop WS when toggled off |
| `FRIDAY_VOICE_BACKGROUND_TRANSCRIPTION` | `true` | let Realtime answer immediately while final transcripts feed memory in the background |
| `FRIDAY_VOICE_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | input transcription model used for voice memory capture |
| `FRIDAY_VOICE_TRANSCRIPTION_LANGUAGE` | `en` | optional language hint for faster/more accurate transcription |
| `FRIDAY_VOICE_TRANSCRIPTION_PROMPT` | — | optional transcription hint for names/apps/domain terms |
| `ENGRAM_RECALL` | `0` | when `1`, load a small voice memory primer at daemon startup; blocking per-turn recall is only used when background transcription is disabled |
| `ENGRAM_CAPTURE` | `0` | when `1`, capture voice transcript pairs under `memory/conversations/` and reindex |
| `SLACK_VOICE_CHANNEL` | — | channel id for Claude dispatch audit thread; if unset, engineering dispatch falls back to Codex |

Find the mic index with: `ffmpeg -f avfoundation -list_devices true -i ""` (look under
"AVFoundation audio devices"). On this Mac, `0` = "MacBook Pro Microphone".

Find the camera index with the same command (look under "AVFoundation video devices"). On this
Mac, `0` = "FaceTime HD Camera".

## One-time macOS permissions (TCC)

The **app that launches the daemon** (Terminal/iTerm, or skhd if launched from the hotkey)
needs:
- **Microphone** — ffmpeg captures the mic. First listen triggers the prompt; if it doesn't
  appear, grant it in System Settings → Privacy & Security → Microphone.
- **Accessibility** — `type_text` / `key_combo` drive System Events. Grant the launching app
  (Terminal/iTerm and skhd) in System Settings → Privacy & Security → Accessibility. `mouse_control`
  uses a stable helper at `~/.friday/voice/friday-mouse`; grant that helper too if macOS prompts.
- **Screen Recording** — `screen_screenshot` and current-browser inspection use `screencapture`.
  Grant the launching app, usually Terminal, in System Settings → Privacy & Security → Screen
  Recording. On newer macOS this pane is named **Screen & System Audio Recording**. If Terminal is
  already enabled there, quit Terminal completely with Cmd+Q, reopen it, then restart Friday voice;
  macOS does not apply the permission to Terminal sessions that were already running.
- **Camera** — `camera_snapshot`, `camera_see`, and visual-person memory use ffmpeg's
  AVFoundation camera input. Grant the launching app, usually Terminal, in System Settings →
  Privacy & Security → Camera, then quit Terminal completely with Cmd+Q, reopen it, and restart
  Friday voice.

## Smart Agent Tools

The Realtime model now sees these first-class tools:

- `web_search` for current internet facts.
- `browser_open_url`, `browser_page_text`, and `browser_screenshot` for browser tasks and page
  inspection. URL screenshots use `npx playwright screenshot`; no-URL screenshots capture the
  current Mac screen.
- `screen_screenshot` before coordinate-based UI actions or when Anmol asks what is visible.
- `camera_snapshot` captures one Mac camera still and returns its path/dimensions.
- `camera_see` captures one camera still and attaches it to the live Realtime conversation as
  image input, so FRIDAY can answer visual questions about the physical scene.
- `visual_person_lookup` compares a camera frame/image path against confirmed visual-person memory.
- `visual_person_remember` stores a confirmed person's name plus reference image under
  `memory/vision/people/`, writes an Engram-indexable profile card, and reindexes.
- `mouse_control` for permission checks, move/click/double-click/drag. The helper compiles lazily
  to `~/.friday/voice/friday-mouse` and flashes an orange ring while taking control.
- `memory_search` for Friday's local BM25 memory corpus.
- `engram_recall` for associative memories from `.engram/dashboard.db`, independent of the
  live `ENGRAM_RECALL=1` prompt bridge.
- `remember` appends a durable note under `memory/daily/` and triggers `reindexIncremental()`.

## Interruption Mode

Realtime's WebSocket docs say interruption needs client-side playback handling: stop output,
cancel the in-flight response, then send `conversation.item.truncate` with the assistant audio
duration that was actually played. Friday does that only after a local noise gate passes.

`turn_detection.interrupt_response` intentionally stays `false` even when
`FRIDAY_VOICE_INTERRUPTION=true`; otherwise OpenAI's VAD would auto-cancel on any detected noise
before Friday can apply the local threshold/frame/cooldown filters.

## Voice Memory

By default, voice uses background transcription: Realtime's `create_response` stays enabled, so
FRIDAY starts answering as soon as server VAD closes the turn. Input transcription runs alongside
the response and is used for memory capture, not as a blocker in the speaking path.

When `ENGRAM_RECALL=1`, the daemon loads a small associative-memory primer at startup so stable
preferences are available without adding turn latency. The model also has `memory_search`,
`engram_recall`, and `remember` tools for memory-sensitive turns.

If `FRIDAY_VOICE_BACKGROUND_TRANSCRIPTION=false`, Friday switches back to explicit response
creation: after VAD commits a turn, it waits for
`conversation.item.input_audio_transcription.completed`, recalls engram context for that
transcript, then creates the response with the recalled context appended to the instructions.

After FRIDAY speaks, `response.output_audio_transcript.done` supplies the assistant transcript.
If `ENGRAM_CAPTURE=1`, Friday writes the pair through `captureExchange()`, which stores a tagged
file under `memory/conversations/<date>/` and schedules enrichment plus incremental engram
indexing. This is what makes voice-only facts, like "Numb by Linkin Park is my favorite song",
recallable in later sessions.

## Vision Memory

Camera vision is opt-in behind `FRIDAY_VOICE_CAMERA`. When enabled, `camera_see` opens the Mac
camera, waits `FRIDAY_VOICE_CAMERA_WARMUP_MS` for auto-exposure to settle, captures a single frame,
and sends it into the existing Realtime session as an `input_image`. FRIDAY does not continuously
watch the camera.

Visual identity memory stays explicit and confirmed:

- `visual_person_lookup` computes a local perceptual fingerprint for a camera frame and compares it
  with saved reference images.
- If no confident match exists, FRIDAY should ask who the person is.
- After Anmol or the person confirms the name, `visual_person_remember` copies the reference image
  under `memory/vision/people/<person-id>/`, stores a `profile.json`, writes `profile.md`, and runs
  incremental Engram indexing.

Engram still indexes text, not pixels. The image files are durable references; the markdown profile
card is the searchable/associative memory that links the person name, context, notes, and image
paths. Visual matches are tentative unless confidence is high.

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
