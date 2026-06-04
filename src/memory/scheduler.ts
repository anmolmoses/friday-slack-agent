import { log } from "../logger.ts";
import { runDream } from "./dreaming.ts";

interface ScheduleOptions {
  /** Hour of day (0-23) to fire the nightly dream, in local time. */
  hour: number;
  /** Minute of the hour. */
  minute: number;
  /** Opts passed through to runDream each time the timer fires. */
  dreamOptions: Parameters<typeof runDream>[0];
}

const DEFAULT_OPTIONS: ScheduleOptions = {
  hour: 3,
  minute: 0,
  dreamOptions: {
    lightLookbackDays: 3,
    deepLimit: 10,
    withNarrative: true,
    withDecay: true,
    dryRun: false,
  },
};

export function startNightlyDream(partial: Partial<ScheduleOptions> = {}): () => void {
  const opts: ScheduleOptions = {
    ...DEFAULT_OPTIONS,
    ...partial,
    dreamOptions: { ...DEFAULT_OPTIONS.dreamOptions, ...partial.dreamOptions },
  };

  let timeout: ReturnType<typeof setTimeout> | null = null;

  const schedule = (): void => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(opts.hour, opts.minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delayMs = next.getTime() - now.getTime();
    log.info(
      "memory/scheduler",
      `next dream at ${next.toISOString()} (in ${Math.round(delayMs / 60000)}m)`,
    );
    timeout = setTimeout(async () => {
      try {
        log.info("memory/scheduler", "starting nightly dream");
        const result = await runDream(opts.dreamOptions);
        log.info(
          "memory/scheduler",
          `dream done — light=${result.lightHits} rem=${result.remHits} deep=${result.deepPromoted} decay=${result.decayArchived}`,
        );
      } catch (err) {
        log.error("memory/scheduler", `dream failed: ${err}`);
      } finally {
        schedule();
      }
    }, delayMs);
  };

  schedule();

  return () => {
    if (timeout) clearTimeout(timeout);
  };
}
