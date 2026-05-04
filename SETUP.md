# Setup

How to run Friday on a fresh machine. The repo ships **code only** — all
personality and memory MD files are gitignored so each developer brings
their own.

## 1. Install runtimes

```bash
# Bun
curl -fsSL https://bun.sh/install | bash

# Claude Code CLI (Max subscription required — no API keys)
curl -fsSL https://claude.ai/install.sh | bash
claude   # one-time login
```

## 2. Clone & install

```bash
git clone https://github.com/<owner>/Friday.git
cd Friday
bun install
```

## 3. Slack app

Each developer creates their own Slack app (sharing tokens means duplicate
replies). At https://api.slack.com/apps:

- **Socket Mode:** enabled. App-Level Token with `connections:write` →
  `SLACK_APP_TOKEN`.
- **Bot Token Scopes:** `app_mentions:read`, `channels:history`,
  `channels:read`, `chat:write`, `files:read`, `files:write`,
  `groups:history`, `groups:read`, `im:history`, `im:read`,
  `mpim:history`, `mpim:read`, `reactions:write`, `users:read`.
- **Event Subscriptions:** `app_mention`, `message.channels`,
  `message.groups`, `message.im`, `message.mpim`.
- Install to workspace → grab `SLACK_BOT_TOKEN` (xoxb-) and
  `SLACK_SIGNING_SECRET`.

## 4. Configure

```bash
cp .env.example .env
# fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
# update REPOS to point at YOUR local clones
```

## 5. Plug in your MD files

These are all gitignored. Drop in your own copies (or start empty — Friday
is robust to missing files):

```
openclaw/
  IDENTITY.md   # who Friday is — one paragraph
  SOUL.md       # personality, voice, behavior rules
  AGENTS.md     # the agent squad and dispatch rules
  USER.md       # who YOU are (the human she works with)
  TOOLS.md      # local tools, scripts, conventions

memory/
  MEMORY.md       # long-term memory index
  instructions.md # memory-system rules
  daily/          # daily notes (auto-populated)
  people/         # workspace people, slack users, etc.
  runbooks/       # how-to docs Friday refers to
```

If you don't have any of these yet, Friday boots fine without them — she
just won't have personality or memory. Start by writing `IDENTITY.md` and
`USER.md` and grow from there.

## 6. Run

```bash
bun run dev               # watch mode, restarts on change
# or
bun run start             # one-shot
```

Then DM the bot in Slack, or open http://localhost:3000 for the dashboard.

## 7. Run persistently (optional, macOS)

Either pm2:

```bash
npm i -g pm2
pm2 start "bun run start" --name friday
pm2 save && pm2 startup
```

…or a launchd plist at `~/Library/LaunchAgents/<your-id>.friday.plist`
pointing at your `bun` binary, the repo path, and a `PATH` that includes
your `claude` binary location. Reload with `launchctl load -w <plist>`.
