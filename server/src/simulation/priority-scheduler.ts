export interface CharacterPriority {
  characterId: string;
  priority: number;
  lastActiveTick: number;
  interactionCount: number;
}

export class PriorityScheduler {
  private priorities = new Map<string, CharacterPriority>();

  updatePriority(characterId: string, tick: number, activityDelta: number = 0): void {
    let p = this.priorities.get(characterId);
    if (!p) {
      p = { characterId, priority: 0, lastActiveTick: 0, interactionCount: 0 };
      this.priorities.set(characterId, p);
    }

    p.lastActiveTick = tick;
    p.interactionCount += activityDelta;
    p.priority = this.computePriority(p, tick);
  }

  private computePriority(p: CharacterPriority, currentTick: number): number {
    const tickDelta = currentTick - p.lastActiveTick;
    const activityScore = Math.min(p.interactionCount * 0.5, 10);
    const recencyScore = Math.max(0, 10 - tickDelta * 0.1);
    return activityScore + recencyScore;
  }

  getOrderedCharacters(currentTick: number): string[] {
    return Array.from(this.priorities.values())
      .map((p) => ({
        ...p,
        currentPriority: this.computePriority(p, currentTick),
      }))
      .sort((a, b) => b.currentPriority - a.currentPriority)
      .map((p) => p.characterId);
  }

  getTopPriority(count: number, currentTick: number): string[] {
    return this.getOrderedCharacters(currentTick).slice(0, count);
  }

  getDelayForCharacter(characterId: string, currentTick: number, baseDelay: number = 0): number {
    const p = this.priorities.get(characterId);
    if (!p) return baseDelay;

    const priority = this.computePriority(p, currentTick);
    if (priority > 5) return 0;

    return Math.max(0, baseDelay * (1 - priority / 10));
  }

  recordActivity(characterId: string, tick: number): void {
    this.updatePriority(characterId, tick, 1);
  }

  clear(): void {
    this.priorities.clear();
  }
}

export const globalPriorityScheduler = new PriorityScheduler();

export function scheduleWithPriority<T>(
  items: Array<{ id: string; priority: number }>,
  executor: (id: string) => Promise<T>,
  options: { maxConcurrent?: number; baseDelay?: number } = {},
): Promise<Map<string, T | Error>> {
  const maxConcurrent = options.maxConcurrent ?? 10;
  const sorted = [...items].sort((a, b) => b.priority - a.priority);

  const results = new Map<string, T | Error>();
  let index = 0;

  const executeBatch = async (): Promise<void> => {
    const batch = sorted.slice(index, index + maxConcurrent);
    index += batch.length;

    await Promise.all(
      batch.map(async (item) => {
        if (options.baseDelay && item.priority < 5) {
          await new Promise((r) => setTimeout(r, options.baseDelay! * (1 - item.priority / 10)));
        }
        try {
          results.set(item.id, await executor(item.id));
        } catch (err) {
          results.set(item.id, err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );
  };

  return (async () => {
    while (index < sorted.length) {
      await executeBatch();
    }
    return results;
  })();
}