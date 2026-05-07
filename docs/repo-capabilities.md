# Repo Capabilities

> **Edit this file** to document the skills, agents, and slash commands
> available in each target repo Friday dispatches into. The bug-triage skill
> and review agent reference this file when deciding what to invoke in a
> sub-Claude.

This file is **per-developer** — Friday doesn't read it directly. It exists
so you (and Friday) have a single source of truth for what each repo offers.

## Format (suggested)

```markdown
## <repo-name>

Path: `~/Projects/<repo-name>`

### Skills (.claude/skills/)
- `<skill-name>` — one-line purpose

### Agents (.claude/agents/)
- `<agent-name>` — one-line purpose

### Slash commands (.claude/commands/)
- `/<command>` — one-line purpose

### When to use
- <a few sentences on which kinds of tasks belong in this repo>
```

## Why bother?

Sub-Claude processes load all of a repo's `.claude/*` automatically when
spawned in that working tree. But they won't always *reach* for the right
skill — listing capabilities here lets you (or the bug-triage skill) name
them explicitly in dispatch prompts:

> "Use the `/raise-pr` command in this repo to open the PR — it formats
> the body the way our team expects."

## Discovery

To bootstrap this file from a directory of repos:

```bash
for repo in ~/Projects/*; do
  echo "## $(basename "$repo")"
  echo "Path: \`$repo\`"
  echo ""
  for kind in skills agents commands; do
    if [ -d "$repo/.claude/$kind" ]; then
      echo "### ${kind^}"
      ls "$repo/.claude/$kind" | sed 's/^/- /'
      echo ""
    fi
  done
done
```
