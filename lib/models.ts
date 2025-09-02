/**
 * Model limits and context management for Nebula pipeline
 * Uses AI gateway to get model information and limits
 */

import { gateway } from '@ai-sdk/gateway';
import {
  NEBULA_DEFAULT_CONTEXT,
  NEBULA_DEFAULT_OUTPUT,
  NEBULA_MODEL,
  NEBULA_FALLBACK_MODELS,
} from './config';

export type ModelLimits = { context: number; output: number };

// Cache for model information from gateway
let gatewayModelsCache: any[] | null = null;
let cachePromise: Promise<void> | null = null;

async function ensureGatewayModelsLoaded(): Promise<void> {
  if (gatewayModelsCache) return;
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    try {
      const result = await gateway.getAvailableModels();
      gatewayModelsCache = result.models.filter(
        (m: any) => m.modelType === 'language'
      );
    } catch (error) {
      console.warn('Failed to load models from gateway:', error);
      gatewayModelsCache = [];
    }
  })();

  await cachePromise;
}

export async function loadModelLimits(modelId: string): Promise<ModelLimits> {
  await ensureGatewayModelsLoaded();

  const model = gatewayModelsCache?.find((m: any) => m.id === modelId);
  if (model) {
    // Try to extract context limits from model info
    let context = NEBULA_DEFAULT_CONTEXT;
    let output = NEBULA_DEFAULT_OUTPUT;

    // Try to extract from model description or metadata
    if (model.description) {
      // Look for context window mentions in description
      const contextMatch = model.description.match(
        /(\d+)k?\s*(?:token|context)/i
      );
      if (contextMatch) {
        const numStr = contextMatch[1];
        const num = parseInt(numStr);
        if (numStr.includes('k') || num > 1000) {
          context = num * (numStr.includes('k') ? 1000 : 1);
        }
      }
    }

    // Try to extract from pricing info (rough estimation)
    if (model.pricing?.input) {
      // Higher priced models often have larger context windows
      const inputPrice = model.pricing.input;
      if (inputPrice > 0.01) {
        context = 128000; // Assume large context for expensive models
      } else if (inputPrice > 0.001) {
        context = 32000; // Medium context
      }
    }

    return { context, output };
  }

  // Fallback for unknown models
  return {
    context: NEBULA_DEFAULT_CONTEXT,
    output: NEBULA_DEFAULT_OUTPUT,
  };
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

export async function getAvailableModels(): Promise<any[]> {
  await ensureGatewayModelsLoaded();
  return gatewayModelsCache || [];
}
