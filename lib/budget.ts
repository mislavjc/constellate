/**
 * Message budgeting and truncation for AI context management
 * Automatically trims messages to fit within model context limits
 * Prioritizes user messages and preserves important content
 */

import type { ModelMessage } from 'ai';
import { estimateTokens, headTailSlice } from './tokens';
import { loadModelLimits } from './models';
import {
  CONSTELLATE_MAX_CATEGORIES,
  CONSTELLATE_MIN_CAT_SIZE,
  CONSTELLATE_MODEL,
} from './config';

const SYS_OVERHEAD = 300; // safety margin for tool/wrapper overhead
const JSON_OVERHEAD = 300;

// Cache for truncation plans to avoid repeated calculations
const truncationPlanCache = new Map<string, TruncationPlan>();

export type TruncationPlan = {
  maxInput: number;
  maxOutput: number;
  reserveOutput: number;
};

export async function makeTruncationPlan(
  modelId: string,
  reserveOutput = 2048
): Promise<TruncationPlan> {
  // Create cache key from parameters
  const cacheKey = `${modelId}:${reserveOutput}`;

  // Check cache first
  const cached = truncationPlanCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Calculate and cache
  const lim = await loadModelLimits(modelId);
  const maxInput = Math.max(4096, lim.context - reserveOutput - SYS_OVERHEAD);
  const plan = { maxInput, maxOutput: lim.output, reserveOutput };

  truncationPlanCache.set(cacheKey, plan);
  return plan;
}

// Given a messages[] with big user payloads, trim them to fit.
export function fitMessagesWithinBudget(
  messages: ModelMessage[],
  maxInputTokens: number
): { messages: ModelMessage[]; trimmed: boolean } {
  // Count tokens per message; aggressively shrink biggest user content first (optimized)
  const counts = messages.map((m, index) => ({
    i: index,
    role: m.role,
    tokens:
      typeof m.content === 'string'
        ? estimateTokens(m.content)
        : Array.isArray(m.content)
          ? m.content.length * 10 // Rough estimate for array content
          : 0,
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

  const cloned = messages.map(m => ({
    ...m,
    content:
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? '[ARRAY_CONTENT]' // Placeholder for array content
          : String(m.content || ''),
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

// ------------------------- Category Budgeting -------------------------

export type CategoryBudget = {
  min: number;
  max: number;
  maxNew: number;
  splitThreshold: number;
};

// Heuristic: aim for O(sqrt(N)) to O(N^0.6) categories depending on spread
export function computeCategoryBudget(repoCount: number): CategoryBudget {
  const n = Math.max(1, repoCount);
  const sqrt = Math.ceil(Math.sqrt(n));
  const softMax = Math.ceil(Math.pow(n, 0.6));

  // Respect configured caps but keep sensible lower/upper bounds
  const configuredMax = Math.max(8, Math.min(160, CONSTELLATE_MAX_CATEGORIES));
  const min = Math.max(2, Math.min(CONSTELLATE_MIN_CAT_SIZE, Math.floor(sqrt)));
  const max = Math.min(configuredMax, Math.max(sqrt * 2, softMax));
  const maxNew = Math.max(16, Math.min(120, Math.floor(max * 2)));
  const splitThreshold = Math.max(6, Math.min(12, Math.floor(sqrt + 4)));

  return { min, max, maxNew, splitThreshold };
}

// ----------------------- Per-Repo Context Budget ----------------------

export async function computeReadmeTokenBudget(args: {
  repoCountInBatch: number;
  modelId?: string;
  reserveOutput?: number;
  payloadOverheadTokens?: number; // approximate tokens for non-README fields per repo
}): Promise<number> {
  const modelId = args.modelId || CONSTELLATE_MODEL;
  const reserveOutput = Math.max(256, args.reserveOutput ?? 2048);
  const payloadOverhead = Math.max(64, args.payloadOverheadTokens ?? 256);

  const lim = await loadModelLimits(modelId);
  // Leave headroom for system prompt and JSON overhead
  const usableInput = Math.max(
    4096,
    lim.context - reserveOutput - SYS_OVERHEAD
  );

  // Allocate ~70% of usable input to README text across the batch, 30% to metadata
  const readmePool = Math.floor(usableInput * 0.7);

  const perRepoReadme = Math.max(
    256,
    Math.floor(
      (readmePool - args.repoCountInBatch * payloadOverhead) /
        Math.max(1, args.repoCountInBatch)
    )
  );

  // Final per-repo budget is the readme allowance; headTailSlice uses token approximation
  return Math.max(
    256,
    Math.min(perRepoReadme, Math.floor(usableInput / args.repoCountInBatch))
  );
}

// Convenience to compute consistent policies for downstream passes
export function getConfiguredPolicies(repoCount: number) {
  const budget = computeCategoryBudget(repoCount);
  return {
    minCategorySize: budget.min,
    maxCategories: budget.max,
    max_new_categories: budget.maxNew,
    splitThreshold: budget.splitThreshold,
  };
}
