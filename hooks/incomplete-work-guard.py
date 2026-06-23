#!/usr/bin/env python3
"""Incomplete-work guard for Friday runs.

Given a finished run's transcript, decide whether the run STALLED mid-task and
left uncommitted, unpushed work — and if so, print a human-readable report of
the affected repos (one line each). Empty output ⇒ nothing to warn about.

Why this exists (2026-06-22 scar): a per-message Friday run was asked to fix a
PR review. It applied one of four fixes, then the turn was cut off (max-turns /
timeout) right after the Edit — Slack showed only an interim "applying the
fixes…" line, the fix sat uncommitted in the clone, nothing was pushed, and the
PR looked untouched for hours. A finished task either commits+pushes or changes
nothing; an unfinished one leaves a dirty tree. We detect that and surface it.

Signal (high precision):
  truncated  = the run's LAST assistant message carried NO text block (it ended
               on a bare tool call) → the process was cut off mid-action.
               A normal turn — including one that pauses to ask the user a
               question — ends with an assistant TEXT block, so this does not
               fire on intentional mid-task pauses.
  uncommitted = a repo the run edited (Edit/Write/MultiEdit/NotebookEdit) still
               has a dirty working tree.

We warn only when BOTH hold. Usage:
  incomplete-work-guard.py <transcript.jsonl> [--debug]
"""
import json, os, subprocess, sys

EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}


def parse_transcript(path):
    """Return (truncated: bool, edited_paths: list[str])."""
    last_assistant_had_text = None  # None until we see an assistant message
    edited = []

    def add(p):
        if p and p not in edited:
            edited.append(p)

    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                msg = ev.get("message")
                if not isinstance(msg, dict):
                    continue
                if msg.get("role") != "assistant":
                    continue
                content = msg.get("content")
                if not isinstance(content, list):
                    continue
                last_assistant_had_text = any(
                    isinstance(c, dict)
                    and c.get("type") == "text"
                    and (c.get("text") or "").strip()
                    for c in content
                )
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") in EDIT_TOOLS:
                        inp = c.get("input") or {}
                        add(inp.get("file_path") or inp.get("notebook_path"))
    except Exception:
        pass

    truncated = last_assistant_had_text is False
    return truncated, edited


def repo_root(path):
    d = path if os.path.isdir(path) else os.path.dirname(path)
    try:
        return subprocess.check_output(
            ["git", "-C", d, "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return None


def dirty_paths(root):
    """Set of repo-relative paths with uncommitted state (modified/staged/untracked)."""
    try:
        out = subprocess.check_output(
            ["git", "-C", root, "status", "--porcelain"], stderr=subprocess.DEVNULL
        ).decode()
    except Exception:
        return set()
    paths = set()
    for line in out.splitlines():
        if len(line) < 4:
            continue
        p = line[3:].strip()
        if " -> " in p:  # rename: "old -> new"
            p = p.split(" -> ", 1)[1]
        paths.add(p.strip('"'))
    return paths


def dirty_report(edited_paths):
    """Report repos where the FILES THIS RUN EDITED are still uncommitted.

    Keyed on the edited files specifically (not just "is the repo dirty"), so
    unrelated working-tree noise (e.g. an untracked .claude/ dir) never produces
    a false alarm about already-committed work.
    """
    by_repo = {}
    for p in edited_paths:
        p = (p or "").strip()
        if not p or not os.path.exists(p):
            continue
        root = repo_root(p)
        if root:
            by_repo.setdefault(root, []).append(p)

    lines = []
    for root, ps in by_repo.items():
        dirty = dirty_paths(root)
        # realpath both sides before relpath: git returns a resolved toplevel,
        # but the edited path comes from the transcript as-typed and may run
        # through a symlink (macOS /var→/private/var, or a symlinked worktree),
        # which would otherwise produce a "../../" relpath that never matches.
        real_root = os.path.realpath(root)
        edited_rel = sorted({os.path.relpath(os.path.realpath(x), real_root) for x in ps})
        still_uncommitted = [r for r in edited_rel if r in dirty]
        if not still_uncommitted:
            continue  # the run's edits were committed — nothing stranded here
        try:
            branch = subprocess.check_output(
                ["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
                stderr=subprocess.DEVNULL,
            ).decode().strip()
        except Exception:
            branch = "?"
        files = ", ".join(still_uncommitted)
        lines.append(
            f"• {os.path.basename(root)} (branch {branch}): "
            f"{len(still_uncommitted)} uncommitted file(s) — {files}"
        )
    return lines


def main():
    args = [a for a in sys.argv[1:] if a != "--debug"]
    debug = "--debug" in sys.argv
    if not args:
        return 0
    transcript = args[0]
    truncated, edited = parse_transcript(transcript)
    if debug:
        sys.stderr.write(f"[guard] truncated={truncated} edited={edited}\n")
    if not truncated or not edited:
        return 0
    lines = dirty_report(edited)
    if lines:
        print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
