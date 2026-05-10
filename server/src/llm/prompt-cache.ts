export interface CacheEntry<T> {
  data: T;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
}

export class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize: number = 100, ttlMs: number = 3600000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    entry.lastAccessedAt = Date.now();
    entry.accessCount++;
    return entry.data;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.data = value;
      entry.lastAccessedAt = Date.now();
      return;
    }

    if (this.cache.size >= this.maxSize) {
      let oldestKey: K | null = null;
      let oldestTime = Infinity;
      for (const [k, entry] of this.cache) {
        if (entry.lastAccessedAt < oldestTime) {
          oldestTime = entry.lastAccessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, {
      data: value,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    });
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  delete(key: K): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export class PromptCache {
  private worldSchemaCache = new LRUCache<string, string>(10, 3600000);
  private characterProfileCache = new LRUCache<string, string>(50, 7200000);
  private actionMenuCache = new LRUCache<string, string>(100, 300000);

  cacheWorldSchema(worldId: string, schema: string): void {
    this.worldSchemaCache.set(`world:${worldId}`, schema);
  }

  getWorldSchema(worldId: string): string | undefined {
    return this.worldSchemaCache.get(`world:${worldId}`);
  }

  cacheCharacterProfile(charId: string, profile: string): void {
    this.characterProfileCache.set(`profile:${charId}`, profile);
  }

  getCharacterProfile(charId: string): string | undefined {
    return this.characterProfileCache.get(`profile:${charId}`);
  }

  cacheActionMenu(charId: string, location: string, menu: string): void {
    this.actionMenuCache.set(`menu:${charId}:${location}`, menu);
  }

  getActionMenu(charId: string, location: string): string | undefined {
    return this.actionMenuCache.get(`menu:${charId}:${location}`);
  }

  invalidateCharacter(charId: string): void {
    this.characterProfileCache.delete(`profile:${charId}`);
  }

  clear(): void {
    this.worldSchemaCache.clear();
    this.characterProfileCache.clear();
    this.actionMenuCache.clear();
  }
}

export const globalPromptCache = new PromptCache();

export function computeCacheKey(parts: string[]): string {
  return parts.join("|");
}