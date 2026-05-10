export interface RateLimiterConfig {
  maxConcurrent: number;
  requestsPerSecond: number;
  tokensPerSecond: number;
  maxRetries: number;
  baseDelayMs: number;
}

export interface RateLimitState {
  activeRequests: number;
  lastRequestTime: number;
  tokensUsed: number;
  lastTokenRefill: number;
}

export interface AdaptiveConfig {
  minConcurrency: number;
  maxConcurrencyIncrease: number;
  decreaseFactor: number;
  increaseFactor: number;
  stabilityThreshold: number;
}

export class TokenBucketRateLimiter {
  private state: RateLimitState;
  private readonly config: Required<RateLimiterConfig>;
  private adaptiveConfig: AdaptiveConfig;
  private currentConcurrency: number;
  private consecutiveSuccesses: number = 0;
  private consecutiveFailures: number = 0;

  constructor(
    config: RateLimiterConfig,
    adaptive?: Partial<AdaptiveConfig>,
  ) {
    this.config = {
      maxRetries: config.maxRetries,
      baseDelayMs: config.baseDelayMs,
      maxConcurrent: config.maxConcurrent,
      requestsPerSecond: config.requestsPerSecond,
      tokensPerSecond: config.tokensPerSecond,
    };
    this.adaptiveConfig = {
      minConcurrency: adaptive?.minConcurrency ?? 2,
      maxConcurrencyIncrease: adaptive?.maxConcurrencyIncrease ?? 5,
      decreaseFactor: adaptive?.decreaseFactor ?? 0.5,
      increaseFactor: adaptive?.increaseFactor ?? 1.2,
      stabilityThreshold: adaptive?.stabilityThreshold ?? 3,
    };
    this.currentConcurrency = this.config.maxConcurrent;
    this.state = {
      activeRequests: 0,
      lastRequestTime: 0,
      tokensUsed: 0,
      lastTokenRefill: Date.now(),
    };
  }

  updateFromRateLimitHeaders(headers: Record<string, string>): void {
    const remaining = parseInt(headers["x-ratelimit-remaining"] ?? headers["x-ratelimit-requests-remaining"] ?? "", 10);
    const limit = parseInt(headers["x-ratelimit-limit"] ?? headers["x-ratelimit-requests-limit"] ?? "", 10);
    
    if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit === 0) return;

    const usageRatio = remaining / limit;
    
    if (usageRatio < 0.1) {
      this.decreaseConcurrency();
    } else if (usageRatio > 0.8 && this.consecutiveSuccesses >= this.adaptiveConfig.stabilityThreshold) {
      this.increaseConcurrency();
    }
  }

  recordSuccess(): void {
    this.consecutiveSuccesses++;
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    if (this.consecutiveFailures >= 2) {
      this.decreaseConcurrency();
    }
  }

  private decreaseConcurrency(): void {
    this.currentConcurrency = Math.max(
      this.adaptiveConfig.minConcurrency,
      Math.floor(this.currentConcurrency * this.adaptiveConfig.decreaseFactor),
    );
    this.consecutiveSuccesses = 0;
    this.consecutiveFailures = 0;
  }

  private increaseConcurrency(): void {
    const newConcurrency = Math.min(
      this.config.maxConcurrent + this.adaptiveConfig.maxConcurrencyIncrease,
      Math.ceil(this.currentConcurrency * this.adaptiveConfig.increaseFactor),
    );
    this.currentConcurrency = newConcurrency;
    this.consecutiveSuccesses = 0;
  }

  getEffectiveConcurrency(): number {
    return Math.min(this.currentConcurrency, this.config.maxConcurrent);
  }

  async acquire(tokensNeeded: number = 1): Promise<void> {
    const effectiveLimit = Math.min(this.currentConcurrency, this.config.maxConcurrent);

    while (true) {
      this.refillTokens();

      if (this.state.activeRequests >= effectiveLimit) {
        await this.sleep(50);
        continue;
      }

      const minInterval = 1000 / this.config.requestsPerSecond;
      const timeSinceLastRequest = Date.now() - this.state.lastRequestTime;
      if (timeSinceLastRequest < minInterval) {
        await this.sleep(minInterval - timeSinceLastRequest);
        continue;
      }

      if (this.state.tokensUsed + tokensNeeded > this.config.tokensPerSecond) {
        await this.sleep(100);
        continue;
      }

      break;
    }

    this.state.activeRequests++;
    this.state.lastRequestTime = Date.now();
    this.state.tokensUsed += tokensNeeded;
  }

  release(tokensUsed: number = 1): void {
    this.state.activeRequests = Math.max(0, this.state.activeRequests - 1);
    this.state.tokensUsed = Math.max(0, this.state.tokensUsed - tokensUsed);
  }

  getActiveCount(): number {
    return this.state.activeRequests;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastTokenRefill;
    const refillAmount = (elapsed / 1000) * this.config.tokensPerSecond;
    this.state.tokensUsed = Math.max(0, this.state.tokensUsed - refillAmount);
    this.state.lastTokenRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async executeWithRetry<T>(
    fn: () => Promise<T>,
    options: { tokens?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const tokensNeeded = options.tokens ?? 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.acquire(tokensNeeded);
        try {
          return await this.withTimeout(fn(), options.timeoutMs);
        } finally {
          this.release(tokensNeeded);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        
        if (this.isRateLimitError(lastError)) {
          const delay = this.config.baseDelayMs * Math.pow(2, attempt);
          const jitter = delay * 0.3 * Math.random();
          await this.sleep(delay + jitter);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Operation failed after retries");
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs) return promise;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Operation timed out"));
      }, timeoutMs);
      
      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private isRateLimitError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes("429") ||
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("rate_limit")
    );
  }
}

export function createRateLimiterFromEnv(): TokenBucketRateLimiter {
  const config: RateLimiterConfig = {
    maxConcurrent: parseInt(process.env.SIMULATION_MAX_CONCURRENT ?? "10", 10),
    requestsPerSecond: parseInt(process.env.SIMULATION_RPS ?? "20", 10),
    tokensPerSecond: parseInt(process.env.SIMULATION_TPS ?? "100000", 10),
    maxRetries: parseInt(process.env.SIMULATION_RATE_LIMIT_RETRIES ?? "3", 10),
    baseDelayMs: parseInt(process.env.SIMULATION_RATE_LIMIT_BASE_DELAY ?? "1000", 10),
  };

  return new TokenBucketRateLimiter(config);
}

export const globalRateLimiter = createRateLimiterFromEnv();