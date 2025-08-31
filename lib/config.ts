import path from 'node:path';
import os from 'node:os';

export const TOKEN_PATH = path.join(os.homedir(), '.nebula.json');
export const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const MAX_REPOS_TO_PROCESS = parseInt(process.env.NEBULA_MAX_REPOS || '20');
export const NEBULA_BATCH = parseInt(process.env.NEBULA_BATCH || '6');
