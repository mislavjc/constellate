/**
 * Safe streaming wrapper for AI calls with context overflow handling
 * Automatically retries on context limit errors with progressive truncation
 * Provides bulletproof context management for all Constellate passes
 */

import { streamObject } from 'ai';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { makeTruncationPlan, fitMessagesWithinBudget } from './budget';

type StreamArgs<T extends z.ZodType<any, any, any>> = {
  model: any;
  modelId: string;
  schema: T;
  messages: ModelMessage[];
  maxRetries?: number;
  reserveOutput?: number;
};

export async function safeStreamObject<T extends z.ZodType<any, any, any>>({
  model,
  modelId,
  schema,
  messages,
  maxRetries = 2,
  reserveOutput = 2048,
}: StreamArgs<T>) {
  let attempt = 0;
  let currentMessages = messages;

  while (true) {
    attempt++;
    const plan = await makeTruncationPlan(modelId, reserveOutput);
    const fitted = fitMessagesWithinBudget(currentMessages, plan.maxInput);

    try {
      const res = streamObject({
        model,
        schema,
        messages: fitted.messages,
        maxTokens: plan.reserveOutput,
      });
      return res; // caller consumes the stream
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isCtx =
        /context window|context_length|length_exceeded|too large|maximum context|token limit/i.test(
          msg
        );

      if (!isCtx || attempt > maxRetries) throw err;

      console.warn(`Context overflow attempt ${attempt}/${maxRetries}: ${msg}`);

      // Retry strategy: if we already trimmed, try even harder truncation
      if (fitted.trimmed) {
        // Hard-trim: remove README fields from user messages to reduce payload
        currentMessages = fitted.messages.map(
          (m: ModelMessage): ModelMessage => {
            if (m.role !== 'user' || typeof m.content !== 'string') return m;
            return {
              ...m,
              content: m.content.replace(
                /"readme":"[\s\S]*?"/g,
                '"readme":"[TRUNCATED]"'
              ),
            } as ModelMessage;
          }
        );
      } else {
        // First overflow: apply aggressive truncation
        const hardTrimmed = fitMessagesWithinBudget(
          fitted.messages.map(
            (m: ModelMessage): ModelMessage =>
              ({
                ...m,
                content:
                  typeof m.content === 'string'
                    ? m.content.slice(0, Math.floor(m.content.length * 0.5))
                    : JSON.stringify(m.content || ''),
              } as ModelMessage)
          ),
          Math.floor(plan.maxInput * 0.6)
        );
        currentMessages = hardTrimmed.messages;
      }
    }
  }
}
