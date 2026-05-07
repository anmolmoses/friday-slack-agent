import type { SpawnHandle, SpawnResult } from "../claude/types.ts";

/**
 * Guard a Claude subprocess against hanging — WITHOUT killing it just for
 * taking a while.
 *
 * The old behaviour was a hard timeout measured from spawn: the process was
 * killed at `idleMs` regardless of whether Claude was actively working. A
 * real task ("commit on the PR + edit the docs") routinely runs past 5
 * minutes of *productive* work — reading files, editing, git, posting
 * comments — and got killed mid-turn with "Process timed out after 300000ms".
 *
 * Now `idleMs` is an INACTIVITY window: the timer resets on every stream
 * event (tool_use, tool_result, text, thinking). It only fires after that
 * much *silence* — i.e. the process is genuinely wedged. `maxMs` is an
 * absolute ceiling so a runaway loop that keeps emitting events forever still
 * terminates (preserves the zombie-process guarantee).
 */
export function withTimeout(
  handle: SpawnHandle,
  idleMs: number,
  onTimeout?: (reason: string) => void,
  maxMs?: number,
): SpawnHandle {
  let timedOut = false;
  let idleTimer: ReturnType<typeof setTimeout>;
  let absTimer: ReturnType<typeof setTimeout> | undefined;

  const result = new Promise<SpawnResult>((resolve) => {
    const fire = (reason: string) => {
      if (timedOut) return;
      timedOut = true;
      clearTimeout(idleTimer);
      if (absTimer) clearTimeout(absTimer);
      handle.kill();
      onTimeout?.(reason);
      resolve({
        sessionId: null,
        response: "",
        events: [],
        exitCode: null,
        error: `Process timed out after ${reason}`,
      });
    };

    const resetIdle = () => {
      if (timedOut) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => fire(`${idleMs}ms of inactivity`),
        idleMs,
      );
    };

    resetIdle();
    if (maxMs && maxMs > 0) {
      absTimer = setTimeout(() => fire(`${maxMs}ms (absolute max)`), maxMs);
    }

    // Any stream event = the process is alive and working. Reset the idle clock.
    handle.onEvent(() => resetIdle());

    handle.result.then((res) => {
      clearTimeout(idleTimer);
      if (absTimer) clearTimeout(absTimer);
      if (!timedOut) resolve(res);
    });
  });

  return {
    result,
    onEvent: handle.onEvent,
    kill: handle.kill,
    pid: handle.pid,
    spawnInfo: handle.spawnInfo,
  };
}
