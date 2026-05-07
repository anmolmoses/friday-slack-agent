import { TtlCache } from "./ttl-cache.ts";

const SIXTY_SECONDS = 60 * 1000;

export interface CachedThreadMessage {
  user: string;
  text: string;
  ts: string;
  isBot: boolean;
}

/**
 * Caches Slack thread history with 60-second TTL.
 * Prevents re-fetching the same thread on rapid-fire messages.
 */
export class ThreadContextCache {
  private cache = new TtlCache<string, CachedThreadMessage[]>(SIXTY_SECONDS);

  get(threadId: string): CachedThreadMessage[] | undefined {
    return this.cache.get(threadId);
  }

  set(threadId: string, messages: CachedThreadMessage[]): void {
    this.cache.set(threadId, messages);
  }

  /** Invalidate when a new message arrives in the thread. */
  invalidate(threadId: string): void {
    this.cache.invalidate(threadId);
  }

  prune(): void {
    this.cache.prune();
  }
}
