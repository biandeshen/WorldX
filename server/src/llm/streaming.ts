import type { Message } from "./prompt-builder.js";

export interface StreamChunk {
  text: string;
  delta: string;
  done: boolean;
}

export type StreamCallback = (chunk: StreamChunk) => void;

export async function* streamChatCompletion(
  baseURL: string,
  apiKey: string,
  model: string,
  messages: Message[],
  options?: {
    temperature?: number;
    onChunk?: StreamCallback;
    signal?: AbortSignal;
  },
): AsyncGenerator<StreamChunk> {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      temperature: options?.temperature,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`LLM streaming error ${response.status}: ${errBody}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          yield { text: "", delta: "", done: true };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content ?? "";
          if (content) {
            const chunk: StreamChunk = { text: content, delta: content, done: false };
            if (options?.onChunk) {
              options.onChunk(chunk);
            }
            yield chunk;
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collectStream(
  generator: AsyncGenerator<StreamChunk>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of generator) {
    if (chunk.text) {
      chunks.push(chunk.text);
    }
  }
  return chunks.join("");
}