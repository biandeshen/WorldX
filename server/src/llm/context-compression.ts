export interface CompressionOptions {
  maxTranscriptLength: number;
  maxPerceptionChars: number;
  maxMemoriesRetrieved: number;
}

const DEFAULT_OPTIONS: CompressionOptions = {
  maxTranscriptLength: 10,
  maxPerceptionChars: 500,
  maxMemoriesRetrieved: 5,
};

export interface TranscriptEntry {
  speaker: string;
  content: string;
  innerMonologue?: string;
}

export function compressTranscript(
  transcript: TranscriptEntry[],
  options: Partial<CompressionOptions> = {},
): { entries: TranscriptEntry[]; wasCompressed: boolean; summary?: string } {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (transcript.length <= opts.maxTranscriptLength) {
    return { entries: transcript, wasCompressed: false };
  }

  const recentEntries = transcript.slice(-opts.maxTranscriptLength);
  const olderEntries = transcript.slice(0, -opts.maxTranscriptLength);

  const summary = summarizeTranscript(olderEntries);

  return {
    entries: recentEntries,
    wasCompressed: true,
    summary,
  };
}

function summarizeTranscript(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "";

  const speakers = new Map<string, string[]>();
  for (const entry of entries) {
    if (!speakers.has(entry.speaker)) {
      speakers.set(entry.speaker, []);
    }
    speakers.get(entry.speaker)!.push(entry.content);
  }

  const parts: string[] = [];
  for (const [speaker, contents] of speakers) {
    const firstContent = contents[0];
    const lastContent = contents[contents.length - 1];
    const count = contents.length;

    if (count === 1) {
      parts.push(`${speaker}: "${truncate(firstContent, 30)}"`);
    } else {
      parts.push(`${speaker}(x${count}): "${truncate(firstContent, 20)}"..."${truncate(lastContent, 20)}"`);
    }
  }

  return `[Earlier ${entries.length} exchanges: ${parts.join("; ")}]`;
}

export function compressPerception(
  perception: { charactersHere: Array<{ name: string; appearanceHint?: string; currentAction?: string }> },
  maxChars: number = 500,
): string {
  const chars = perception.charactersHere;

  if (chars.length === 0) return "";

  const parts: string[] = [];
  let totalLen = 0;

  for (const char of chars) {
    const entry = `${char.name}${char.currentAction ? `(${char.currentAction})` : ""}`;
    if (totalLen + entry.length + 2 > maxChars) {
      parts.push(`...(${chars.length - parts.length} more)`);
      break;
    }
    parts.push(entry);
    totalLen += entry.length + 2;
  }

  return parts.join(", ");
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export function estimateContextTokens(text: string | number): number {
  const len = typeof text === "string" ? text.length : text;
  return Math.ceil(len / 4);
}

export function shouldCompressContext(
  messages: Array<{ role: string; content: string }>,
  threshold: number = 8000,
): boolean {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return estimateContextTokens(totalChars) > threshold;
}

export class ContextBudget {
  private usedTokens: number = 0;
  private history: Array<{ tokens: number; timestamp: number }> = [];
  private readonly windowMs: number;
  private readonly maxTokensPerWindow: number;

  constructor(windowMs: number = 60000, maxTokensPerWindow: number = 100000) {
    this.windowMs = windowMs;
    this.maxTokensPerWindow = maxTokensPerWindow;
  }

  reserve(tokens: number): boolean {
    this.cleanup();
    const projectedUsage = this.usedTokens + tokens;
    if (projectedUsage > this.maxTokensPerWindow) {
      return false;
    }
    this.usedTokens = projectedUsage;
    this.history.push({ tokens, timestamp: Date.now() });
    return true;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    let released = 0;
    while (this.history.length > 0 && this.history[0].timestamp < cutoff) {
      released += this.history.shift()!.tokens;
    }
    this.usedTokens = Math.max(0, this.usedTokens - released);
  }

  getCurrentUsage(): { used: number; max: number; ratio: number } {
    this.cleanup();
    return {
      used: this.usedTokens,
      max: this.maxTokensPerWindow,
      ratio: this.usedTokens / this.maxTokensPerWindow,
    };
  }
}