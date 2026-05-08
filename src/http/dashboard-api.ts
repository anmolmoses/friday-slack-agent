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
      return {
        kind: "claude" as const,
        pid: Number(pid),
        cmd,
        threadId: mcpMatch?.[1] ?? null,
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
