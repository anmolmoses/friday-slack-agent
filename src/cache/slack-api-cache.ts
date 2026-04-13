import { TtlCache } from "./ttl-cache.ts";

const FIVE_MINUTES = 5 * 60 * 1000;

export interface CachedUserInfo {
  id: string;
  name: string;
  realName: string;
  isBot: boolean;
}

export interface CachedChannelInfo {
  id: string;
  name: string;
}

/**
 * Caches Slack API responses (user info, channel info) with 5-minute TTL.
 * Reduces redundant Slack API calls across threads.
 */
export class SlackApiCache {
  private users = new TtlCache<string, CachedUserInfo>(FIVE_MINUTES);
  private channels = new TtlCache<string, CachedChannelInfo>(FIVE_MINUTES);

  getUserInfo(userId: string): CachedUserInfo | undefined {
    return this.users.get(userId);
  }

  setUserInfo(userId: string, info: CachedUserInfo): void {
    this.users.set(userId, info);
  }

  getChannelInfo(channelId: string): CachedChannelInfo | undefined {
    return this.channels.get(channelId);
  }

  setChannelInfo(channelId: string, info: CachedChannelInfo): void {
    this.channels.set(channelId, info);
  }

  prune(): void {
    this.users.prune();
    this.channels.prune();
  }
}
