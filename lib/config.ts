import path from 'node:path';
import os from 'node:os';

export const TOKEN_PATH = path.join(os.homedir(), '.nebula.json');
export const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const MAX_REPOS_TO_PROCESS = parseInt(
  process.env.NEBULA_MAX_REPOS || '10'
);
export const NEBULA_BATCH = parseInt(process.env.NEBULA_BATCH || '6');

// Context and token management
export const MODELS_DEV_URL =
  process.env.MODELS_DEV_URL || 'https://models.dev/api.json';
export const NEBULA_DEFAULT_CONTEXT = parseInt(
  process.env.NEBULA_DEFAULT_CONTEXT || '128000'
);
export const NEBULA_DEFAULT_OUTPUT = parseInt(
  process.env.NEBULA_DEFAULT_OUTPUT || '8192'
);
export const NEBULA_MAX_README_TOKENS = parseInt(
  process.env.NEBULA_MAX_README_TOKENS || '16000'
);

// Pass-specific batch sizes
export const NEBULA_PASS0_BATCH = parseInt(
  process.env.NEBULA_PASS0_BATCH || '4'
);

// Reserve tokens for each pass (for output generation)
export const NEBULA_RESERVE_TOKENS_PASS0 = parseInt(
  process.env.NEBULA_RESERVE_TOKENS_PASS0 || '1024'
);
export const NEBULA_RESERVE_TOKENS_PASS1 = parseInt(
  process.env.NEBULA_RESERVE_TOKENS_PASS1 || '2048'
);
export const NEBULA_RESERVE_TOKENS_PASS2 = parseInt(
  process.env.NEBULA_RESERVE_TOKENS_PASS2 || '2048'
);
export const NEBULA_RESERVE_TOKENS_PASS3 = parseInt(
  process.env.NEBULA_RESERVE_TOKENS_PASS3 || '1024'
);
