// Compiles overlay.swift → a cached binary and spawns it as the on-screen HUD.
// Compiles only when the binary is missing or older than the source.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import type { Subprocess } from "bun";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_SRC = path.join(__dirname, "hud", "overlay.swift");
const TOGGLE_CMD = path.resolve(__dirname, "../../bin/friday-voice");
const BIN = "/tmp/friday-voice/friday-hud";

const log = (...a: unknown[]) => console.log("[voice:hud]", ...a);

async function ensureBinary(): Promise<boolean> {
  try {
    const fresh =
      existsSync(BIN) && statSync(BIN).mtimeMs >= statSync(SWIFT_SRC).mtimeMs;
    if (fresh) return true;
    log("compiling overlay.swift…");
    const proc = Bun.spawn(["swiftc", "-O", SWIFT_SRC, "-o", BIN], {
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      log("swiftc failed:", (await new Response(proc.stderr).text()).slice(0, 400));
      return false;
    }
    log("overlay compiled →", BIN);
    return true;
  } catch (err) {
    log("compile error:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

function stopExistingOverlays(): void {
  const proc = Bun.spawnSync(["/usr/bin/pgrep", "-f", BIN], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const pids = new TextDecoder()
    .decode(proc.stdout)
    .split(/\s+/)
    .map((pid) => Number(pid))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* stale process */
    }
  }
}

/** Build (if needed) and launch the overlay pointed at the HUD url. Null on failure. */
export async function spawnOverlay(url: string): Promise<Subprocess | null> {
  if (!(await ensureBinary())) return null;
  try {
    stopExistingOverlays();
    // argv[2] = path to the friday-voice shim; the overlay's ⌃⌥F hotkey runs it.
    const proc = Bun.spawn([BIN, url, TOGGLE_CMD], { stdout: "ignore", stderr: "ignore" });
    log("overlay launched");
    return proc;
  } catch (err) {
    log("spawn error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
