# Friday — Installation Guide

Step-by-step setup for a fresh machine. Friday is a Slack bot that orchestrates Claude Code as a subprocess — when a Slack message arrives, it spawns a `claude -p` process per thread, streams the response back to Slack, and manages session state.

**Estimated time:** 30–45 minutes for the first run, mostly waiting on Slack App creation and token approvals.

---

## Prerequisites

Before you start, make sure you have:

- **macOS or Linux** (Windows works via WSL but isn't tested)
- **Admin access to a Slack workspace** — you need to create a Slack App in it. If you're not an admin, an admin will need to approve the app.
- **A Claude Max subscription** — Friday spawns the `claude` CLI, which authenticates via your Max login. No API keys, no usage-based billing. (Pro doesn't work; you need Max.)
- **A GitHub account with `gh` CLI installed and authenticated** — Friday uses `gh` for PR operations. Run `gh auth status` to verify.
- **Git** (any modern version).

You do **not** need: Node, npm, Docker, Redis, Postgres. Bun replaces Node; Friday's session store defaults to in-memory.

---

## Step 1 — Install Bun

Bun is the JavaScript runtime Friday uses (faster than Node, runs TypeScript natively, no build step).

```bash
curl -fsSL https://bun.sh/install | bash
```

Follow the post-install instructions to add Bun to your shell `PATH` (the installer prints the exact line; usually `export BUN_INSTALL="$HOME/.bun"` and `export PATH="$BUN_INSTALL/bin:$PATH"` in your `~/.zshrc` or `~/.bashrc`).

Then verify:

```bash
bun --version
# 1.3.x or later
```

If `bun: command not found`, restart your shell or `source ~/.zshrc`.

---

## Step 2 — Install Claude Code CLI

Friday spawns the `claude` CLI as a child process for every Slack message. You need it on `PATH` and authenticated.

### Install

Follow the official installer at <https://docs.anthropic.com/en/docs/claude-code/setup>. The one-liner is usually:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Or via Homebrew on macOS:

```bash
brew install anthropic/anthropic/claude
```

### Authenticate

```bash
claude
```

This launches the REPL. On first run it opens a browser to log in with your Anthropic account. **Choose the Max plan when prompted** — Friday's whole architecture relies on Max-subscription auth, and Pro will rate-limit you out of the box.

Once you see the REPL prompt, type `/exit` to close it.

### Verify

```bash
claude --version
# Should print a version like 2.x.x

which claude
# Should print a path like /Users/you/.local/bin/claude or /opt/homebrew/bin/claude
```

If `claude: command not found`, the installer didn't put it on `PATH`. Add the install directory (often `~/.local/bin`) to your shell `PATH` and reopen your shell.

---

## Step 3 — Clone Friday & install dependencies

```bash
git clone <your-friday-repo-url> ~/code/Friday
cd ~/code/Friday
bun install
```

`bun install` should finish in a few seconds. If it errors out with a network/registry issue, retry — Bun caches aggressively and the second attempt usually works.

Verify it built:

```bash
bun run typecheck
# No output = success
```

---

## Step 4 — Create your Slack App

Friday needs its own Slack App. Don't reuse someone else's — sharing tokens means duplicate replies on every message.

### 4a. Create the app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it something like `Friday (yourname)` so it's distinguishable from teammates' instances.
3. Pick the workspace you want it in.

### 4b. Enable Socket Mode

In the app settings, sidebar → **Socket Mode** → toggle **Enable Socket Mode**. It will prompt you to create an **App-Level Token**:

- Name: `socket`
- Scope: `connections:write`
- Click **Generate**
- **Copy the token (starts with `xapp-`)** — this is your `SLACK_APP_TOKEN`. You won't see it again after closing the dialog, so paste it somewhere temporarily.

### 4c. Add Bot Token Scopes

Sidebar → **OAuth & Permissions** → **Bot Token Scopes** → **Add an OAuth Scope** for each of these:

```
app_mentions:read
channels:history
channels:read
chat:write
files:read
files:write
groups:history
groups:read
im:history
im:read
im:write
mpim:history
mpim:read
reactions:write
users:read
```

(Optional, only if you want the standup workflow to post AS you instead of as the bot: also add `chat:write` to **User Token Scopes**, separately from Bot Token Scopes. This gives you an `xoxp-` user token in addition to the `xoxb-` bot token.)

### 4d. Subscribe to events

Sidebar → **Event Subscriptions** → toggle **Enable Events**. Under **Subscribe to bot events**, add:

```
app_mention
message.channels
message.groups
message.im
message.mpim
```

(Don't worry about a Request URL — Socket Mode doesn't use one.)

### 4e. Install to your workspace

Sidebar → **Install App** → **Install to Workspace** → approve the prompt.

After install:

- Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is `SLACK_BOT_TOKEN`.
- (If you added user-token scopes) copy the **User OAuth Token** (starts with `xoxp-`) — this is `SLACK_USER_TOKEN`.

### 4f. Grab the signing secret

Sidebar → **Basic Information** → **App Credentials** → **Signing Secret** → **Show** → copy it. This is `SLACK_SIGNING_SECRET`.

---

## Step 5 — Find your Slack user ID

Friday gates control commands (`!build`, `!reset`, etc.) to a single owner — you. To find your user ID:

1. Open Slack (desktop app or web).
2. Click your profile picture → **Profile**.
3. Click the **More** button (`⋯`) → **Copy member ID**.

It looks like `U01ABC2345`. Save it — that's `FRIDAY_OWNER_USER_ID`.

---

## Step 6 — Configure `.env`

Copy the example and edit it:

```bash
cp .env.example .env
```

Open `.env` in your editor and fill in **at minimum**:

```bash
SLACK_BOT_TOKEN=xoxb-...           # from Step 4e
SLACK_APP_TOKEN=xapp-...           # from Step 4b
SLACK_SIGNING_SECRET=...           # from Step 4f
SLACK_WORKSPACE_DOMAIN=...         # the part before .slack.com in your URL (e.g. "myteam" if your URL is myteam.slack.com)
FRIDAY_OWNER_USER_ID=U...          # from Step 5
REPOS=[...]                        # see below
```

### `REPOS` — target repos Friday can build/review in

`REPOS` is a JSON array of repos Friday is allowed to spawn worktrees in and build/review against. Each entry needs `name`, `path` (absolute, on YOUR machine), and `defaultBase` (usually `origin/main`).

Example:

```bash
REPOS=[{"name":"my-backend","path":"/Users/you/code/my-backend","defaultBase":"origin/main"},{"name":"my-frontend","path":"/Users/you/code/my-frontend","defaultBase":"origin/main"}]
```

Tip: the JSON must be a single line (no newlines) for `.env` to parse it.

If you don't have target repos yet, you can leave it empty — `REPOS=[]` — and add them later. Friday will still respond to messages, just without repo-aware features.

### Optional — routing (recommended after the basics work)

These let Friday auto-respond to specific patterns without an `@mention`:

```bash
# A sandbox channel where you'll test Friday's behaviors
FRIDAY_TEST_CHANNELS=C0XXXXXXXXX

# Channels where Friday auto-replies to every human message (no @mention).
# Use sparingly — usually just your sandbox channel.
FRIDAY_ALWAYS_REPLY_CHANNELS=C0XXXXXXXXX

# Channels where a GitHub PR URL from a trusted user auto-triggers PR review.
FRIDAY_PR_REVIEW_CHANNELS=C0XXXXXXXXX

# Users whose PR URLs Friday will auto-review (typically: you, plus close collaborators)
FRIDAY_TRUSTED_USER_IDS=U0XXXXXXXX,U0YYYYYYY

# Channels where bug-report-shaped messages auto-trigger triage.
FRIDAY_BUG_TRIAGE_CHANNELS=C0XXXXXXXXX

# Users Friday will NEVER auto-reply to (e.g. execs you only want to react 👀 to)
FRIDAY_NO_REPLY_USER_IDS=
```

To find a channel ID: in Slack, right-click the channel → **View channel details** → scroll to the bottom → copy the **Channel ID** (starts with `C`).

Skip this whole block on your first install. You can add it later once the basics work.

### Optional — daily standup workflow

Leave all three empty unless you specifically want the daily standup feature:

```bash
FRIDAY_STANDUP_KICKOFF_CHANNEL=
FRIDAY_STANDUP_TARGET_CHANNEL=
FRIDAY_STANDUP_FOCUS_BOT_ID=
```

Standup is **disabled** unless all three are set.

---

## Step 7 — Drop in your persona files (optional but recommended)

Friday loads your "personality" from `openclaw/*.md` at startup. The directory is gitignored — each developer has their own. If you skip this step, Friday boots fine, just without personality or memory.

Create the files manually or copy templates from a teammate:

```
openclaw/
  IDENTITY.md   # one paragraph: name, role, signature emoji, voice
  SOUL.md       # personality, voice rules, behavior calibration
  AGENTS.md     # the agent squad and dispatch rules
  USER.md       # who YOU are (the human Friday works with)
  TOOLS.md      # local scripts, tools, conventions
```

Easiest start: write a 2-paragraph `IDENTITY.md` and `USER.md`, leave the rest empty. Grow from there.

`openclaw/README.md` (already shipped) explains this in more detail.

### Memory templates (optional)

`memory/runbooks/bug-triage.md` and `memory/runbooks/pr-review.md` ship as starter templates. Edit them to match your channels, repo names, and review conventions.

---

## Step 8 — First run

```bash
bun run dev
```

You should see boot logs:

```
[boot] Friday is running (Socket Mode)
```

If you get `Missing required env var: SLACK_BOT_TOKEN`, your `.env` isn't being loaded — make sure you're in the repo root and the file exists.

If you see Bolt warnings about scopes or `not_authed`, the bot wasn't installed properly — go back to Step 4e.

---

## Step 9 — Test it

In Slack, **DM your bot** (search for the app name, open a DM):

```
hello
```

Friday should reply within a few seconds. While she's thinking you'll see a rotating verb status (`✽ Pondering…`), then a final response.

If she doesn't reply:

| Symptom | Fix |
|---|---|
| No response, no logs | Bot not in Socket Mode, or `xapp-` token missing/wrong |
| Logs show `not_in_channel` | Invite the bot to the channel: `/invite @YourBot` |
| Logs show Claude auth error | `claude` CLI not authenticated; run `claude` once and log in |
| `command not found: claude` from a spawn | `claude` not on PATH for the user running Friday — check `which claude`, set `CLAUDE_BIN=$(which claude)` in `.env` |
| Bot says "only the owner can invoke" on every command | `FRIDAY_OWNER_USER_ID` doesn't match your Slack user ID |
| Followup permalinks malformed | `SLACK_WORKSPACE_DOMAIN` not set |

---

## Step 10 — Run it persistently (optional)

For day-to-day use you want Friday running in the background, restarting on crashes.

### Option A — pm2 (simplest)

```bash
npm i -g pm2
cd ~/code/Friday
pm2 start "bun run start" --name friday
pm2 save
pm2 startup    # follow the printed command to register on boot
```

Logs: `pm2 logs friday`. Restart: `pm2 restart friday`. Stop: `pm2 stop friday`.

### Option B — launchd (macOS native)

Create `~/Library/LaunchAgents/com.you.friday.plist` with:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.you.friday</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.bun/bin/bun</string>
    <string>run</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/code/Friday</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/code/Friday/logs/friday.log</string>
  <key>StandardErrorPath</key><string>/Users/you/code/Friday/logs/friday.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/Users/you/.bun/bin:/Users/you/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Replace `/Users/you/...` paths and the `PATH` with what `which bun` and `which claude` print on your machine.

Load it:

```bash
launchctl load -w ~/Library/LaunchAgents/com.you.friday.plist
```

Unload: `launchctl unload ~/Library/LaunchAgents/com.you.friday.plist`. Logs are in `logs/friday.log` and `logs/friday.err.log`.

---

## What to do next

- **Add target repos** to `REPOS` and try `!build <task>` in a thread.
- **Wire up auto-routing** by setting `FRIDAY_PR_REVIEW_CHANNELS` and `FRIDAY_BUG_TRIAGE_CHANNELS` for the channels you live in.
- **Customize `memory/runbooks/`** so Friday's bug-triage and PR-review flows match your team's conventions.
- **Add agent definitions** in `.claude/agents/` for specialized sub-agents (the repo ships with `architect`, `build`, `frontend`, `pm`, `review` as starters).

For deeper architecture and feature docs, see `CLAUDE.md` and the `docs/` directory.

---

## Common pitfalls

- **Two Friday instances on the same Slack app** → duplicate replies on every message. Each developer needs their own Slack App (Step 4).
- **Pro instead of Max** → you'll hit rate limits within minutes. Upgrade to Max.
- **`FRIDAY_OWNER_USER_ID` in the wrong format** → must be a Slack user ID like `U01ABC2345`, not your @handle or display name.
- **`REPOS` paths with `~`** → may not expand depending on shell. Use absolute paths starting with `/Users/you/...`.
- **Bot not in the channel** → DMs work without an invite, but channel mentions don't. `/invite @YourBot` in any channel you want her to operate in.
