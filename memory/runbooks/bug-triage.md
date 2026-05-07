# Bug Triage Runbook

## Trigger
Someone files a bug in Slack — usually #bugs-backlog (C05557KKV37) — by @mentioning Friday or by posting a structured bug report. The full skill version lives at `.claude/skills/bug-triage/SKILL.md`; this runbook is the short reference.

## Permission

**You do NOT need Anmol's approval for the following — work directly:**
- UD (`U01AG6F9W69`) tags Friday in #bugs-backlog or asks for code review / debug / feature build. Anmol pre-authorized this. **Do not "loop Anmol" or wait for him.** Pick the repo, dispatch, fix, raise PRs.
- Any structured bug report from the `BUG_REPORT_BOT_USER` (U0ANDM5M62Z) in #bugs-backlog.
- Pranav (U03PNSJ33S5) or Alok (U04U7RS55PS) reporting in any channel.

You DO need Anmol's call when:
- A `fix/*` branch already exists for this bug, or there's a large WIP branch in the same area you'd conflict with.
- The fix would change product behavior, copy, or design — not just code.
- The bug surface spans multiple repos and the root cause isn't clear after investigation.
- You can't reproduce or locate the bug after the full step-5 escalation ladder.

**How you ask Anmol — DM only, not in the thread:**

If you're a dispatched Claude (running in tmux), wrap the question in a sentinel as your FINAL assistant text:
```
<ask-anmol>
What I tried: ...
Why I'm blocked: ...
Question: ...
</ask-anmol>
```
The dispatch hook detects this, DMs Anmol (`U0AKP5PAWEB`) with the question + originating thread URL, and **suppresses** the thread post. The originating thread (where UD reported the bug) stays clean — only outcomes go there.

If you're Friday's main spawn, use `bin/slack-dm.sh U0AKP5PAWEB "<summary + thread URL + question>"` directly and stay silent in the thread until you have an answer to relay or an outcome to report. Synonyms recognized: `<cant-resolve>`, `<needs-input>`.

## Steps

1. **Read the bug fully** — `bin/slack-read-url.sh <url>` from `/Users/anmol/Documents/GitHub/Friday`. Read every reply, every screenshot description, every linked URL. Don't stop at the first message.

2. **Classify**
   - **Severity:** critical / high / medium / low
   - **Domain (USE THE ROUTING RULES BELOW — DO NOT GUESS):** backend / frontend / mobile / iOS
   - **Repo:** the local checkout under `/Users/anmol/Documents/GitHub/`. State your routing reasoning in one sentence before moving on.

3. **Repo routing — hard rules, no equivocation**

   Apply in order. First match wins. **Stop reading at the first match. Don't second-guess.**

   1. **Strong frontend signals → `gx-client-next`** (web) or `gx-client-expo` (mobile). Triggers (any one):
      - The reporter says **"FE"**, **"the UI"**, **"the form"**, **"the modal"**, **"the screen"**, **"the page"**, **"the toast"**, **"the button"**, **"the dropdown"**, **"after refresh"**, **"on save"**, **"after submit"**.
      - The reporter says **"X disappears"**, **"X is gone"**, **"X gets removed"**, **"value resets"**, **"field empties"** — this is almost always a render/cache/payload issue on the client.
      - A `growthx.club/...` URL is shared *with no backend stack trace*.
      - Phrasing like **"why FE removes it"** or **"why FE says it's saved"** — these are explicit FE accusations. **DO NOT investigate backend first to "rule it out."** Go to the named repo.
   2. **Mobile-specific signals → `gx-client-expo`**: "iOS app", "Android app", "Expo", "React Native", a screenshot showing a phone status bar.
   3. **Native iOS signals → `GrowthX-iOS`**: "Swift", "Xcode", "TestFlight", "iOS native".
   4. **Admin-only signals → `gx-admin-client`**: "/admin/...", "admin panel", category management, internal tools.
   5. **Strong backend signals → `gx-backend`**: 500 error, stack trace, "API returns wrong X", missing field in API response, webhook didn't fire, cron didn't run, payment didn't process, database write didn't happen.
   6. **Mention of "logs" / "New Relic" / "Sentry" alone is NOT a routing signal.** Logs are a *data source* for investigation, not a hint about which repo to fix in. The bug can still be on the FE even if the user wants you to read backend logs to confirm.

   If the reporter explicitly names a repo or surface (e.g. "check `gx-client-next`") — that overrides everything above. Use what they said.

   When the reporter is wrong about the repo (rare), only switch *after* you've actually investigated and have evidence. Don't pre-emptively cross repos because you "feel" they got it wrong.

4. **Check for prior work**
   ```bash
   cd /Users/anmol/Documents/GitHub/<repo>
   git fetch origin --prune
   git branch -a | grep -iE 'fix/.*<keyword>'
   git status
   ```
   If a `fix/` branch already exists for this bug or there's WIP in the area, **resume that branch** — don't silently start a new one.

5. **Investigate — use the escalation ladder, don't bail on grep alone**

   - **Step 1: Grep.** Look for the literal symptom keywords from the report.
   - **Step 2: Read CLAUDE.md** in the target repo. Conventions you must follow.
   - **Step 3: Trace the flow.** Component → submit handler → payload → API → response → render. For UI bugs: check both component and container/wrapper for stacking, theme tokens, dark-mode classes.
   - **Step 4: Reproduce.** If grep didn't surface the bug, reproduce it. Use `playwright` MCP for web flows. Use the actual event data (fetch via `mongodb` MCP for production reads — it's read-only). Use the screenshot the user uploaded (saved at `/tmp/friday-files/<thread_ts>/`).
   - **Step 5: MCP fetch.** If a specific event/user/document was named, fetch it via the `mongodb` MCP and inspect the actual fields. Do not theorize about schema — read the document.
   - **Step 6: Recent commits.** `git log --oneline -50` and `git log --since='2 weeks ago' -p -- <file-or-dir>` to see what changed near the bug surface.
   - **Step 7: Only if 1–6 all return nothing**, post back asking for a HAR / screenshot / repro steps. **Be honest about what you DID try.** Do NOT write "Cannot reproduce — premise contradicts the codebase." That's investigative theatre, especially when you skipped steps 4–6.

   **If MCP for mongodb / playwright / new-relic / github isn't available in your environment, SAY THAT EXPLICITLY in your response.** "I don't have MongoDB MCP here, can't fetch the event directly" is honest. Dressing tools-blindness up as "the feature doesn't exist" is the failure mode that wasted UD's time on the recurring-event bug (2026-05-07).

6. **Fix** — smallest change that addresses the root cause. No drive-by refactors. Follow the repo's design tokens / Tailwind / theme variables — don't hardcode colors that need to flip in dark mode.

7. **Verify** — type-check + lint + tests, two clean passes (don't ship on the first clean run).

8. **Commit** — descriptive imperative message; reference the bug surface.

9. **Push + open TWO PRs** (`gh pr create --base dev` and `--base main`). Body must include:
   - Link to the originating Slack thread
   - Root cause (one paragraph)
   - Before/after summary
   - Test plan

10. **Post PR links back to the Slack thread.** Don't say "I'll be back with PRs" and disappear — post when they actually exist.

## Available repos (LOCAL — never clone)

```
/Users/anmol/Documents/GitHub/gx-backend         — APIs, jobs, server-side, DB
/Users/anmol/Documents/GitHub/gx-client-next     — public website (Next.js)
/Users/anmol/Documents/GitHub/gx-client-expo     — mobile (Expo / RN)
/Users/anmol/Documents/GitHub/gx-admin-client    — admin panel / internal tools
/Users/anmol/Documents/GitHub/gx-talent-client   — talent / careers site
/Users/anmol/Documents/GitHub/GrowthX-iOS        — native iOS
```

## Hard rules
- Repos are LOCAL. NEVER clone.
- Branch from `main`, fresh from `origin/main`.
- TWO PRs per fix: `dev` and `main`.
- No `--no-verify`, no force-push, no amending pushed commits.
- One bug, one branch, one fix. Multiple unrelated bugs in one report → one branch each.
- "Cannot reproduce" is a last resort, not a first move. See step 5.
