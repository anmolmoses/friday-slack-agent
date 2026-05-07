/**
 * Dashboard mutating-API handlers (kill process, read/write files, list dirs).
 *
 * SECURITY: localhost-only. The HTTP server binds to 127.0.0.1 in
 * dashboard-server.ts. ANY process running on this machine can hit these
 * endpoints — there's no auth. That's acceptable for a single-developer
 * dev box. Do NOT bind to 0.0.0.0 or expose externally.
 *
 * File operations are scoped to a hard-coded allowlist of safe roots
 * (memory/, friday-personal/, .claude/skills/, memory/runbooks/) — outside
 * those, requests fail with 403. This prevents an accidental browser
 * bookmark from clobbering /etc/passwd.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { log } from "../logger.ts";
import type { SessionManager } from "../session/manager.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { setThreadMeta } from "./dashboard-state.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// Roots the dashboard can read AND write. Anything outside → 403.
const EDITABLE_ROOTS = [
  path.join(REPO_ROOT, "memory"),
  path.join(REPO_ROOT, "friday-personal"),
  path.join(REPO_ROOT, ".claude", "skills"),
];

// Read-only roots (browse + view, no edit). Useful for inspecting code.
const READABLE_ROOTS = [
  ...EDITABLE_ROOTS,
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "bin"),
  path.join(REPO_ROOT, "hooks"),
  path.join(REPO_ROOT, "docs"),
  path.join(REPO_ROOT, "logs"),
];

function isUnderAny(p: string, roots: string[]): boolean {
  const abs = path.resolve(p);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

// ─── File ops ────────────────────────────────────────────────────────────────

export async function handleListFiles(url: URL): Promise<Response> {
  const dir = url.searchParams.get("path") ?? path.join(REPO_ROOT, "memory");
  const abs = path.resolve(dir);
  if (!isUnderAny(abs, READABLE_ROOTS)) {
    return Response.json({ error: "path not allowed" }, { status: 403 });
  }
  if (!existsSync(abs)) return Response.json({ error: "not found" }, { status: 404 });
  const st = statSync(abs);
  if (!st.isDirectory()) return Response.json({ error: "not a directory" }, { status: 400 });

  try {
    const entries = readdirSync(abs).map((name) => {
      const full = path.join(abs, name);
      try {
        const s = statSync(full);
        return {
          name,
          path: full,
          relPath: path.relative(REPO_ROOT, full),
          isDir: s.isDirectory(),
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch {
        return { name, path: full, relPath: path.relative(REPO_ROOT, full), isDir: false, size: 0, mtimeMs: 0 };
      }
    });
    // Dirs first, then alpha
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return Response.json({
      cwd: path.relative(REPO_ROOT, abs) || ".",
      absCwd: abs,
      parent: abs === REPO_ROOT ? null : path.relative(REPO_ROOT, path.dirname(abs)),
      editable: isUnderAny(abs, EDITABLE_ROOTS),
      entries,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function handleReadFile(url: URL): Promise<Response> {
  const fp = url.searchParams.get("path");
  if (!fp) return Response.json({ error: "path required" }, { status: 400 });
  const abs = path.resolve(fp);
  if (!isUnderAny(abs, READABLE_ROOTS)) {
    return Response.json({ error: "path not allowed" }, { status: 403 });
  }
  if (!existsSync(abs)) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const st = statSync(abs);
    if (st.isDirectory()) return Response.json({ error: "is a directory" }, { status: 400 });
    if (st.size > 5 * 1024 * 1024) return Response.json({ error: "file too large (>5MB)" }, { status: 413 });
    const content = readFileSync(abs, "utf-8");
    return Response.json({
      path: abs,
      relPath: path.relative(REPO_ROOT, abs),
      size: st.size,
      mtimeMs: st.mtimeMs,
      content,
      editable: isUnderAny(abs, EDITABLE_ROOTS),
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function handleWriteFile(req: Request): Promise<Response> {
  let body: { path?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const fp = body.path;
  const content = body.content;
  if (!fp || content == null) return Response.json({ error: "path and content required" }, { status: 400 });
  const abs = path.resolve(fp);
  if (!isUnderAny(abs, EDITABLE_ROOTS)) {
    return Response.json({ error: "path not editable from dashboard" }, { status: 403 });
  }
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
    const st = statSync(abs);
    log.info("dashboard", `file write: ${path.relative(REPO_ROOT, abs)} (${st.size} bytes)`);
    return Response.json({
      ok: true,
      path: abs,
      relPath: path.relative(REPO_ROOT, abs),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

// ─── Process ops ────────────────────────────────────────────────────────────

function tmuxSessionForThread(threadId: string): string {
  return `friday-thread-${threadId.replace(/\./g, "-")}`;
}

// Strip secrets from a tmux capture-pane snapshot before sending to the
// browser. The dispatch script's `export FOO=bar` lines surface bot tokens,
// API keys, etc. Even though the dashboard is localhost-only, secrets in
// the DOM are easy to leak (devtools, screenshots, screen-share).
function redactTranscript(text: string): string {
  return text
    // export FOO_TOKEN=…  /  export FOO_SECRET=…  /  …KEY=…  /  …PASSWORD=…
    .replace(/^(\s*export\s+\w*(?:TOKEN|SECRET|KEY|PASSWORD|API|AUTH)\w*=).*$/gim, "$1<redacted>")
    // Inline tokens with recognizable prefixes
    .replace(/xox[bpsa]-[A-Za-z0-9-]{10,}/g, "<redacted-slack-token>")
    .replace(/xapp-\d-[A-Z0-9]+-\d+-[a-f0-9]+/g, "<redacted-slack-app-token>")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "<redacted-anthropic-key>")
    .replace(/sk-[A-Za-z0-9]{32,}/g, "<redacted-api-key>")
    .replace(/gh[pousr]_[A-Za-z0-9]{30,}/g, "<redacted-github-token>");
}

export async function handleListProcesses(): Promise<Response> {
  // claude children
  const claudeProc = Bun.spawnSync(["pgrep", "-fl", "claude "]);
  const claudeStdout = claudeProc.stdout?.toString() ?? "";
  const claudes = claudeStdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split(/\s+/);
      const cmd = rest.join(" ");
      // Pull MCP-config thread id if visible
      const mcpMatch = cmd.match(/friday-mcp\/([\d.]+)\.json/);
      const threadId = mcpMatch?.[1] ?? null;
      return {
        kind: "claude" as const,
        pid: Number(pid),
        cmd,
        threadId,
        friday: threadId !== null,
        tmuxSession: threadId ? tmuxSessionForThread(threadId) : null,
      };
    })
    .filter((p) => Number.isFinite(p.pid));

  // tmux dispatch sessions
  const tmuxProc = Bun.spawnSync([
    "/opt/homebrew/bin/tmux",
    "list-sessions",
    "-F",
    "#{session_name}|#{session_created}|#{session_activity}|#{session_attached}",
  ]);
  const tmuxStdout = tmuxProc.stdout?.toString() ?? "";
  const tmuxes = tmuxStdout
    .split("\n")
    .filter((l) => l.startsWith("friday-thread-"))
    .map((line) => {
      const [name, created, activity, attached] = line.split("|");
      const safe = name.replace(/^friday-thread-/, "");
      // Convert "12345-67890" back to "12345.67890" thread id
      const threadId = safe.replace(/-/g, ".");
      return {
        kind: "tmux" as const,
        name,
        threadId,
        createdSec: Number(created),
        activitySec: Number(activity),
        attached: attached === "1",
      };
    });

  // Bun PID — we ARE the bun process serving this request, so process.pid
  // is canonical. (pgrep -f "bun src/index.ts" is unreliable in some launchd
  // environments because the full argv has the absolute /Users/.../.bun/bin/bun
  // prefix that we'd need to match.)
  return Response.json({
    bunPid: process.pid,
    claudes,
    tmuxes,
  });
}

export async function handleProcessDetails(url: URL): Promise<Response> {
  const pidStr = url.searchParams.get("pid");
  if (!pidStr) return Response.json({ error: "pid required" }, { status: 400 });
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 1) {
    return Response.json({ error: "invalid pid" }, { status: 400 });
  }

  // Verify the pid exists and is something we'd surface (claude / bun / tmux child)
  const ps = Bun.spawnSync([
    "ps", "-p", String(pid), "-o", "pid=,ppid=,etime=,user=,command=",
  ]);
  const psLine = (ps.stdout?.toString() ?? "").trim();
  if (!psLine) return Response.json({ error: "process not found" }, { status: 404 });
  const m = psLine.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
  if (!m) return Response.json({ error: "ps parse failed", raw: psLine }, { status: 500 });
  const [, , ppid, etime, user, cmd] = m;

  // Working directory (lsof FD 'cwd')
  let cwd: string | null = null;
  try {
    const lsofCwd = Bun.spawnSync(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const out = lsofCwd.stdout?.toString() ?? "";
    const cwdLine = out.split("\n").find((l) => l.startsWith("n"));
    if (cwdLine) cwd = cwdLine.slice(1);
  } catch { /* ignore */ }

  // Parent process command
  let parentCmd: string | null = null;
  try {
    const pp = Bun.spawnSync(["ps", "-p", ppid, "-o", "command="]);
    parentCmd = (pp.stdout?.toString() ?? "").trim() || null;
  } catch { /* ignore */ }

  // Friday-owned? Pull thread metadata + tmux capture-pane snapshot.
  const mcpMatch = cmd.match(/friday-mcp\/([\d.]+)\.json/);
  const threadId = mcpMatch?.[1] ?? null;
  let tmuxSession: string | null = null;
  let tmuxTranscript: string | null = null;
  let thread: unknown = null;

  if (threadId) {
    tmuxSession = tmuxSessionForThread(threadId);

    // Live tmux pane capture (last ~200 lines)
    try {
      const cap = Bun.spawnSync([
        "/opt/homebrew/bin/tmux", "capture-pane", "-p", "-t", tmuxSession, "-S", "-200",
      ]);
      if (cap.exitCode === 0) tmuxTranscript = redactTranscript(cap.stdout?.toString() ?? "");
    } catch { /* tmux session may have died */ }

    // Thread metadata from dashboard state (avoids importing session-store directly)
    try {
      const { getSnapshot } = await import("./dashboard-state.ts");
      const snap = getSnapshot();
      thread = snap.threads.find((t) => t.threadId === threadId) ?? null;
    } catch { /* ignore */ }
  }

  return Response.json({
    pid,
    ppid: Number(ppid),
    user,
    etime,
    cmd,
    cwd,
    parentCmd,
    threadId,
    tmuxSession,
    tmuxTranscript,
    thread,
  });
}

export async function handleAttachTerminal(req: Request): Promise<Response> {
  let body: { tmuxSession?: string };
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid JSON body" }, { status: 400 }); }

  const session = body.tmuxSession;
  if (!session || typeof session !== "string") {
    return Response.json({ error: "tmuxSession required" }, { status: 400 });
  }
  if (!/^friday-thread-[\d-]+$/.test(session)) {
    return Response.json({ error: "only friday-thread-* sessions are attachable" }, { status: 403 });
  }

  // Verify the tmux session exists
  const exists = Bun.spawnSync(["/opt/homebrew/bin/tmux", "has-session", "-t", session]);
  if (exists.exitCode !== 0) {
    return Response.json({ error: "tmux session not found" }, { status: 404 });
  }

  // Open Terminal.app and run tmux attach. Each call opens a new window.
  const script = `tell application "Terminal"
  activate
  do script "tmux attach -t ${session.replace(/"/g, '\\"')}"
end tell`;

  const r = Bun.spawnSync(["osascript", "-e", script]);
  if (r.exitCode !== 0) {
    const err = r.stderr?.toString() ?? "";
    log.warn("dashboard", `attach terminal failed for ${session}: ${err}`);
    return Response.json({ error: "osascript failed", detail: err }, { status: 500 });
  }
  log.info("dashboard", `opened Terminal attached to ${session}`);
  return Response.json({ ok: true });
}

// ─── Thread ops (stop / mute) ─────────────────────────────────────────────────

// Stop a thread NOW: kill its in-flight claude run + tmux dispatch session,
// drop buffered messages, and mute it so Friday ignores the thread until
// resumed. Keeps the session row (resume sessionId) so Resume continues.
export async function handleThreadKill(req: Request, manager: SessionManager): Promise<Response> {
  let body: { threadId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.threadId) return Response.json({ error: "threadId required" }, { status: 400 });

  const result = await manager.killThread(body.threadId, { mute: true });
  if (!result.found) return Response.json({ error: "thread not found" }, { status: 404 });

  // Reflect into dashboard-state so the next SSE snapshot shows muted/idle
  // (the session store and dashboard state are separate maps).
  setThreadMeta(body.threadId, { muted: result.muted, status: "idle", pid: null, pendingCount: 0 });
  log.info("dashboard", `thread stop ${body.threadId} → killedRun=${result.killedRun} muted=${result.muted}`);
  return Response.json({ ok: true, ...result });
}

// Toggle mute without touching a running process (dashboard Resume / mute).
export async function handleThreadMute(req: Request, manager: SessionManager): Promise<Response> {
  let body: { threadId?: string; muted?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.threadId || typeof body.muted !== "boolean") {
    return Response.json({ error: "threadId and muted (boolean) required" }, { status: 400 });
  }

  const result = await manager.setMuted(body.threadId, body.muted);
  if (!result.found) return Response.json({ error: "thread not found" }, { status: 404 });

  setThreadMeta(body.threadId, { muted: result.muted });
  log.info("dashboard", `thread mute ${body.threadId} → ${result.muted}`);
  return Response.json({ ok: true, ...result });
}

/**
 * Manually purge a single worktree (dashboard "✕" button). Force-removes the
 * worktree dir + its slack branch via WorktreeManager.removeWorktree — this
 * works on DIRTY worktrees too (uncommitted changes are discarded), so the
 * client confirms first. Refreshes the dashboard's worktree picture after.
 */
export async function handleWorktreePurge(
  req: Request,
  worktreeManager: WorktreeManager,
  refreshWorktrees: () => Promise<void>,
): Promise<Response> {
  let body: { repoName?: string; threadId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.repoName || !body.threadId) {
    return Response.json({ error: "repoName and threadId required" }, { status: 400 });
  }
  try {
    await worktreeManager.removeWorktree(body.repoName, body.threadId);
    await refreshWorktrees();
    log.info("dashboard", `worktree purged ${body.repoName}/${body.threadId}`);
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("dashboard", `worktree purge failed ${body.repoName}/${body.threadId}: ${msg}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function handleKillProcess(req: Request): Promise<Response> {
  let body: { kind?: string; pid?: number; tmuxName?: string; signal?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const sig = body.signal ?? "TERM";

  if (body.kind === "tmux" && body.tmuxName) {
    if (!body.tmuxName.startsWith("friday-thread-")) {
      return Response.json({ error: "only friday-thread-* tmux sessions can be killed from dashboard" }, { status: 403 });
    }
    const r = Bun.spawnSync([
      "/opt/homebrew/bin/tmux", "kill-session", "-t", body.tmuxName,
    ]);
    log.info("dashboard", `tmux kill ${body.tmuxName} → ${r.exitCode === 0 ? "ok" : "fail"}`);
    return Response.json({ ok: r.exitCode === 0, exitCode: r.exitCode });
  }

  if (body.pid && Number.isFinite(body.pid)) {
    // Sanity: refuse to kill PID 1, the dashboard's own PID, or non-claude / non-bun processes
    if (body.pid <= 1) return Response.json({ error: "refusing to kill PID <= 1" }, { status: 400 });
    if (body.pid === process.pid) return Response.json({ error: "refusing to kill self" }, { status: 400 });
    // Verify it's a claude or bun process
    const psProc = Bun.spawnSync(["ps", "-p", String(body.pid), "-o", "command="]);
    const cmd = (psProc.stdout?.toString() ?? "").trim();
    if (!cmd) return Response.json({ error: "process not found" }, { status: 404 });
    if (!cmd.includes("claude") && !cmd.includes("bun src/index.ts")) {
      return Response.json({ error: `refusing to kill non-friday process: ${cmd.slice(0, 80)}` }, { status: 403 });
    }
    const r = Bun.spawnSync(["kill", `-${sig}`, String(body.pid)]);
    log.info("dashboard", `kill ${sig} ${body.pid} (${cmd.slice(0,60)}) → ${r.exitCode === 0 ? "ok" : "fail"}`);
    return Response.json({ ok: r.exitCode === 0, exitCode: r.exitCode, killedCmd: cmd });
  }

  return Response.json({ error: "must specify pid or tmuxName+kind=tmux" }, { status: 400 });
}
