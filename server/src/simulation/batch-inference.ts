import type { GameTime } from "../types/index.js";

export interface BatchDecisionRequest {
  characterId: string;
  perception: unknown;
  actionMenu: string;
  relevantMemories: string;
}

export interface BatchDecisionResponse {
  characterId: string;
  decision: unknown;
  confidence: number;
}

export interface BatchDecisionResult {
  success: boolean;
  decisions: Map<string, unknown>;
  errors: Map<string, Error>;
  totalTimeMs: number;
}

export class BatchInference {
  private batchSize: number;
  private maxConcurrentBatches: number;

  constructor(batchSize: number = 4, maxConcurrentBatches: number = 3) {
    this.batchSize = batchSize;
    this.maxConcurrentBatches = maxConcurrentBatches;
  }

  async executeBatchRequests(
    requests: BatchDecisionRequest[],
    executor: (request: BatchDecisionRequest) => Promise<BatchDecisionResponse>,
  ): Promise<BatchDecisionResult> {
    const startTime = Date.now();
    const decisions = new Map<string, unknown>();
    const errors = new Map<string, Error>();

    const batches: BatchDecisionRequest[][] = [];
    for (let i = 0; i < requests.length; i += this.batchSize) {
      batches.push(requests.slice(i, i + this.batchSize));
    }

    let batchIndex = 0;
    const maxConcurrency = Math.min(this.maxConcurrentBatches, Math.ceil(batches.length / 2));

    const executeBatchesConcurrently = async (): Promise<void> => {
      const pendingBatches = batches.slice(batchIndex, batchIndex + maxConcurrency);
      batchIndex += maxConcurrency;

      await Promise.all(
        pendingBatches.map(async (batch) => {
          await Promise.all(
            batch.map(async (req) => {
              try {
                const result = await executor(req);
                decisions.set(req.characterId, result.decision);
              } catch (err) {
                errors.set(req.characterId, err instanceof Error ? err : new Error(String(err)));
              }
            }),
          );
        }),
      );
    };

    while (batchIndex < batches.length) {
      await executeBatchesConcurrently();
    }

    return {
      success: errors.size === 0,
      decisions,
      errors,
      totalTimeMs: Date.now() - startTime,
    };
  }

  estimateSavings(requestCount: number): { original: number; batched: number; savingsPercent: number } {
    const original = requestCount * 1000;
    const batches = Math.ceil(requestCount / this.batchSize);
    const batched = batches * 1000 + (requestCount * 100);
    const savingsPercent = ((original - batched) / original) * 100;

    return { original, batched, savingsPercent };
  }
}

export const globalBatchInference = new BatchInference(4, 3);

export function createBatchFromDecisions(
  eligibleChars: string[],
  contextMap: Map<string, { perception: unknown; actionMenu: string; memories: string }>,
): BatchDecisionRequest[] {
  return eligibleChars.map((charId) => {
    const ctx = contextMap.get(charId);
    return {
      characterId: charId,
      perception: ctx?.perception ?? {},
      actionMenu: ctx?.actionMenu ?? "",
      relevantMemories: ctx?.memories ?? "",
    };
  });
}