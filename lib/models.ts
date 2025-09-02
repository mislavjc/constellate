/**
 * Model limits and context management for Nebula pipeline
 * Fetches model specifications from models.dev API with caching
 * Provides dynamic context/output limits for safe AI processing
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import {
  MODELS_DEV_URL,
  NEBULA_DEFAULT_CONTEXT,
  NEBULA_DEFAULT_OUTPUT,
  NEBULA_MODEL,
  NEBULA_FALLBACK_MODELS,
} from './config';

const CACHE_PATH = '.nebula/models-dev-cache.json';

// Cache model limits to avoid repeated file/network operations
let modelLimitsCache: Record<string, ModelLimits> | null = null;
let cacheLoadPromise: Promise<void> | null = null;

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

// Load model limits cache (once per session)
async function ensureCacheLoaded(): Promise<void> {
  if (modelLimitsCache) return; // Already loaded
  if (cacheLoadPromise) return cacheLoadPromise; // Already loading

  cacheLoadPromise = (async () => {
    try {
      // Try to load from disk cache first
      const cacheData = await fs.readFile(CACHE_PATH, 'utf-8');
      const parsed = ModelsDev.parse(JSON.parse(cacheData));

      // Convert models.dev format to our internal cache format
      modelLimitsCache = {};
      const providers = Object.values(parsed) as any[];
      for (const prov of providers) {
        if (prov.models) {
          for (const [modelId, modelData] of Object.entries(prov.models)) {
            const lim = (modelData as any).limit || {};
            modelLimitsCache[modelId] = {
              context: lim.context ?? NEBULA_DEFAULT_CONTEXT,
              output: lim.output ?? NEBULA_DEFAULT_OUTPUT,
            };
          }
        }
      }
    } catch {
      // Cache doesn't exist or is invalid, fetch from API
      try {
        const res = await fetch(MODELS_DEV_URL);
        const json = await res.json();
        const parsed = ModelsDev.parse(json);

        // Convert and cache
        modelLimitsCache = {};
        const providers = Object.values(parsed) as any[];
        for (const prov of providers) {
          if (prov.models) {
            for (const [modelId, modelData] of Object.entries(prov.models)) {
              const lim = (modelData as any).limit || {};
              modelLimitsCache[modelId] = {
                context: lim.context ?? NEBULA_DEFAULT_CONTEXT,
                output: lim.output ?? NEBULA_DEFAULT_OUTPUT,
              };
            }
          }
        }

        // Save to disk cache
        await fs.mkdir('.nebula', { recursive: true });
        await fs.writeFile(CACHE_PATH, JSON.stringify(parsed, null, 2));
      } catch (error) {
        console.warn('Failed to load model limits from API:', error);
        // Use minimal fallback cache
        modelLimitsCache = {
          [NEBULA_MODEL]: {
            context: NEBULA_DEFAULT_CONTEXT,
            output: NEBULA_DEFAULT_OUTPUT,
          },
        };
      }
    }
  })();

  await cacheLoadPromise;
}

export async function loadModelLimits(modelId: string): Promise<ModelLimits> {
  await ensureCacheLoaded();

  // Return cached limits or fallback
  return (
    modelLimitsCache![modelId] ?? {
      context: NEBULA_DEFAULT_CONTEXT,
      output: NEBULA_DEFAULT_OUTPUT,
    }
  );
}

export async function pickModelFor(
  messagesTokens: number
): Promise<{ id: string }> {
  const candidates = [NEBULA_MODEL, ...NEBULA_FALLBACK_MODELS];
  for (const id of candidates) {
    try {
      const { context } = await loadModelLimits(id);
      if (messagesTokens < context * 0.85) return { id };
    } catch (e) {
      // Continue to next candidate if this one fails
      console.warn(`Failed to load limits for ${id}:`, e);
    }
  }
  return { id: NEBULA_MODEL }; // last resort
}
