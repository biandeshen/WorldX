import type { MemoryEntry, MemoryType, GameTime } from "../types/index.js";
import type { LLMClient } from "../llm/llm-client.js";
import * as memoryStore from "../store/memory-store.js";
import { generateId } from "../utils/id-generator.js";
import { absoluteTick } from "../utils/time-helpers.js";

interface RetrievalWeights {
  relevance: number;
  recency: number;
  importance: number;
  emotionalIntensity: number;
}

const DEFAULT_WEIGHTS: RetrievalWeights = {
  relevance: 3,
  recency: 2,
  importance: 2,
  emotionalIntensity: 1,
};

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s,.:;!?，。！？、]+/).filter(Boolean);
}

export class MemoryManager {
  private weights: RetrievalWeights;
  private cache = new Map<string, MemoryEntry[]>();

  constructor(weights?: Partial<RetrievalWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  setLLMClient(_client: LLMClient): void {
    // Embeddings are disabled at runtime, but we keep this hook for compatibility.
  }

  clearCache(): void {
    this.cache.clear();
  }

  addMemory(params: {
    characterId: string;
    type: MemoryType;
    content: string;
    gameTime: GameTime;
    importance: number;
    emotionalValence: number;
    emotionalIntensity: number;
    relatedCharacters?: string[];
    relatedLocation?: string;
    relatedObjects?: string[];
    tags?: string[];
    embedding?: number[];
  }): MemoryEntry {
    const memory: MemoryEntry = {
      id: generateId(),
      characterId: params.characterId,
      type: params.type,
      content: params.content,
      gameDay: params.gameTime.day,
      gameTick: params.gameTime.tick,
      importance: params.importance,
      emotionalValence: params.emotionalValence,
      emotionalIntensity: params.emotionalIntensity,
      relatedCharacters: params.relatedCharacters ?? [],
      relatedLocation: params.relatedLocation ?? "",
      relatedObjects: params.relatedObjects ?? [],
      tags: params.tags ?? [],
      decayFactor: 1.0,
      accessCount: 0,
      isLongTerm: false,
      embedding: params.embedding,
    };

    memoryStore.insertMemory(memory);
    this.cache.delete(params.characterId);
    return memory;
  }

  retrieveMemories(params: {
    characterId: string;
    currentTime: GameTime;
    contextKeywords: string[];
    relatedCharacterIds?: string[];
    relatedLocation?: string;
    topK?: number;
  }): MemoryEntry[] {
    const topK = params.topK ?? 10;
    const allMemories = this.getFromCache(params.characterId);

    if (allMemories.length === 0) return [];

    const currentTotalTicks = absoluteTick(params.currentTime);
    const contextLower = params.contextKeywords.map((k) => k.toLowerCase());

    const scored = allMemories.map((memory) => {
      const score = this.computeScore(
        memory,
        currentTotalTicks,
        contextLower,
        params.relatedCharacterIds,
        params.relatedLocation,
      );

      return { memory, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const results = scored.slice(0, topK).map((s) => s.memory);

    for (const m of results) {
      memoryStore.updateMemory(m.id, { accessCount: m.accessCount + 1 });
    }

    return results;
  }

  processMemoryDecay(characterId: string, currentDay: number): void {
    const memories = memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });

    for (const m of memories) {
      const ageInDays = currentDay - m.gameDay;
      const effectiveStrength =
        m.importance * m.decayFactor + m.accessCount * 0.5;

      if (m.decayFactor < 0.1 && ageInDays > 7) {
        memoryStore.deleteMemory(m.id);
      } else if (m.decayFactor < 0.3 && ageInDays > 3) {
        memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      } else if (effectiveStrength < 3 && ageInDays > 5) {
        memoryStore.updateMemory(m.id, {
          tags: [...m.tags.filter((t) => t !== "faded"), "faded"],
        });
      }
    }

    this.cache.delete(characterId);
  }

  processMemoryConsolidation(characterId: string): void {
    const shortTermMemories = memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: false,
    });

    for (const m of shortTermMemories) {
      if (m.tags.includes("faded")) continue;

      if (m.importance >= 6 || m.accessCount >= 3) {
        memoryStore.updateMemory(m.id, { isLongTerm: true });
      }
    }
  }

  getRecentMemories(characterId: string, limit: number): MemoryEntry[] {
    return memoryStore.getMemoriesByCharacter(characterId, { limit });
  }

  getRecentHearsay(characterId: string, currentDay: number, dayWindow: number = 3): MemoryEntry[] {
    const minDay = Math.max(1, currentDay - dayWindow + 1);
    return memoryStore
      .getMemoriesByCharacter(characterId, { types: ["hearsay"] })
      .filter((m) => m.gameDay >= minDay);
  }

  getMemoriesByDay(characterId: string, gameDay: number): MemoryEntry[] {
    return memoryStore
      .getMemoriesByCharacter(characterId)
      .filter((m) => m.gameDay === gameDay);
  }

  getMemorySummaryForPrompt(
    characterId: string,
    currentTime: GameTime,
    topK?: number,
  ): string {
    const memories = this.retrieveMemories({
      characterId,
      currentTime,
      contextKeywords: [],
      topK: topK ?? 5,
    });

    if (memories.length === 0) return "（暂无相关记忆）";

    return memories
      .map((m) => {
        const prefix = m.isLongTerm ? "【深刻】" : "";
        return `- ${prefix}${m.content}`;
      })
      .join("\n");
  }

  private getFromCache(characterId: string): MemoryEntry[] {
    let cached = this.cache.get(characterId);
    if (!cached) {
      cached = memoryStore.getMemoriesByCharacter(characterId);
      this.cache.set(characterId, cached);
    }
    return cached;
  }

  private computeScore(
    memory: MemoryEntry,
    currentTotalTicks: number,
    contextLower: string[],
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const relevance = this.computeRelevance(
      memory,
      contextLower,
      relatedCharacterIds,
      relatedLocation,
    );

    const memoryTotalTicks = absoluteTick({
      day: memory.gameDay,
      tick: memory.gameTick,
    });
    const deltaTicks = Math.max(0, currentTotalTicks - memoryTotalTicks);
    const recency = 1 / (1 + 0.05 * deltaTicks);

    const importance = memory.importance / 10;
    const emotionalIntensity = memory.emotionalIntensity / 10;

    return (
      this.weights.relevance * relevance +
      this.weights.recency * recency +
      this.weights.importance * importance +
      this.weights.emotionalIntensity * emotionalIntensity
    );
  }

  private computeRelevance(
    memory: MemoryEntry,
    contextLower: string[],
    relatedCharacterIds?: string[],
    relatedLocation?: string,
  ): number {
    const semanticScore =
      contextLower.length > 0 ? this.keywordRelevance(memory, contextLower) : 0;

    let bonus = 0;
    if (
      relatedCharacterIds &&
      memory.relatedCharacters.some((c) => relatedCharacterIds.includes(c))
    ) {
      bonus += 0.3;
    }
    if (relatedLocation && memory.relatedLocation === relatedLocation) {
      bonus += 0.2;
    }

    return Math.min(1, semanticScore + bonus);
  }

  private keywordRelevance(
    memory: MemoryEntry,
    contextLower: string[],
  ): number {
    if (contextLower.length === 0) return 0;

    const memoryTokens = tokenize(
      [
        memory.content,
        ...memory.tags,
        ...memory.relatedCharacters,
        memory.relatedLocation,
      ].join(" "),
    );

    let matchCount = 0;
    for (const keyword of contextLower) {
      if (memoryTokens.some((t) => t.includes(keyword) || keyword.includes(t))) {
        matchCount++;
      }
    }

    return matchCount / contextLower.length;
  }

  compressOldMemories(characterId: string, options: { olderThanDays?: number; maxMemories?: number } = {}): number {
    const olderThanDays = options.olderThanDays ?? 5;
    const maxMemories = options.maxMemories ?? 20;
    const currentDay = Math.floor(Date.now() / 86400000);

    const oldMemories = memoryStore.getMemoriesByCharacter(characterId, {
      isLongTerm: true,
    }).filter((m) => m.gameDay < currentDay - olderThanDays);

    if (oldMemories.length <= maxMemories) return 0;

    const groupedByDay = new Map<number, MemoryEntry[]>();
    for (const m of oldMemories) {
      if (!groupedByDay.has(m.gameDay)) groupedByDay.set(m.gameDay, []);
      groupedByDay.get(m.gameDay)!.push(m);
    }

    let compressedCount = 0;
    for (const [day, dayMemories] of groupedByDay) {
      if (dayMemories.length <= 3) continue;

      const summary: MemoryEntry = {
        id: generateId(),
        characterId,
        type: "experience",
        content: `Day ${day} summary: ${dayMemories.map((m) => m.content).join("; ")}`,
        gameDay: day,
        gameTick: 0,
        importance: 5,
        emotionalValence: 0,
        emotionalIntensity: 1,
        relatedCharacters: [],
        relatedLocation: "",
        relatedObjects: [],
        tags: ["compressed", `originals:${dayMemories.length}`],
        decayFactor: 0.8,
        accessCount: 0,
        isLongTerm: true,
        embedding: undefined,
      };

      for (const m of dayMemories) {
        memoryStore.deleteMemory(m.id);
      }
      memoryStore.insertMemory(summary);
      compressedCount += dayMemories.length;
    }

    this.cache.delete(characterId);
    return compressedCount;
  }

  pruneInactiveMemories(characterId: string, maxMemories: number = 100): number {
    const allMemories = memoryStore.getMemoriesByCharacter(characterId);
    if (allMemories.length <= maxMemories) return 0;

    const sorted = allMemories.sort((a, b) => {
      const scoreA = a.importance * (1 + a.accessCount * 0.1);
      const scoreB = b.importance * (1 + b.accessCount * 0.1);
      return scoreB - scoreA;
    });

    const toDelete = sorted.slice(maxMemories);
    for (const m of toDelete) {
      memoryStore.deleteMemory(m.id);
    }

    this.cache.delete(characterId);
    return toDelete.length;
  }
}
