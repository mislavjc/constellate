/**
 * Message budgeting and truncation for AI context management
 * Automatically trims messages to fit within model context limits
 * Prioritizes user messages and preserves important content
 */

import type { ModelMessage } from 'ai';
import { estimateTokens, headTailSlice } from './tokens';
import { loadModelLimits } from './models';

const SYS_OVERHEAD = 300; // safety margin for tool/wrapper overhead
const JSON_OVERHEAD = 300;

export type TruncationPlan = {
  maxInput: number;
  maxOutput: number;
  reserveOutput: number;
};

export async function makeTruncationPlan(
  modelId: string,
  reserveOutput = 2048
): Promise<TruncationPlan> {
  const lim = await loadModelLimits(modelId);
  const maxInput = Math.max(4096, lim.context - reserveOutput - SYS_OVERHEAD);
  return { maxInput, maxOutput: lim.output, reserveOutput };
}

// Given a messages[] with big user payloads, trim them to fit.
export function fitMessagesWithinBudget(
  messages: ModelMessage[],
  maxInputTokens: number
): { messages: ModelMessage[]; trimmed: boolean } {
  // Count tokens per message; aggressively shrink biggest user content first
  const counts = messages.map((m, index) => ({
    i: index,
    role: m.role,
    tokens: estimateTokens(
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content || '')
    ),
  }));

  let total = counts.reduce((a, x) => a + x.tokens, 0) + JSON_OVERHEAD;
  if (total <= maxInputTokens) return { messages, trimmed: false };

  // Sort candidates to trim: user > system > developer; trim user contents first
  const order = messages
    .map((m, i) => ({ i, role: m.role, tokens: counts[i]?.tokens || 0 }))
    .sort((a, b) => {
      const prio = (r: string) => (r === 'user' ? 0 : r === 'system' ? 1 : 2);
      return prio(a.role) - prio(b.role) || (b.tokens || 0) - (a.tokens || 0);
    });

  const cloned = messages.map((m) => ({
    ...m,
    content:
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content || ''),
  }));
  let trimmed = false;

  for (const { i } of order) {
    if (total <= maxInputTokens || !cloned[i]) break;
    const m = cloned[i];
    if (!m || typeof m.content !== 'string') continue;

    // shrink this message progressively
    const currentTokens = counts[i]?.tokens || 0;
    const available = maxInputTokens - (total - currentTokens);
    const target = Math.max(512, Math.floor(available * 0.6)); // leave room for others
    const shortened = headTailSlice(m.content, target);

    if (shortened !== m.content) {
      m.content = shortened;
      trimmed = true;
      const newTokens = estimateTokens(shortened);
      total = total - currentTokens + newTokens;
      if (counts[i]) {
        counts[i].tokens = newTokens;
      }
    }
  }

  return { messages: cloned as ModelMessage[], trimmed };
}
