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
- Hands heavy engineering work to `dispatch_engineering`, which infers the repo and starts
  local Codex by default. Slack/Claude dispatch is opt-in when Anmol explicitly asks for it.
- Toggle on/off from the HUD's native keyboard shortcut or the CLI.

## Architecture

```
 mic ──ffmpeg(s16le 24k mono)──▶ daemon ──base64──▶  OpenAI Realtime WS (gpt-realtime-2)
 spkr ◀──native AVAudio player──── daemon ◀──output_audio.delta────┘   │
                                          ▲ function_call           │
	                                          └── tools.ts ──────────────┘
	                                              run_shell / run_applescript / open_app /
	                                              app_quick_switch / app_send_text /
	                                              type_text / key_combo / web_search /
	                                              browser_* / screen_screenshot / mouse_control /
	                                              camera_* / visual_person_* /
	                                              memory_search / engram_recall / remember /
	                                              dispatch_engineering
 HUD hotkey ─▶ bin/friday-voice toggle ─(SIGUSR2)▶ daemon: flip listening on/off
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
| `bin/friday-voice` | shim the HUD hotkey calls (absolute-path entry) |
| `friday-personal/VOICE.md` | editable persona (tone tweaks need no code change) |

## Commands

```bash
bun run voice            # start daemon in foreground (idle), logs to console
bin/friday-voice toggle  # toggle listening (starts a detached daemon if none)
bin/friday-voice status  # running? listening? ws connected? uptime? last hotkey?
bin/friday-voice test-output  # speaks a canned line without using the mic
bin/friday-voice mic-test 4   # captures 4s locally and prints the peak mic level
bin/friday-voice probe "Say hello" # injects text through the live daemon and speaker path
bun run bin/friday-voice-latency-smoke.ts  # Realtime action/tool/ack latency smoke
bun run bin/friday-voice-tool-smoke.ts     # screen/browser/mouse permission smoke
bun run bin/friday-voice-dispatch-smoke.ts # dry-run dispatch_engineering local Codex routing
bun run bin/friday-voice-readiness.ts      # routing + Codex CLI shape + permissions + latency + hardcode scan
bin/friday-voice stop    # SIGTERM the daemon
```

A detached daemon logs to `/tmp/friday-voice/daemon.log`. `bin/friday-voice status` also reports the
last measured latency, last tool/action, and perception cache so a silent or stuck turn can be
debugged without reading the full log first.

`bin/friday-voice probe` is a live-daemon text injection for debugging. It uses the same Realtime
session, tools, and speaker path as a normal turn, but skips Engram capture so tests do not pollute
memory. If `probe` speaks but a normal hotkey turn does not, check `mic-test`, local VAD thresholds,
and macOS Microphone permission.

The latency smoke accepts optional overrides:

- `FRIDAY_VOICE_SMOKE_COMMAND` (default: `sleep 2; printf friday-background-e2e-ok`)
- `FRIDAY_VOICE_SMOKE_EXPECTED_TOOL` (default: `run_shell`)
- `FRIDAY_VOICE_SMOKE_FORCE_EXPECTED_TOOL` (`true` to force that tool in the first response)
- `FRIDAY_VOICE_SMOKE_DIRECT_ACTION` (`true` to run the tool locally first, like the daemon's simple-action fast path)
- `FRIDAY_VOICE_SMOKE_NO_TOOL` (`true` to measure a normal no-tool spoken reply)
- `FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON` (optional JSON args for direct-action mode)
- `FRIDAY_VOICE_SMOKE_AFTER_IMAGE_INSTRUCTIONS` (post-image spoken answer instruction)
- `FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS` (default: `2500`)
- `FRIDAY_VOICE_SMOKE_TIMEOUT_MS` (default: `15000`)

The readiness check wraps the smokes with FRIDAY's target budgets:

- `FRIDAY_VOICE_READY_FAST_BUDGET_MS` (default: `2200`) for normal no-tool speech and direct
  actions such as shell backgrounding, browser opens, simple generic app launches,
  visible-app text draft/send routing, and clear engineering dispatches.
- `FRIDAY_VOICE_READY_BACKGROUND_TOOL_BUDGET_MS` (default: `3200`) for the full Realtime `run_shell`
  tool loop that starts slow work in the background, then speaks.
- `FRIDAY_VOICE_READY_DISPATCH_TOOL_BUDGET_MS` (default: `3500`) for the full Realtime
  `dispatch_engineering` tool loop with local Codex dry-run enabled.
- `FRIDAY_VOICE_READY_VISION_BUDGET_MS` (default: `5000`) for screen/image turns, which include
  image attachment and model vision.
- `FRIDAY_VOICE_READY_INCLUDE_SCREEN=false` skips the screen-vision latency smoke when you only want
  a fast control-plane check.
- `FRIDAY_VOICE_READY_INCLUDE_DISPATCH_TOOL=true` enables the forced Realtime
  `dispatch_engineering` tool-selection smoke. It is off by default because clear engineering prompts
  are direct-routed to local Codex before model tool selection; that direct route is the mandatory
  readiness gate.

The latest readiness summary is saved to `/tmp/friday-voice/readiness.json`; `bin/friday-voice status`
prints its pass/fail state, age, target budgets, and the key first-audio latency numbers.
Each latency smoke also records the spoken acknowledgement transcript and fails if one command produces
unexpected extra responses, multiple spoken acknowledgements, or an exact repeated sentence.
Readiness also checks the live daemon config: continuous-listening mode must be enabled
(`FRIDAY_VOICE_AUTO_IDLE_AFTER_TURN=false`) and background transcription must remain on.

## Config (env — all optional except the key)

| Var | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | already in `.env` |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2` | swap model in one place |
| `FRIDAY_VOICE` | `shimmer` | TTS voice. Current Realtime voices include shimmer, coral, sage, marin, cedar, alloy, ash, ballad, echo, and verse. |
| `FRIDAY_VOICE_VAD` | `server_vad` | or `semantic_vad` |
| `FRIDAY_VOICE_VAD_THRESHOLD` | `0.12` | speech threshold for server VAD; raise if it false-triggers, lower if it misses you |
| `FRIDAY_VOICE_VAD_SILENCE_MS` | `450` | trailing silence before Friday answers |
| `FRIDAY_VOICE_MIC_INDEX` | `0` | avfoundation audio device index |
| `FRIDAY_VOICE_MIC_GAIN` | `4` | local gain applied before sending PCM to Realtime |
| `FRIDAY_VOICE_NOISE_REDUCTION` | `far_field` | OpenAI input noise reduction: `far_field` for laptop mic, `near_field` for headset mic, `off` to disable |
| `FRIDAY_VOICE_LOCAL_VAD` | `true` | locally gate mic audio before server VAD so room noise does not trigger responses |
| `FRIDAY_VOICE_LOCAL_VAD_MIN_LEVEL` | `0.055` | minimum post-gain RMS level to open a local speech turn |
| `FRIDAY_VOICE_LOCAL_VAD_NOISE_RATIO` | `2.6` | speech must also clear the learned room noise floor by this multiplier |
| `FRIDAY_VOICE_LOCAL_VAD_START_FRAMES` | `8` | consecutive local chunks above threshold before audio is forwarded |
| `FRIDAY_VOICE_LOCAL_VAD_END_MS` | `550` | quiet tail to forward after speech so server VAD closes cleanly |
| `FRIDAY_VOICE_PLAYER` | `auto` | spoken audio backend: `auto`, `native`, or `ffplay` |
| `FRIDAY_VOICE_CAMERA` | `false` | master switch for camera/vision tools; set `true` to enable |
| `FRIDAY_VOICE_CAMERA_INDEX` | `0` | avfoundation video device index |
| `FRIDAY_VOICE_CAMERA_WIDTH` | `1280` | camera snapshot width |
| `FRIDAY_VOICE_CAMERA_HEIGHT` | `720` | camera snapshot height |
| `FRIDAY_VOICE_CAMERA_WARMUP_MS` | `1500` | wait this long after opening the camera before saving a frame so auto-exposure settles |
| `FRIDAY_VOICE_CAMERA_AUTO_RECOGNIZE` | `false` | refresh a low-duty background visual identity cache while listening |
| `FRIDAY_VOICE_CAMERA_AUTO_INTERVAL_MS` | `8000` | interval between background camera identity checks |
| `FRIDAY_VOICE_CAMERA_AUTO_MIN_CONFIDENCE` | `0.78` | minimum cached visual confidence before FRIDAY treats a match as likely |
| `FRIDAY_VOICE_SPEAKER_RECOGNITION` | `false` | local opt-in speaker recognition using mic audio already captured for voice |
| `FRIDAY_VOICE_SPEAKER_MIN_SAMPLE_MS` | `900` | minimum speech sample length before speaker recognition runs |
| `FRIDAY_VOICE_SPEAKER_MAX_SAMPLE_MS` | `5000` | maximum speech audio kept per turn for speaker recognition |
| `FRIDAY_VOICE_SPEAKER_MIN_CONFIDENCE` | `0.72` | minimum speaker confidence before FRIDAY treats a voice match as likely |
| `FRIDAY_VOICE_SPEAKER_PROACTIVE_IDENTIFY` | `false` | when `true`, FRIDAY may ask unknown speakers to identify themselves without being directly asked |
| `FRIDAY_VOICE_SPEAKER_NOVELTY_COOLDOWN_MS` | `60000` | minimum gap between proactive "who is speaking?" prompts |
| `FRIDAY_VOICE_ECHO_SUPPRESSION_MS` | `2500` | keep Friday from hearing herself while speaker audio is still playing |
| `FRIDAY_VOICE_INTERRUPTION` | `false` | enable local, noise-gated interruption while Friday is speaking |
| `FRIDAY_VOICE_INTERRUPT_MIN_LEVEL` | `0.75` | local post-gain mic RMS threshold required to interrupt |
| `FRIDAY_VOICE_INTERRUPT_FRAMES` | `40` | consecutive mic chunks above threshold before interrupting |
| `FRIDAY_VOICE_INTERRUPT_BUFFER_MS` | `650` | recent mic audio replayed to Realtime after an accepted interrupt |
| `FRIDAY_VOICE_INTERRUPT_COOLDOWN_MS` | `8000` | minimum gap between accepted interruptions |
| `FRIDAY_VOICE_INTERRUPT_MIN_ASSISTANT_MS` | `1500` | no interruption during the first part of FRIDAY's response |
| `FRIDAY_VOICE_INTERRUPT_MAX_PER_RESPONSE` | `1` | maximum accepted interruptions during one FRIDAY response |
| `FRIDAY_VOICE_PLAYBACK_PREBUFFER_MS` | `120` | small output prebuffer for smoother speech playback |
| `FRIDAY_VOICE_MAX_OUTPUT_TOKENS` | `192` | cap each Realtime response so voice answers stay short; use `inf` to remove the cap |
| `FRIDAY_VOICE_SHORT_REPLY_TOKENS` | `96` | tighter cap for ordinary non-tool voice replies so casual answers start faster |
| `FRIDAY_VOICE_MAX_TOOL_CALL_TOKENS` | `512` | larger cap for first-pass responses that may need to form a tool call or command |
| `FRIDAY_VOICE_TOOL_AUDIO_HOLD_MS` | `1200` | briefly hold initial response audio so pre-tool filler can be dropped if a function call follows |
| `FRIDAY_VOICE_TOOL_PROGRESS_ACK` | `true` | allow one cached progress cue during long multi-step UI/tool loops |
| `FRIDAY_VOICE_TOOL_PROGRESS_ACK_TEXT` | `Still working through it.` | short phrase spoken once when a continued tool loop crosses the progress threshold |
| `FRIDAY_VOICE_TOOL_PROGRESS_ACK_AFTER_MS` | `4500` | elapsed time after the user stops speaking before the progress cue may play |
| `FRIDAY_VOICE_ACTION_CLASSIFY_WAIT_MS` | `250` | tiny wait after endpointing so transcript deltas can mark action turns before choosing the first response cap |
| `FRIDAY_VOICE_RUN_SHELL_FAST_WAIT_MS` | `400` | foreground shell grace before a still-running command is kept as a background job |
| `FRIDAY_VOICE_WEB_FETCH_TIMEOUT_MS` | `3500` | timeout for `web_search` and `browser_page_text` fetches so bad network paths do not stall voice |
| `FRIDAY_VOICE_BROWSER_SCREENSHOT_TIMEOUT_MS` | `6500` | timeout for Playwright URL screenshots |
| `FRIDAY_VOICE_REALTIME_IMAGE_MAX_PX` | `768` | detailed max dimension for image copies attached to Realtime; originals stay full-resolution on disk |
| `FRIDAY_VOICE_REALTIME_IMAGE_FAST_MAX_PX` | `640` | smaller max dimension for simple visual summaries that do not need coordinates |
| `FRIDAY_VOICE_REALTIME_IMAGE_FORMAT` | `jpeg` | image format for the smaller Realtime attachment; `png` is available when lossless UI text is needed |
| `FRIDAY_VOICE_REALTIME_IMAGE_QUALITY` | `70` | JPEG quality for Realtime image attachments |
| `FRIDAY_VOICE_REALTIME_IMAGE_FAST_QUALITY` | `60` | JPEG quality for simple visual-summary attachments |
| `FRIDAY_VOICE_DISPATCH_LAUNCH_TIMEOUT_MS` | `3000` | timeout for launching local Codex in Terminal |
| `FRIDAY_VOICE_AUTO_IDLE_AFTER_TURN` | `false` | when `true`, noisy-room mode automatically toggles listening off after one response/tool acknowledgement finishes playing |
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

The **app that launches the daemon** (usually Terminal/iTerm; the HUD only toggles a running daemon)
needs:
- **Microphone** — ffmpeg captures the mic. First listen triggers the prompt; if it doesn't
  appear, grant it in System Settings → Privacy & Security → Microphone.
- **Accessibility** — `type_text` / `key_combo` drive System Events. Grant the launching app
  (usually Terminal/iTerm) in System Settings → Privacy & Security → Accessibility. `mouse_control`
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
- `run_shell` returns normal stdout/stderr for commands that finish within the short voice grace; if
  the command is still running, FRIDAY keeps it as a managed background job and returns the job id/log
  path instead of staying silent. Obviously slow commands such as sleeps, installs, tests, builds,
  dev servers, and coding-agent commands background immediately. `run_shell_background` starts
  known-long work directly, and `background_job_status` reports progress, exit code, and log tail.
- `browser_open_url`, `browser_page_text`, and `browser_screenshot` for browser tasks and page
  inspection. URL screenshots use `npx playwright screenshot`; no-URL screenshots capture the
  current Mac screen.
- `screen_screenshot` before coordinate-based UI actions or when Anmol asks what is visible.
- `screen_see` captures the current Mac screen and attaches it to the live Realtime session as
  image input. This is the preferred observe step before `mouse_control`. The original screenshot is
  kept on disk, while the image sent to Realtime is capped to a smaller max dimension so screen
  inspection stays inside the voice latency budget on high-resolution displays. The image prompt
  includes the scale factor back to full-screen coordinates so `mouse_control` clicks stay in the
  correct coordinate space.
- `camera_snapshot` captures one Mac camera still and returns its path/dimensions.
- `camera_see` captures one camera still and attaches it to the live Realtime conversation as
  image input, so FRIDAY can answer visual questions about the physical scene.
- `visual_person_lookup` compares a camera frame/image path against confirmed visual-person memory.
- `visual_person_remember` stores a confirmed person's name plus reference image under
  `memory/vision/people/`, writes an Engram-indexable profile card, and reindexes.
- `current_perception` reads the latest ambient camera/speaker cache without opening the camera or
  delaying a response.
- `voice_person_remember` stores the latest detected speaker sample under a confirmed person name,
  writes an Engram-indexable voice profile card, and reindexes.
- `mouse_control` for permission checks, move/click/double-click/drag. The helper compiles lazily
  to `~/.friday/voice/friday-mouse` and flashes an orange ring while taking control.
  For simple clicks, FRIDAY can fall back to Terminal's `System Events` Accessibility permission
  if the orange-ring helper itself is not trusted yet.
- `memory_search` for Friday's local BM25 memory corpus.
- `engram_recall` for associative memories from `.engram/dashboard.db`, independent of the
  live `ENGRAM_RECALL=1` prompt bridge.
- `remember` appends a durable note under `memory/daily/` and triggers `reindexIncremental()`.

For Mac UI automation, FRIDAY follows the same observe-act loop used by computer-use agents:
capture a screenshot (`screen_see`), inspect the image in the model, execute a small mouse/keyboard
action, then capture again to verify before continuing. This is more reliable than returning only a
screenshot file path because the Realtime model actually receives the screen image. For action turns
that need another UI step after `screen_see`, the post-vision follow-up is text-only so FRIDAY keeps
acting instead of describing the screen out loud mid-task.

For multi-step UI tasks such as "open Slack and send a message", FRIDAY does not treat the first
successful tool call as completion. Intermediate tool results keep the model in the action loop with
held audio; if another tool call starts, the held audio is dropped. She speaks only when the task is
complete or genuinely blocked.

For safe app navigation such as "open Slack and go to channel agent-test", `app_quick_switch`
opens/focuses the visible app and uses its quick switcher (`cmd+k` by default). It does not use
Slack API tokens and does not send messages.

For explicit visible-app message sends such as `send "hello" to channel agent-test in Slack`,
`app_send_text` opens/focuses Slack, uses `cmd+k` to jump to the channel/person, types the exact
message, and presses Return. It does not use Slack API tokens. The fast path only triggers when both
the destination and message body are explicit; otherwise FRIDAY keeps the normal conversation/tool
loop so she can ask or continue safely instead of guessing.

## Interruption Mode

Realtime's WebSocket docs say interruption needs client-side playback handling: stop output,
cancel the in-flight response, then send `conversation.item.truncate` with the assistant audio
duration that was actually played. Friday does that only after a local noise gate passes.

`turn_detection.interrupt_response` intentionally stays `false` even when
`FRIDAY_VOICE_INTERRUPTION=true`; otherwise OpenAI's VAD would auto-cancel on any detected noise
before Friday can apply the local threshold/frame/cooldown filters.

## Voice Memory

By default, voice uses background transcription: input transcription runs alongside the response
and is used for memory capture, not as a blocker in the speaking path. The daemon still sends
`response.create` explicitly after local VAD accepts the turn, which keeps latency low while
preventing room noise or speaker echo from auto-triggering a response.

The mic path also buffers up to four seconds of local-VAD-approved audio while the WebSocket is
connecting or waiting for `session.updated`. That keeps the first words after a hotkey press from
being dropped if Anmol starts speaking before the Realtime session is fully ready.

When partial or final transcript text looks like an action request (`open`, `click`, `search`,
`run`, `fix`, `review`, etc.), that first `response.create` is sent with
`tool_choice: "required"`, `output_modalities: ["text"]`, and the larger tool-call token cap. This
forces a silent tool-selection turn, so FRIDAY spends the turn executing the requested action instead
of generating pre-tool filler audio. After the tool result is available, the follow-up response uses
normal audio again with a short acknowledgement-only instruction and a small token cap, so she starts
speaking quickly instead of reading job ids, paths, logs, or implementation details.

For obvious actions, the daemon narrows `tool_choice` to a specific function to avoid making the
model choose from the whole toolbelt. Examples: command-line phrasing prefers `run_shell`, code/repo
work prefers `dispatch_engineering`, URL opening prefers `browser_open_url`, known browser search
surfaces prefer `browser_submit_text`, safe app/channel jumps prefer `app_quick_switch`, and
screen/click/mouse work prefers `screen_see` before acting.

For the simplest unambiguous Mac actions, the daemon can skip model tool-selection entirely: open a
URL, launch an app, submit text to a known browser search surface, run an explicitly quoted command,
jump to a safe app destination, or start clear engineering work with `dispatch_engineering` locally,
then ask Realtime only for the brief spoken acknowledgement.
Ambiguous or multi-step tasks still go through the normal Realtime tool loop.

Engineering detection covers natural build verbs like create, make, change, wire, integrate,
scaffold, deploy, migrate, and check when they are paired with engineering objects such as API,
endpoint, component, route, database, logs, frontend, backend, mobile, or repo names. Repo inference
then maps backend/API/endpoint work to `gx-backend`, React Native/mobile work to `gx-client-expo`,
frontend/Next/component/page work to `gx-client-next`, and Friday voice/HUD/Engram work to this repo.

When `ENGRAM_RECALL=1`, the daemon loads a small associative-memory primer at startup so stable
preferences are available without adding turn latency. The model also has `memory_search`,
`engram_recall`, and `remember` tools for memory-sensitive turns.

With background transcription on, preference questions start fast, but the final transcript can still
upgrade the turn before audio begins: memory-sensitive prompts such as "what is my favorite song?"
cancel the first non-memory response and recreate it with engram context. Action requests that depend
on memory, such as "play my favorite song", prefer `memory_search` first and then continue the app/UI
tool loop with the recalled preference. For direct favorite-song app actions, the daemon can resolve
the remembered song from the startup primer and call generic `app_search_text` immediately, avoiding
a model tool-selection round trip while staying app-agnostic.

If `FRIDAY_VOICE_BACKGROUND_TRANSCRIPTION=false`, Friday switches to blocking transcript-first
responses: after VAD commits a turn, it waits for
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
and sends it into the existing Realtime session as an `input_image`.

If `FRIDAY_VOICE_CAMERA_AUTO_RECOGNIZE=true`, the daemon also keeps a low-duty ambient identity
cache while listening. It captures temporary frames under `/tmp/friday-voice/vision`, compares them
against confirmed visual-person memories, and injects only the short current-context summary into
the Realtime session. That gives FRIDAY "who might be here" context without doing camera work inside
the answer path. Turning `FRIDAY_VOICE_CAMERA=false` disables both camera tools and the ambient
cache.

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

## Speaker Memory

Speaker recognition is separately opt-in behind `FRIDAY_VOICE_SPEAKER_RECOGNITION`. It does not
start another recorder. While Realtime is already listening, the daemon keeps a bounded copy of the
current human speech turn, computes a local lightweight voice fingerprint after speech stops, and
compares it with confirmed voice profiles under `memory/voice/people/`.

By default, unknown-speaker recognition is passive: FRIDAY updates the current speaker cache, but
does not start a new spoken turn just to ask who someone is. This avoids speaker echo or room noise
turning into a self-conversation. If `FRIDAY_VOICE_SPEAKER_PROACTIVE_IDENTIFY=true`, FRIDAY may queue
a brief follow-up after any current response finishes; that prompt is cooldown-gated by
`FRIDAY_VOICE_SPEAKER_NOVELTY_COOLDOWN_MS`. After a person confirms their name,
`voice_person_remember` saves the WAV sample, profile JSON, and searchable markdown card, then runs
Engram incremental indexing.

## Keyboard shortcut

The HUD overlay registers `ctrl+option+F`, fallback `ctrl+option+cmd+F`, and the legacy
`cmd+option+space` with macOS using Carbon's native hotkey API and calls `bin/friday-voice toggle`.
It does not need `skhd`, Accessibility, or Input Monitoring just to catch the shortcut.

Press either shortcut -> Tink sound = listening ON, Bottle sound = OFF. Each press writes to
`/tmp/friday-voice/shortcut.log`; if the shortcut feels dead, `bin/friday-voice status` shows the
last registered, pressed, or duplicate-ignored hotkey event. The HUD and shim debounce hotkey repeats
for 1.2s so a slightly held keypress cannot toggle FRIDAY on and immediately off.

## Auto-start at login (launchd)

`~/Library/LaunchAgents/com.friday.voice.plist` runs the daemon **idle** at login
(`RunAtLoad`, `KeepAlive` off). It sets `WorkingDirectory` to the repo (so Bun auto-loads
`.env`) and a `PATH` covering `~/.bun/bin`, `/usr/local/bin`, and `/opt/homebrew/bin` (so
`bun`/`node`/`ffmpeg`/`ffplay` resolve under launchd's minimal env). Logs to
`/tmp/friday-voice/daemon.log`.

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

`dispatch_engineering` starts a local `codex exec` session in Terminal by default, even when
Slack credentials exist. If Anmol explicitly asks for Slack, Claude, or cloud dispatch, pass
`engine: "claude"` or call `dispatch_to_claude`; that route reports in Slack when configured.

Clear engineering requests such as "fix the typecheck in gx-backend", "run the backend tests", or
"review PR #123" are direct-routed to `dispatch_engineering` before the model spends a tool-selection
turn. That keeps the spoken acknowledgement near the same latency class as browser/app/shell fast
paths while the actual Codex work continues in Terminal.

## How `dispatch_to_claude` Works

This route is opt-in. It needs a Slack thread to report into (the existing Stop-hook posts results there). On the
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
- `bun run bin/friday-voice-latency-smoke.ts` validates the action path: first turn is
  silent tool selection (`output_modalities: ["text"]`), no pre-tool audio is allowed, slow
  shell work must return as a managed background job, and the spoken acknowledgement must start
  within the configured budget. Tool-selection responses stay in audio mode, but function-call-only
  responses are treated as intentionally silent; this avoids the no-audio acknowledgement issue seen
  after text-only tool-selection turns.
- Daemon start (detached) -> toggle ON -> **WS connected to gpt-realtime-2 (auth accepted, no
  schema error)** -> toggle OFF (clean WS close 1000) -> stop -> pid cleared. See
  `/tmp/friday-voice/daemon.log`.
- Live probe through the running daemon speaks successfully; status reports the probe transcript,
  response count, and first-audio timing.
- Mic path is validated with `bin/friday-voice mic-test`; if the peak is below the local VAD level,
  FRIDAY will appear to listen without opening a user turn.
