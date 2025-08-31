#!/usr/bin/env bun
/**
 * Nebula – AI Categorizer (Single File)
 * Bun + Effect + Ink + AI SDK (generateObject)
 *
 * • Fetches your GitHub stars (+ details + FULL README)
 * • Multi‑pass AI categorization (no deterministic heuristics)
 *   Pass 1: EXPAND → propose categories + multi‑category assignments
 *   Pass 2: STREAMLINE → dedupe/merge categories + pick primary per repo
 * • Writes: data/stars.json, data/nebula.json, README.md
 *
 * Commands
 *   nebula                 → interactive browse then build
 *   nebula build           → non‑interactive crawl + build
 *   nebula login/logout    → auth helpers
 *
 * Env
 *   OPENAI_API_KEY         (required)
 *   NEBULA_MODEL           (default: gpt-4o-mini)
 *   NEBULA_MAX_REPOS       (default: 20)
 *   NEBULA_BATCH           (default: 6)
 *   NEBULA_MIN_CAT_SIZE    (default: 2)
 *   NEBULA_MAX_CATEGORIES  (default: 80)
 */

// --------------------------------- Imports ---------------------------------
import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Effect, Console, Layer, ConfigProvider } from 'effect';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import slugify from 'slugify';
import { generateObject, generateText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

// ------------------------------- Small helpers ------------------------------
const runCommand = (cmd: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const { spawn } = require('child_process');
        const [command, ...args] = cmd.split(' ');
        const child = spawn(command, args, { stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (code: number) =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(stderr || `Command failed ${code}`))
        );
        child.on('error', (e: Error) => reject(e));
      }),
    catch: (e) => new Error(String(e)),
  });

const parseNextLink = (link: string | null): string | '' => {
  if (!link) return '';
  for (const seg of link.split(',')) {
    const m = seg.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m && m[1]) return m[1];
  }
  return '';
};

const daysSince = (iso?: string): number | undefined => {
  if (!iso?.trim()) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
};

const batch = <T,>(arr: T[], size: number): T[][] => {
  if (size <= 0) throw new Error('Batch size must be positive');
  if (arr.length === 0) return [];

  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};

const sha256 = (s: string) =>
  crypto.createHash('sha256').update(s).digest('hex');

// --------------------------------- Types -----------------------------------
export type StarredRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
};

export type DetailedRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at?: string;
  size: number;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  topics: string[];
  license: { name: string } | null;
  owner: { login: string; avatar_url: string; type: string };
};

// ------------------------- Auth & GitHub API layer --------------------------
const TOKEN_PATH = path.join(os.homedir(), '.nebula.json');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_REPOS_TO_PROCESS = parseInt(process.env.NEBULA_MAX_REPOS || '20');
const NEBULA_BATCH = parseInt(process.env.NEBULA_BATCH || '6');

const hasGitHubCLI = (): Effect.Effect<boolean> =>
  runCommand('which gh').pipe(
    Effect.map(() => true),
    Effect.orElse(() => Effect.succeed(false))
  );
const isGitHubCLIAuthenticated = (): Effect.Effect<boolean> =>
  runCommand('gh auth status').pipe(
    Effect.map(() => true),
    Effect.orElse(() => Effect.succeed(false))
  );
const getGitHubCLIToken = (): Effect.Effect<string | null> =>
  runCommand('gh auth token').pipe(
    Effect.map((t) => t.trim()),
    Effect.orElse(() => Effect.succeed(null))
  );

const writeToken = (token: string) =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(
        TOKEN_PATH,
        JSON.stringify({ access_token: token }, null, 2),
        {
          mode: 0o600,
        }
      ),
    catch: (e) => new Error(`Failed to write token file: ${String(e)}`),
  });

const readToken = Effect.gen(function* () {
  const raw = yield* Effect.tryPromise({
    try: () => fs.readFile(TOKEN_PATH, 'utf-8'),
    catch: () => new Error('Token file not found'),
  }).pipe(Effect.orElse(() => Effect.succeed(null)));

  if (!raw) return null;

  const parsedResult = yield* Effect.tryPromise({
    try: () => JSON.parse(raw),
    catch: (e) => new Error(`Invalid JSON in token file: ${String(e)}`),
  }).pipe(Effect.orElse(() => Effect.succeed(null)));

  const parsed = parsedResult as { access_token?: string } | null;

  if (!parsed) return null;

  return typeof parsed.access_token === 'string' ? parsed.access_token : null;
});

const removeToken = Effect.tryPromise({
  try: () => fs.rm(TOKEN_PATH, { force: true }),
  catch: (e) => new Error(`Failed to remove token file: ${String(e)}`),
});

// OAuth Device Flow
type DeviceCodeResp = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};
type TokenResp =
  | { access_token: string; token_type: string; scope: string }
  | { error: string; error_description?: string };

const startDeviceFlow = (
  scope = 'public_repo read:user'
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if (!CLIENT_ID)
      yield* Effect.fail(new Error('GitHub authentication required'));
    const body = new URLSearchParams({ client_id: CLIENT_ID, scope });
    const r = yield* Effect.tryPromise({
      try: () =>
        fetch('https://github.com/login/device/code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        }),
      catch: (e) => new Error(String(e)),
    });
    if (!r.ok)
      yield* Effect.fail(new Error(`Device code request failed: ${r.status}`));
    const json = (yield* Effect.tryPromise({
      try: () => r.json(),
      catch: (e) => new Error(String(e)),
    })) as DeviceCodeResp;
    yield* Console.log('\n== GitHub Login ==');
    yield* Console.log(`1) Open: ${json.verification_uri}`);
    yield* Console.log(`2) Enter code: ${json.user_code}\n`);
    return yield* _pollForToken(json);
  });

const _pollForToken = (dc: DeviceCodeResp): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    let intervalMs = (dc.interval ?? 5) * 1000;
    const end = Date.now() + dc.expires_in * 1000;
    while (Date.now() < end) {
      yield* Effect.sleep(intervalMs);
      const resp = yield* Effect.tryPromise({
        try: () =>
          fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'application/json',
            },
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              device_code: dc.device_code,
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
          }),
        catch: (e) => new Error(String(e)),
      });
      if (!resp.ok) continue;
      const json = (yield* Effect.tryPromise({
        try: () => resp.json(),
        catch: (e) => new Error(String(e)),
      })) as TokenResp;
      if (
        'access_token' in json &&
        json.access_token &&
        typeof json.access_token === 'string'
      )
        return json.access_token as string;
      if ('error' in json) {
        if (json.error === 'authorization_pending') continue;
        if (json.error === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        yield* Effect.fail(new Error(`OAuth error: ${json.error}`));
      }
    }
    yield* Effect.fail(new Error('Timed out waiting for authorization.'));
    // This should never be reached, but TypeScript needs it
    throw new Error('Unreachable');
  });

// GitHub calls
const whoAmI = (token: string) =>
  Effect.tryPromise({
    try: async () => {
      const r = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nebula',
        },
      });
      if (!r.ok) return null;
      return (await r.json()) as { login: string };
    },
    catch: (e) => new Error(String(e)),
  });

const getRepoDetails = (token: string, repoFullName: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repoFullName}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nebula',
        },
      }),
    catch: (e) => new Error(String(e)),
  }).pipe(
    Effect.flatMap((r) =>
      r.ok
        ? Effect.succeed(r)
        : Effect.fail(new Error(`GitHub error ${r.status}`))
    ),
    Effect.flatMap((r) =>
      Effect.tryPromise({
        try: () => r.json() as Promise<any>,
        catch: (e) => new Error(String(e)),
      })
    ),
    Effect.map(
      (repo: Record<string, unknown>): DetailedRepo => ({
        full_name: repo.full_name as string,
        description: repo.description as string | null,
        html_url: repo.html_url as string,
        stargazers_count: repo.stargazers_count as number,
        language: repo.language as string | null,
        created_at: repo.created_at as string,
        updated_at: repo.updated_at as string,
        pushed_at: repo.pushed_at as string | undefined,
        size: repo.size as number,
        fork: repo.fork as boolean,
        archived: repo.archived as boolean,
        disabled: repo.disabled as boolean,
        topics: (repo.topics as string[]) || [],
        license: repo.license as { name: string } | null,
        owner: {
          login: (repo.owner as Record<string, unknown>).login as string,
          avatar_url: (repo.owner as Record<string, unknown>)
            .avatar_url as string,
          type: (repo.owner as Record<string, unknown>).type as string,
        },
      })
    )
  );

const getRepoReadme = (token: string, repoFullName: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repoFullName}/readme`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'nebula',
        },
      }),
    catch: (e) => new Error(String(e)),
  }).pipe(
    Effect.flatMap((r) => {
      if (r.status === 404) return Effect.succeed(null);
      if (!r.ok) return Effect.fail(new Error(`GitHub error ${r.status}`));
      return Effect.tryPromise({
        try: () => r.json() as Promise<any>,
        catch: (e) => new Error(String(e)),
      });
    }),
    Effect.map((json: Record<string, unknown> | null) => {
      if (!json?.content || json.encoding !== 'base64') return null;
      try {
        return Buffer.from(json.content as string, 'base64').toString('utf-8');
      } catch {
        return null;
      }
    })
  );

const listStarred = (token: string) =>
  Effect.gen(function* () {
    const all: StarredRepo[] = [];
    let url = 'https://api.github.com/user/starred?per_page=100';
    while (url) {
      const r = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'nebula',
            },
          }),
        catch: (e) => new Error(String(e)),
      });
      if (!r.ok) yield* Effect.fail(new Error(`GitHub error ${r.status}`));
      const batch = (yield* Effect.tryPromise({
        try: () => r.json() as Promise<StarredRepo[]>,
        catch: (e) => new Error(String(e)),
      })) as StarredRepo[];
      for (const it of batch)
        all.push({
          full_name: it.full_name,
          description: it.description,
          html_url: it.html_url,
          stargazers_count: it.stargazers_count,
          language: it.language,
        });
      url = parseNextLink(r.headers.get('link'));
    }
    return all;
  });

// -------------------------- Categorization schema ---------------------------
const RepoFeature = z.object({
  id: z.string(),
  name: z.string(),
  owner: z.string(),
  html_url: z.string().url(),
  description: z.string().nullable(),
  language: z.string().nullable(),
  topics: z.array(z.string()).default([]),
  stars: z.number().int().nonnegative().default(0),
  archived: z.boolean().default(false),
  disabled: z.boolean().default(false),
  created_at: z.string().optional(),
  pushed_at: z.string().optional(),
  readme_full: z.string().optional().default(''),
  // NEW:
  summary: z.string().optional().default(''),
  key_topics: z.array(z.string()).optional().default([]),
});
export type RepoFeature = z.infer<typeof RepoFeature>;

const RepoEntry = z.object({
  id: z.string(),
  reason: z.string().optional().default(''),
  tags: z.array(z.string()).optional().default([]),
  quality: z
    .object({
      last_commit_days: z.number().optional(),
      stars: z.number().optional(),
      archived: z.boolean().optional(),
    })
    .optional(),
  confidence: z.number().min(0).max(1).optional(),
});
const Category = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
  criteria: z.string().optional().default(''),
  repos: z.array(RepoEntry).default([]),
});
export type Category = z.infer<typeof Category>;

const NebulaStore = z.object({
  version: z.number().default(1),
  generated_at: z.string(),
  policies: z
    .object({
      minCategorySize: z
        .number()
        .int()
        .positive()
        .default(parseInt(process.env.NEBULA_MIN_CAT_SIZE || '2')),
      maxCategories: z
        .number()
        .int()
        .positive()
        .default(parseInt(process.env.NEBULA_MAX_CATEGORIES || '80')),
    })
    .default({
      minCategorySize: parseInt(process.env.NEBULA_MIN_CAT_SIZE || '2'),
      maxCategories: parseInt(process.env.NEBULA_MAX_CATEGORIES || '80'),
    }),
  categories: z.array(Category).default([]),
  orphans: z.array(z.string()).default([]),
  aliases: z.record(z.string(), z.string()).default({}),
  index: z.record(z.string(), z.object({ category: z.string() })).default({}),
  provenance: z
    .array(
      z.object({
        ts: z.string(),
        model: z.string().optional(),
        prompt_hash: z.string().optional(),
        action: z.string(),
      })
    )
    .default([]),
});
export type NebulaStore = z.infer<typeof NebulaStore>;

// NEW: short, factual summary for each repo (from README)
const RepoSummary = z.object({
  id: z.string(),
  summary: z.string().min(20).max(500),
  key_topics: z.array(z.string()).max(10).default([]),
});

// ------------------------------ AI Schemas ----------------------------------
const CategoryDraft = z
  .object({
    slug: z.string().optional(),
    title: z.string(),
    description: z.string().optional().default(''),
    criteria: z.string().optional().default(''),
  })
  .passthrough(); // ignore extra keys from the model

const AssignmentDraft = z
  .object({
    repo: z.string(),
    categories: z.array(
      z
        .object({
          key: z.string(),
          reason: z.string().optional().default(''),
          tags: z.array(z.string()).optional().default([]),
        })
        .passthrough()
    ),
  })
  .passthrough();

// Pass-1 now returns categories/assignments + summaries
const ExpandPlanPlus = z.object({
  categories: z.array(CategoryDraft).default([]),
  assignments: z.array(AssignmentDraft).default([]),
  summaries: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().min(20).max(500),
        key_topics: z.array(z.string()).max(10).default([]),
      })
    )
    .default([]),
});

// Pass-3 (QA) asks the model to normalize categories, dedupe/alias,
// drop tiny/empty ones, and suggest reassignment fixes.
const QaFix = z.object({
  // canonical list of categories (post-merge)
  categories: z.array(CategoryDraft).default([]),
  // key: alias -> value: canonical slug/title
  aliases: z.record(z.string(), z.string()).default({}),
  // optional reassignments for misfiled repos
  reassign: z
    .array(z.object({ id: z.string(), toCategory: z.string() }))
    .default([]),
  // categories to delete (after aliasing/merge)
  delete: z.array(z.string()).default([]),
  // notes for provenance/debug
  notes: z.array(z.string()).default([]),
});

// Streamlined stays the same but a bit looser:
const StreamlinedRepo = z
  .object({
    id: z.string(),
    primaryCategory: z.string(),
    reason: z.string().optional().default(''),
    tags: z.array(z.string()).optional().default([]),
    confidence: z.number().min(0).max(1).optional().default(0.75),
  })
  .passthrough();

const StreamlinedPlan = z
  .object({
    categories: z.array(CategoryDraft).optional().default([]),
    aliases: z.record(z.string(), z.string()).optional().default({}),
    repos: z.array(StreamlinedRepo).optional().default([]),
  })
  .passthrough();

// ------------------------------ AI Utilities --------------------------------
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const modelName = process.env.NEBULA_MODEL || 'gpt-4o-mini';
const model = openai(modelName);

function stripNonJson(s: string) {
  // remove code fences and leading/trailing noise
  const cleaned = s.replace(/```json\s*|```/gi, '').trim();
  // try to find first/last JSON object
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

async function generateObjectSafe<T>({
  model,
  schema,
  messages,
  name,
  maxRetries = 2,
}: {
  model: any;
  schema: z.ZodSchema<T>;
  messages: ModelMessage[];
  name: string;
  maxRetries?: number;
}): Promise<T> {
  // 1) Normal attempt
  try {
    const { object } = await generateObject({ model, schema, messages });
    return object as T;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 2) Ask model to fix JSON and retry generateObject once
    if (maxRetries > 0) {
      const fixMsgs: ModelMessage[] = [
        ...messages,
        {
          role: 'user',
          content:
            'Your previous JSON did not match the schema. Return ONLY valid JSON strictly conforming to the schema above. No commentary.',
        },
      ];
      try {
        const { object } = await generateObject({
          model,
          schema,
          messages: fixMsgs,
        });
        return object as T;
      } catch (retryError) {
        // fall through to fallback
      }
    }

    // 3) Fallback: generate raw text, sanitize + parse, then Zod-parse
    const { text } = await generateText({ model, messages });
    const jsonStr = stripNonJson(text);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonStr);
    } catch (parseError) {
      throw new Error(
        `${name}: Could not parse model output as JSON. First 200 chars:\n${jsonStr.slice(
          0,
          200
        )}. Parse error: ${
          parseError instanceof Error ? parseError.message : String(parseError)
        }`
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // print first error for debugging but keep going
      const firstErr = parsed.error.issues?.[0];
      throw new Error(
        `${name}: JSON failed schema. First issue: ${firstErr?.message} at ${
          firstErr?.path?.join('.') || '(root)'
        }`
      );
    }
    return parsed.data as T;
  }
}

function msgRepoBlock(r: RepoFeature): string {
  return [
    `id: ${r.id}`,
    `name: ${r.name}`,
    `language: ${r.language ?? 'unknown'}`,
    `topics: ${r.topics.join(', ') || '(none)'}`,
    `stars: ${r.stars}`,
    `readme:\n\n${r.readme_full || '(no readme)'}\n---\n`,
  ].join('\n');
}

// Pass-1 (expand + summaries)
async function aiPass1Expand(batchRepos: RepoFeature[]) {
  const compact = batchRepos.map((r) => ({
    id: r.id,
    name: r.name,
    topics: r.topics,
    language: r.language,
    stars: r.stars,
    // cap to keep tokens sane; some READMEs are huge
    readme: (r.readme_full ?? '').slice(0, 32_000),
  }));

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'Nebula Pass-1. For each repo: (A) concise factual summary (1-3 sentences), (B) 3-8 key_topics, (C) propose batch categories and multi-category assignments. Use only provided text.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        return_schema: '{ categories[], assignments[], summaries[] }',
        repos: compact,
      }),
    },
  ];

  return await generateObjectSafe<z.infer<typeof ExpandPlanPlus>>({
    model,
    schema: ExpandPlanPlus,
    messages,
    name: 'Pass-1',
  });
}

function mergeExpandPlans(plans: z.infer<typeof ExpandPlanPlus>[]) {
  const catMap = new Map<string, z.infer<typeof CategoryDraft>>();
  const assign: z.infer<typeof AssignmentDraft>[] = [];
  const summaries: Record<string, { summary: string; key_topics: string[] }> =
    {};

  for (const p of plans) {
    for (const c of p.categories) {
      const key = slugify(c.slug || c.title, {
        lower: true,
        strict: true,
        trim: true,
      });
      if (!catMap.has(key))
        catMap.set(key, {
          title: c.title,
          description: c.description ?? '',
          criteria: c.criteria ?? '',
          slug: key,
        });
    }
    for (const a of p.assignments) assign.push(a);

    // merge summaries (first non-empty wins; later ones may add topics)
    for (const s of p.summaries || []) {
      if (!summaries[s.id]) {
        summaries[s.id] = {
          summary: s.summary || '',
          key_topics: s.key_topics || [],
        };
      } else {
        const existing = summaries[s.id]!;
        const seen = new Set(existing.key_topics);
        for (const t of s.key_topics || []) if (!seen.has(t)) seen.add(t);
        summaries[s.id]!.key_topics = Array.from(
          new Set(Array.from(seen))
        ).slice(0, 12);
      }
    }
  }
  return { categories: [...catMap.values()], assignments: assign, summaries };
}

// Pass-2 (streamline, uses summaries)
async function aiPass2Streamline(
  allRepos: RepoFeature[],
  merged: {
    categories: z.infer<typeof CategoryDraft>[];
    assignments: z.infer<typeof AssignmentDraft>[];
    summaries: Record<string, { summary: string; key_topics: string[] }>;
  },
  policies: { minCategorySize: number; maxCategories: number }
) {
  const repoSummaries = allRepos.map((r) => ({
    id: r.id,
    name: r.name,
    language: r.language,
    stars: r.stars,
    topics: r.topics,
    summary: merged.summaries[r.id]?.summary ?? '',
    key_topics: merged.summaries[r.id]?.key_topics ?? [],
  }));

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        "Nebula Pass-2. Merge overlapping categories, create aliases, and choose ONE primary category per repo. Prefer categories that best reflect each repo's purpose using summaries/key_topics.",
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies,
        repos: repoSummaries,
        proposed: merged,
      }),
    },
  ];

  return await generateObjectSafe<z.infer<typeof StreamlinedPlan>>({
    model,
    schema: StreamlinedPlan,
    messages,
    name: 'Pass-2',
  });
}

// --- NEW: aiPass3QualityAssurance ---
async function aiPass3QualityAssurance(
  storeDraft: NebulaStore,
  allRepos: RepoFeature[],
  policies: { minCategorySize: number }
) {
  const compactCats = storeDraft.categories.map((c) => ({
    slug: c.slug,
    title: c.title,
    count: c.repos.length,
    sample: c.repos.slice(0, 6).map((r) => r.id),
  }));

  const idToSummary: Record<string, any> = {};
  for (const r of allRepos) {
    idToSummary[r.id] = {
      summary: r.summary ?? '',
      topics: r.key_topics ?? r.topics ?? [],
      stars: r.stars,
    };
  }

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content:
        'You are Nebula QA. Given categories and repo summaries, return alias merges for near-duplicates, drop/merge undersized categories, and suggest reassignments for obvious misfits. Keep names consistent and human-readable.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies,
        categories: compactCats,
        index: storeDraft.index,
        repo_meta: idToSummary,
      }),
    },
  ];

  const { object } = await generateObject({
    model,
    schema: QaFix,
    messages,
  });
  return object;
}

// --- NEW: apply QaFix to NebulaStore ---
function applyQaFix(store: NebulaStore, fix: z.infer<typeof QaFix>) {
  // 1) Build canonical slug map
  const aliasTo = new Map<string, string>();
  for (const [alias, target] of Object.entries(fix.aliases || {})) {
    const a = slugify(alias, { lower: true, strict: true, trim: true });
    const t = slugify(target, { lower: true, strict: true, trim: true });
    aliasTo.set(a, t);
  }

  // 2) Canonical category list
  const canon = new Map<string, Category>();
  for (const c of fix.categories || []) {
    const s = slugify(c.slug || c.title, {
      lower: true,
      strict: true,
      trim: true,
    });
    canon.set(s, {
      slug: s,
      title: c.title,
      description: c.description ?? '',
      criteria: c.criteria ?? '',
      repos: [],
    });
  }

  // 3) Move repos under canonical, applying aliasing + deletions + reassign overrides
  const reassign = new Map(
    (fix.reassign || []).map((x) => [
      x.id,
      slugify(x.toCategory, { lower: true, strict: true, trim: true }),
    ])
  );

  const kill = new Set(
    (fix.delete || []).map((s) =>
      slugify(s, { lower: true, strict: true, trim: true })
    )
  );

  for (const c of store.categories) {
    const orig = c.slug;
    const target = reassign.has(orig)
      ? reassign.get(orig)!
      : aliasTo.get(orig) ?? orig;

    if (kill.has(orig)) continue;

    // If target category doesn't exist yet, create from existing title
    if (!canon.has(target)) {
      canon.set(target, {
        slug: target,
        title: c.title,
        description: c.description,
        criteria: c.criteria,
        repos: [],
      });
    }

    // Append repos, respecting per-repo reassign overrides
    for (const r of c.repos) {
      const forced = reassign.get(r.id);
      const catSlug = forced ?? target;
      const cat = canon.get(catSlug)!;
      cat.repos.push(r);
      store.index[r.id] = { category: catSlug };
    }
  }

  // 4) Replace store categories with canonical, drop empties
  store.categories = Array.from(canon.values()).filter(
    (c) => c.repos.length > 0
  );

  // 5) Sort consistently
  for (const c of store.categories)
    c.repos.sort((a, b) => (b.quality?.stars ?? 0) - (a.quality?.stars ?? 0));
  store.categories.sort((a, b) => a.title.localeCompare(b.title));
}

// --- add after mergeExpandPlans and before Pass-2 ---
function graftSummariesIntoFeatures(
  features: RepoFeature[],
  sm: Record<string, { summary: string; key_topics: string[] }>
) {
  const byId = new Map(features.map((r) => [r.id, r] as const));
  for (const [id, v] of Object.entries(sm)) {
    const f = byId.get(id);
    if (f) {
      f.summary = v.summary;
      f.key_topics = v.key_topics ?? [];
    }
  }
}

// --------------------------------- Builder ----------------------------------
function toRepoFeatures(
  items: Array<{ repo: StarredRepo; details?: DetailedRepo; readme?: string }>
): RepoFeature[] {
  return items.map(({ repo, details, readme }) => {
    const parts = repo.full_name.split('/');
    return {
      id: repo.full_name,
      name: parts[1] || '',
      owner: parts[0] || '',
      html_url: repo.html_url,
      description: repo.description,
      language: repo.language,
      topics: details?.topics ?? [],
      stars: details?.stargazers_count ?? repo.stargazers_count ?? 0,
      archived: details?.archived ?? false,
      disabled: details?.disabled ?? false,
      created_at: details?.created_at,
      pushed_at: details?.pushed_at ?? details?.updated_at,
      readme_full: readme ?? '',
      summary: '',
      key_topics: [],
    };
  });
}

// ---------------------------- Store & Rendering -----------------------------

function makeStoreFromStreamlined(
  allRepos: RepoFeature[],
  streamlined: z.infer<typeof StreamlinedPlan>
): NebulaStore {
  const store = NebulaStore.parse({ generated_at: new Date().toISOString() });

  // Slug collision guard
  const slugSeen = new Set<string>();
  function uniqueSlug(base: string) {
    let s = base,
      i = 2;
    while (slugSeen.has(s)) s = `${base}-${i++}`;
    slugSeen.add(s);
    return s;
  }

  // Create categories
  for (const c of streamlined.categories) {
    const base = slugify(c.slug || c.title, {
      lower: true,
      strict: true,
      trim: true,
    });
    const s = uniqueSlug(base);
    store.categories.push({
      slug: s,
      title: c.title,
      description: c.description ?? '',
      criteria: c.criteria ?? '',
      repos: [],
    });
  }

  // Index repos by id for quality fields
  const repoById = new Map(allRepos.map((r) => [r.id, r] as const));

  // Assign repos (primary only in this pass)
  for (const r of streamlined.repos) {
    const catSlug = slugify(r.primaryCategory, {
      lower: true,
      strict: true,
      trim: true,
    });
    let cat = store.categories.find((c) => c.slug === catSlug);
    if (!cat) {
      cat = {
        slug: catSlug,
        title: r.primaryCategory,
        description: '',
        criteria: '',
        repos: [],
      };
      store.categories.push(cat);
    }
    const source = repoById.get(r.id);
    cat.repos.push({
      id: r.id,
      reason: r.reason ?? '',
      tags: r.tags ?? [],
      confidence: r.confidence,
      quality: source
        ? {
            last_commit_days: daysSince(source.pushed_at),
            stars: source.stars,
            archived: source.archived,
          }
        : undefined,
    });
    store.index[r.id] = { category: cat.slug };
  }

  store.aliases = streamlined.aliases || {};

  // Ordering
  for (const c of store.categories)
    c.repos.sort((a, b) => (b.quality?.stars ?? 0) - (a.quality?.stars ?? 0));
  store.categories.sort((a, b) => a.title.localeCompare(b.title));
  return store;
}

function renderReadme(store: NebulaStore, features: RepoFeature[]): string {
  const lines: string[] = [];
  lines.push('# Awesome – Generated by Nebula');
  lines.push('');
  lines.push(
    `> Categories distilled from your stars via multi‑pass AI. Updated ${new Date()
      .toISOString()
      .slice(0, 10)}.`
  );
  lines.push('');

  // Filter out categories with no repositories
  const categoriesWithRepos = store.categories.filter(
    (c) => c.repos.length > 0
  );

  lines.push('## Table of Contents');
  for (const c of categoriesWithRepos) lines.push(`- [${c.title}](#${c.slug})`);
  lines.push('');

  // Create a map of repo features by ID for quick lookup
  const featuresById = new Map(features.map((f) => [f.id, f]));

  for (const c of categoriesWithRepos) {
    lines.push(`## ${c.title}`);
    if (c.description) lines.push(c.description);
    lines.push('');
    for (const r of c.repos) {
      const name = r.id.split('/').pop() ?? r.id;
      const starStr = r.quality?.stars ? ` – ⭐ ${r.quality?.stars}` : '';
      const tagStr = r.tags?.length
        ? ` _(${r.tags.slice(0, 4).join(', ')})_`
        : '';
      lines.push(`- [${name}](https://github.com/${r.id})${starStr}${tagStr}`);

      // Add summary if available (tiny gray line)
      const feature = featuresById.get(r.id);
      if (feature?.summary) {
        lines.push(`  <sub><em>${feature.summary}</em></sub>`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --------------------------------- Ink UI ----------------------------------
const ProgressBar: React.FC<{
  current: number;
  total: number;
  width?: number;
}> = ({ current, total, width = 30 }) => {
  const pct = Math.min(100, Math.max(0, Math.round((current / total) * 100)));
  const filled = Math.min(
    width,
    Math.max(0, Math.round((current / total) * width))
  );
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  return (
    <Text color="cyan">
      {bar} {pct}% ({current}/{total})
    </Text>
  );
};

type ProcessedRepo = {
  repo: StarredRepo;
  details?: DetailedRepo;
  readme?: string;
};

const NebulaApp: React.FC<{
  stars: StarredRepo[];
  maxRepos: number;
  token: string;
  onFinish: (processed: ProcessedRepo[]) => void;
}> = ({ stars, maxRepos, token, onFinish }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [processed, setProcessed] = useState<ProcessedRepo[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  useInput((input, key) => {
    if (isComplete) {
      if (key.leftArrow || key.upArrow)
        setSelectedIndex((s) => Math.max(0, s - 1));
      else if (key.rightArrow || key.downArrow)
        setSelectedIndex((s) => Math.min(processed.length - 1, s + 1));
      else if (input === 'q') process.exit(0);
    } else if (input === 'q') process.exit(0);
  });

  useEffect(() => {
    const processRepo = (repo: StarredRepo) =>
      Effect.gen(function* () {
        const details = yield* getRepoDetails(token, repo.full_name).pipe(
          Effect.orElse(() => Effect.succeed(null as DetailedRepo | null))
        );
        const readme = yield* getRepoReadme(token, repo.full_name).pipe(
          Effect.orElse(() => Effect.succeed(null as string | null))
        );
        return {
          repo,
          details: details ?? undefined,
          readme: readme ?? undefined,
        };
      });

    const step = Effect.gen(function* () {
      if (currentIndex >= Math.min(maxRepos, stars.length)) {
        setIsComplete(true);
        onFinish(processed);
        return;
      }
      const repo = stars[currentIndex];
      if (!repo) return;

      const result = yield* processRepo(repo);
      setProcessed((prev) => [...prev, result]);
      setTimeout(() => setCurrentIndex((i) => i + 1), 200);
    });

    if (!isComplete) {
      Effect.runPromise(step).catch((error) => {
        console.error('Processing error:', error);
      });
    }
  }, [currentIndex, isComplete, maxRepos, stars, token, onFinish]);

  if (!isComplete) {
    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="blue" bold>
          🚀 Nebula – Processing {Math.min(maxRepos, stars.length)} repositories
        </Text>
        <Newline />
        <ProgressBar
          current={currentIndex}
          total={Math.min(maxRepos, stars.length)}
          width={Math.min(40, contentWidth - 10)}
        />
        {processed.slice(-3).map((p, i) => (
          <Box key={i}>
            <Text color="green">{p.repo.full_name}</Text>
            {p.details && (
              <Text color="gray"> ({p.details.stargazers_count} ⭐)</Text>
            )}
          </Box>
        ))}
        {currentIndex < Math.min(maxRepos, stars.length) && (
          <Box>
            <Spinner type="dots" />
            <Text color="cyan">
              {' '}
              Processing: {stars[currentIndex]?.full_name}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  const sel = processed[selectedIndex];
  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="blue" bold>
        🚀 Nebula – Browsing {processed.length} repositories
      </Text>
      <Newline />
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="cyan">
          ←/↑ Prev • {selectedIndex + 1}/{processed.length} • Next →/↓
        </Text>
        <Text color="gray" dimColor>
          Q to quit
        </Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        <Text color="green" bold>
          {sel?.repo.full_name}
        </Text>
        {sel?.repo.description && (
          <Text color="gray">{sel.repo.description}</Text>
        )}
        <Text color="blue" underline>
          {sel?.repo.html_url}
        </Text>
      </Box>
      <Text color="gray">(Artifacts will be written to data/ + README.md)</Text>
    </Box>
  );
};

// ------------------------------ Build routine -------------------------------
const writeArtifactsFromProcessed = (processed: ProcessedRepo[]) =>
  Effect.gen(function* () {
    const features = toRepoFeatures(processed);

    // Pass 1 - Generate summaries first
    const batches = batch(features, NEBULA_BATCH);
    const expandPlans: Array<z.infer<typeof ExpandPlanPlus>> = [];

    for (const [i, b] of batches.entries()) {
      const plan = yield* Effect.tryPromise({
        try: () => aiPass1Expand(b),
        catch: (e) =>
          new Error(
            `Pass-1 failed on batch ${i + 1}/${batches.length}: ${
              e instanceof Error ? e.message : String(e)
            }`
          ),
      });
      expandPlans.push(plan);
    }

    const merged = mergeExpandPlans(expandPlans);
    graftSummariesIntoFeatures(features, merged.summaries);

    // Sanity check: log how many repos got summaries
    yield* Console.log(
      `🔎 summaries attached for ${
        features.filter((f) => f.summary).length
      } repos`
    );

    // Now write stars.json with summaries included
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile(
          'data/stars.json',
          JSON.stringify(features, null, 2),
          'utf-8'
        );
      },
      catch: (e) => new Error(`Failed to write stars.json: ${String(e)}`),
    });

    // Pass 2
    const policies = {
      minCategorySize: parseInt(process.env.NEBULA_MIN_CAT_SIZE || '2'),
      maxCategories: parseInt(process.env.NEBULA_MAX_CATEGORIES || '80'),
    };

    const streamlined = yield* Effect.tryPromise({
      try: () => aiPass2Streamline(features, merged, policies),
      catch: (e) =>
        new Error(
          `Pass-2 failed: ${e instanceof Error ? e.message : String(e)}`
        ),
    });

    // Build store
    const store = makeStoreFromStreamlined(features, streamlined);

    // Pass 3 - Quality Assurance
    const qaFix = yield* Effect.tryPromise({
      try: () => aiPass3QualityAssurance(store, features, policies),
      catch: (e) =>
        new Error(
          `Pass-3 failed: ${e instanceof Error ? e.message : String(e)}`
        ),
    });

    // Apply QA fixes
    applyQaFix(store, qaFix);

    // Write artifacts
    yield* Effect.tryPromise({
      try: async () => {
        await fs.writeFile(
          'data/nebula.json',
          JSON.stringify(store, null, 2),
          'utf-8'
        );
        const md = renderReadme(store, features);
        await fs.writeFile('README.md', md, 'utf-8');
      },
      catch: (e) => new Error(`Failed to write final artifacts: ${String(e)}`),
    });
  });

// Non-interactive build: crawl + categorize + write
const crawlAndBuild = (token: string, max: number) =>
  Effect.gen(function* () {
    const stars = yield* listStarred(token);
    const limited = stars.slice(0, Math.min(max, stars.length));
    const processed: ProcessedRepo[] = [];
    for (const s of limited) {
      const details = yield* getRepoDetails(token, s.full_name).pipe(
        Effect.orElse(() => Effect.succeed(null as unknown as DetailedRepo))
      );
      const readme = yield* getRepoReadme(token, s.full_name).pipe(
        Effect.orElse(() => Effect.succeed(null as unknown as string))
      );
      processed.push({
        repo: s,
        details: details ?? undefined,
        readme: readme ?? undefined,
      });
    }
    yield* writeArtifactsFromProcessed(processed).pipe(
      Effect.orElseFail(() => new Error('Failed to write artifacts'))
    );
  });

// ----------------------------------- CLI -----------------------------------
const main = Effect.gen(function* () {
  const [, , cmd] = process.argv;

  if (cmd === 'logout') {
    yield* removeToken;
    console.log('🗑️  Removed saved token.');
    return;
  }

  let token = yield* readToken;
  if (!token) {
    const hasCLI = yield* hasGitHubCLI();
    if (hasCLI) {
      const authed = yield* isGitHubCLIAuthenticated();
      if (authed) {
        const cliToken = yield* getGitHubCLIToken();
        if (cliToken) {
          yield* writeToken(cliToken);
          token = cliToken;
        }
      } else {
        console.log(
          '🔐 GitHub CLI found but not authenticated. Run `gh auth login` then rerun.'
        );
      }
    }
  }
  if (!token && GITHUB_TOKEN) {
    yield* writeToken(GITHUB_TOKEN);
    token = GITHUB_TOKEN;
  }
  if (cmd === 'login' || !token) {
    if (GITHUB_TOKEN && cmd === 'login') {
      console.log(
        'ℹ️  You have GITHUB_TOKEN set. Use `nebula logout` first to use OAuth.'
      );
      return;
    }
    const t = yield* startDeviceFlow();
    yield* writeToken(t);
    token = t;
    const me = yield* whoAmI(token);
    console.log(
      `✅ Logged in as ${me?.login ?? 'unknown'}. Saved token to ${TOKEN_PATH}`
    );
    if (cmd === 'login') return;
  }

  const me = yield* whoAmI(token!);
  if (me) console.log(`\n⭐ Starred repos for @${me.login}\n`);

  if (cmd === 'build') {
    yield* crawlAndBuild(token!, MAX_REPOS_TO_PROCESS);
    console.log('✅ Generated data/nebula.json and README.md');
    return;
  }

  const stars = yield* listStarred(token!);
  if (stars.length === 0) {
    console.log('No starred repositories found.');
    return;
  }

  const { waitUntilExit } = render(
    <NebulaApp
      stars={stars}
      maxRepos={MAX_REPOS_TO_PROCESS}
      token={token!}
      onFinish={(processed) => {
        Effect.runPromise(
          writeArtifactsFromProcessed(processed).pipe(
            Effect.andThen(() =>
              Console.log(
                '\n✅ All processing complete! Wrote data/nebula.json and README.md'
              )
            ),
            Effect.orElse(() =>
              Console.error('❌ Failed to write artifacts').pipe(
                Effect.map(() => undefined)
              )
            )
          )
        ).catch(() => {
          // Error already handled above
        });
      }}
    />
  );

  yield* Effect.tryPromise({
    try: () => waitUntilExit(),
    catch: (e) => new Error(String(e)),
  });
}).pipe(
  Effect.provide(Layer.setConfigProvider(ConfigProvider.fromEnv())),
  Effect.map(() => undefined)
);

Effect.runPromise(main).catch((e) => {
  console.error('Error:', e?.message ?? e);
  process.exit(1);
});
