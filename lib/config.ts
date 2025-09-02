import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const TOKEN_PATH = path.join(os.homedir(), '.constellator.json');
const CONFIG_FILE_PATH = '.constellator/config.json';

// Load saved configuration
function loadSavedConfig(): Record<string, any> {
  try {
    const configData = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(configData);
    // Validate that it's an object
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

const savedConfig = loadSavedConfig();

// Configuration from saved file only (no env fallbacks)
export const GITHUB_TOKEN = (() => {
  const token = String(savedConfig.GITHUB_TOKEN || '');
  return token.trim();
})();

// User-configurable settings
export const MAX_REPOS_TO_PROCESS = (() => {
  const value = parseInt(String(savedConfig.CONSTELLATE_MAX_REPOS || '100'));
  return isNaN(value) ? 10 : Math.max(1, Math.min(1000, value)); // Clamp between 1-1000
})();

// Model configuration - user-manageable
export const CONSTELLATE_MODEL = (() => {
  const model = String(savedConfig.CONSTELLATE_MODEL || 'openai/gpt-oss-20b');
  return model.length > 0 ? model : 'openai/gpt-oss-120b';
})();

export const CONSTELLATE_FALLBACK_MODELS = (() => {
  if (savedConfig.CONSTELLATE_FALLBACK_MODELS) {
    if (Array.isArray(savedConfig.CONSTELLATE_FALLBACK_MODELS)) {
      return savedConfig.CONSTELLATE_FALLBACK_MODELS.map((s: any) =>
        String(s).trim()
      ).filter((s: string) => s.length > 0);
    } else {
      return String(savedConfig.CONSTELLATE_FALLBACK_MODELS)
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    }
  }
  return ['openai/gpt-oss-120b'];
})();

// Internal defaults (not user-configurable)
export const CONSTELLATE_DEFAULT_CONTEXT = 128000;
export const CONSTELLATE_DEFAULT_OUTPUT = 8192;
