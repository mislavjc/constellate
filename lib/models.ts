/**
 * Model limits and context management for Nebula pipeline
 * Fetches model specifications from models.dev API with caching
 * Provides dynamic context/output limits for safe AI processing
 */

import { z } from 'zod';
import {
  MODELS_DEV_URL,
  NEBULA_DEFAULT_CONTEXT,
  NEBULA_DEFAULT_OUTPUT,
} from './config';

const CACHE_PATH = 'data/models-dev-cache.json';

const ModelsDev = z.record(
  z.string(),
  z.object({
    id: z.string(),
    models: z
      .record(
        z.string(),
        z.object({
          id: z.string(),
          limit: z
            .object({
              context: z.number().optional(),
              output: z.number().optional(),
            })
            .optional(),
          name: z.string().optional(),
        })
      )
      .default({}),
  })
);

export type ModelLimits = { context: number; output: number };

export async function loadModelLimits(modelId: string): Promise<ModelLimits> {
  // Try cache first
  let cache: any = null;
  try {
    const fs = await import('fs/promises');
    cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf-8'));
  } catch {}

  if (!cache) {
    const res = await fetch(MODELS_DEV_URL);
    const json = await res.json();
    const parsed = ModelsDev.parse(json);
    cache = parsed;
    const fs = await import('fs/promises');
    await fs.mkdir('data', { recursive: true });
    await fs.writeFile(CACHE_PATH, JSON.stringify(parsed, null, 2));
  }

  // models.dev keys are providers; each has .models keyed by model id
  // We try exact match first, then scan all providers to find modelId.
  const providers = Object.values(cache) as any[];
  for (const prov of providers) {
    if (prov.models && prov.models[modelId]) {
      const lim = prov.models[modelId].limit || {};
      return {
        context: lim.context ?? NEBULA_DEFAULT_CONTEXT,
        output: lim.output ?? NEBULA_DEFAULT_OUTPUT,
      };
    }
  }

  // Fallback if unknown
  return {
    context: NEBULA_DEFAULT_CONTEXT,
    output: NEBULA_DEFAULT_OUTPUT,
  };
}

export async function pickModelFor(
  messagesTokens: number
): Promise<{ id: string }> {
  const pref = process.env.NEBULA_MODEL || 'gpt-5-mini';
  const alts = (
    process.env.NEBULA_FALLBACK_MODELS || 'deepseek-chat,grok-3-mini-latest'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const candidates = [pref, ...alts];
  for (const id of candidates) {
    try {
      const { context } = await loadModelLimits(id);
      if (messagesTokens < context * 0.85) return { id };
    } catch (e) {
      // Continue to next candidate if this one fails
      console.warn(`Failed to load limits for ${id}:`, e);
    }
  }
  return { id: pref }; // last resort
}
