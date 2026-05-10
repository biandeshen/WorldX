import type { Perception, CharacterProfile } from "../types/index.js";

export interface DecisionCacheKey {
  charId: string;
  location: string;
  timeOfDay: string;
  nearbyCharIds: string[];
  recentEventsHash: string;
}

export interface CachedDecision {
  decision: unknown;
  confidence: number;
  createdAt: number;
  accessCount: number;
  expireAt: number;
}

export class DecisionCache {
  private cache = new Map<string, CachedDecision>();
  private readonly maxSize: number;
  private readonly defaultTTLMs: number;
  private readonly minConfidence: number;

  constructor(
    maxSize: number = 500,
    defaultTTLMs: number = 300000,
    minConfidence: number = 0.7,
  ) {
    this.maxSize = maxSize;
    this.defaultTTLMs = defaultTTLMs;
    this.minConfidence = minConfidence;
  }

  computeKey(params: {
    charId: string;
    location: string;
    tick: number;
    day: number;
    nearbyChars: Array<{ id: string; name: string }>;
    recentEvents: string[];
  }): string {
    const timeOfDay = this.getTimeOfDayFromTick(params.tick);
    const nearbySorted = [...params.nearbyChars].sort((a, b) => a.id.localeCompare(b.id)).map((c) => c.id);
    const eventsHash = this.hashEvents(params.recentEvents.slice(-5));

    return `${params.charId}|${params.location}|${timeOfDay}|${nearbySorted.join(",")}|${eventsHash}`;
  }

  private getTimeOfDayFromTick(tick: number): string {
    const hourInDay = (tick % 96) / 4;
    if (hourInDay >= 6 && hourInDay < 12) return "morning";
    if (hourInDay >= 12 && hourInDay < 14) return "noon";
    if (hourInDay >= 14 && hourInDay < 18) return "afternoon";
    if (hourInDay >= 18 && hourInDay < 22) return "evening";
    return "night";
  }

  private hashEvents(events: string[]): string {
    if (events.length === 0) return "none";
    const combined = events.join("|");
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  get(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expireAt) {
      this.cache.delete(key);
      return undefined;
    }

    if (entry.confidence < this.minConfidence) {
      this.cache.delete(key);
      return undefined;
    }

    entry.accessCount++;
    return entry.decision;
  }

  set(key: string, decision: unknown, confidence: number, ttlMs?: number): void {
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    this.cache.set(key, {
      decision,
      confidence,
      createdAt: Date.now(),
      accessCount: 0,
      expireAt: Date.now() + (ttlMs ?? this.defaultTTLMs),
    });
  }

  invalidate(charId: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${charId}|`)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((k) => this.cache.delete(k));
  }

  invalidateLocation(location: string): void {
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      const parts = key.split("|");
      if (parts[1] === location) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((k) => this.cache.delete(k));
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.cache) {
      if (entry.accessCount < oldestAccess) {
        oldestAccess = entry.accessCount;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  getStats(): { size: number; hitRate: number } {
    let totalAccess = 0;
    for (const entry of this.cache.values()) {
      totalAccess += entry.accessCount;
    }
    return {
      size: this.cache.size,
      hitRate: totalAccess > 0 ? totalAccess / (totalAccess + this.cache.size) : 0,
    };
  }

  clear(): void {
    this.cache.clear();
  }
}

export const globalDecisionCache = new DecisionCache();

export function shouldUseCache(
  charId: string,
  location: string,
  recentEvents: string[],
): boolean {
  const hasSignificantEvents = recentEvents.filter((e) =>
    e.includes("arrived") || e.includes("left") || e.includes("conversation")
  ).length;
  
  return hasSignificantEvents < 2;
}