import { RepoFeature, RepoFacts, CategoryGlossary } from './schemas';

import { ExpandPlanPlus } from './schemas';
import { CategoryDraft, AssignmentDraft } from './schemas';
import { StreamlinedPlan } from './schemas';
import { ConstellateStore } from './schemas';
import { QaFix } from './schemas';
import { Category } from './schemas';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import slugify from 'slugify';
import { safeStreamObject } from './safe-stream';

// Cached slugify function to avoid repeated computations
const slugifyCache = new Map<string, string>();
const SLUGIFY_OPTIONS = { lower: true, strict: true, trim: true };

function cachedSlugify(text: string): string {
  if (slugifyCache.has(text)) {
    return slugifyCache.get(text)!;
  }
  const result = slugify(text, SLUGIFY_OPTIONS);
  slugifyCache.set(text, result);
  return result;
}
import { headTailSlice, estimateTokens } from './tokens';
import { pickModelFor } from './models';
import { CONSTELLATE_MODEL } from './config';
// ------------------------------ AI Utilities --------------------------------

// Dynamic model selection based on context needs
export async function getModelForTokens(tokens: number) {
  const { id } = await pickModelFor(tokens);
  return { model: id, modelId: id };
}

// Use central OpenAI model string for Vercel AI Gateway
export const model = CONSTELLATE_MODEL;

// Export default model name for backward compatibility
export const modelName = CONSTELLATE_MODEL;

// Cache for token estimation to avoid repeated calculations
const tokenEstimationCache = new Map<string, number>();

// Fast token estimation for messages without JSON serialization
function estimateTokensFromMessages(messages: ModelMessage[]): number {
  // Create a simple cache key from message structure
  const cacheKey = messages
    .map(
      (m) =>
        `${m.role}:${
          typeof m.content === 'string' ? m.content.length : 'array'
        }`
    )
    .join('|');

  // Check cache first
  const cached = tokenEstimationCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let totalTokens = 0;

  for (const message of messages) {
    // Add tokens for role and basic structure
    totalTokens += 4; // ~4 tokens for role + metadata

    if (typeof message.content === 'string') {
      totalTokens += estimateTokens(message.content);
    } else if (Array.isArray(message.content)) {
      // Handle array content (images, etc.)
      totalTokens += message.content.length * 10; // Rough estimate
    }
  }

  // Add overhead for message formatting
  const result = Math.ceil(totalTokens * 1.1);

  // Cache the result (limit cache size to prevent memory leaks)
  if (tokenEstimationCache.size > 1000) {
    tokenEstimationCache.clear();
  }
  tokenEstimationCache.set(cacheKey, result);

  return result;
}

// Payload slimming to reduce token usage (optimized - no JSON roundtrip)
function slim<T extends object>(o: T): T {
  const result: any = {};

  for (const [key, value] of Object.entries(o)) {
    if (value === '' || (Array.isArray(value) && value.length === 0)) {
      continue; // Skip empty values
    }

    if (Array.isArray(value)) {
      // Recursively clean arrays
      result[key] = value
        .map((item) =>
          typeof item === 'object' && item !== null ? slim(item) : item
        )
        .filter((item) => item !== '' && item !== null && item !== undefined);
    } else if (typeof value === 'object' && value !== null) {
      // Recursively clean nested objects
      result[key] = slim(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

// Absorb QA aliases back into glossary for future runs
export async function absorbAliasesIntoGlossary(fix: z.infer<typeof QaFix>) {
  const g = await loadCategoryGlossary();
  for (const [alias, target] of Object.entries(fix.aliases || {})) {
    if (!g.discouraged_aliases[alias]) g.discouraged_aliases[alias] = target;
  }
  await saveCategoryGlossary(g);
  // Cache is already invalidated in saveCategoryGlossary
}

// README render safety with singleton filtering
export function filterCategoriesForReadme(store: ConstellateStore, minSize = 1) {
  return store.categories.filter((c) => c.repos.length >= minSize);
}

// Auto-shrink streaming wrapper for overflow fallback
async function* streamWithAutoShrink(
  processBatch: (group: RepoFeature[]) => Promise<any>,
  initialBatch: RepoFeature[]
): AsyncGenerator<any, void, unknown> {
  let group = initialBatch;
  while (group.length) {
    try {
      const result = await processBatch(group);
      const { partialObjectStream } = result;
      for await (const chunk of partialObjectStream) yield chunk;
      break; // success
    } catch (e: any) {
      if (!/context|length|token/i.test(String(e?.message))) throw e;
      if (group.length === 1) throw e; // cannot shrink further
      const mid = Math.floor(group.length / 2);
      // Recurse: first half then second half
      yield* streamWithAutoShrink(processBatch, group.slice(0, mid));
      yield* streamWithAutoShrink(processBatch, group.slice(mid));
      break;
    }
  }
}

// Category Glossary utilities - with caching for performance
let glossaryCache: z.infer<typeof CategoryGlossary> | null = null;
let glossaryCachePromise: Promise<z.infer<typeof CategoryGlossary>> | null =
  null;

export async function loadCategoryGlossary(): Promise<
  z.infer<typeof CategoryGlossary>
> {
  // Return cached result if available
  if (glossaryCache) {
    return glossaryCache;
  }

  // Return pending promise if already loading
  if (glossaryCachePromise) {
    return glossaryCachePromise;
  }

  // Load and cache
  glossaryCachePromise = (async () => {
    try {
      const fs = await import('fs/promises');
      const data = await fs.readFile('.constellate/category-glossary.json', 'utf-8');
      const parsed = CategoryGlossary.parse(JSON.parse(data));
      glossaryCache = parsed; // Cache the result
      return parsed;
    } catch {
      // Return default if file doesn't exist
      const defaultGlossary = CategoryGlossary.parse({
        version: 3,
        preferred: [
          {
            slug: 'ai-agents',
            title: 'AI Agents',
            criteria:
              'Includes multi-step autonomous or tool-using agents that plan/act/reflect',
          },
          {
            slug: 'browser-automation',
            title: 'Browser Automation',
            criteria: 'Includes headless/vision-guided web UI automation',
          },
          {
            slug: 'authentication',
            title: 'Authentication',
            criteria:
              'Includes login, authorization, and user identity management systems',
          },
          {
            slug: 'databases',
            title: 'Databases',
            criteria:
              'Includes database engines, ORMs, and data persistence solutions',
          },
          {
            slug: 'frameworks',
            title: 'Frameworks',
            criteria:
              'Includes application frameworks and development platforms',
          },
          {
            slug: 'libraries',
            title: 'Libraries',
            criteria: 'Includes utility libraries and code packages',
          },
          {
            slug: 'cli-tools',
            title: 'CLI Tools',
            criteria:
              'Includes command-line interfaces and terminal applications',
          },
          {
            slug: 'web-development',
            title: 'Web Development',
            criteria:
              'Includes frontend, backend, and full-stack web development tools',
          },
        ],
        discouraged_aliases: {},
      });
      glossaryCache = defaultGlossary;
      return defaultGlossary;
    }
  })();

  const result = await glossaryCachePromise;
  glossaryCachePromise = null; // Clear the promise
  return result;
}

export async function saveCategoryGlossary(
  glossary: z.infer<typeof CategoryGlossary>
): Promise<void> {
  const fs = await import('fs/promises');
  await fs.mkdir('.constellate', { recursive: true });
  await fs.writeFile(
    '.constellate/category-glossary.json',
    JSON.stringify(glossary, null, 2)
  );

  // Invalidate cache so next load gets fresh data
  glossaryCache = null;
  glossaryCachePromise = null;
}

// Pre-compile regex for performance
const codeFenceRegex = /```json\s*|```/gi;

export function stripNonJson(s: string) {
  // remove code fences and leading/trailing noise (optimized with pre-compiled regex)
  const cleaned = s.replace(codeFenceRegex, '').trim();
  // try to find first/last JSON object
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

// Pass-0 (Facts Extractor) - Streaming version with safe context handling
export async function* aiPass0FactsExtractorStreaming(
  batchRepos: RepoFeature[]
) {
  // MICRO-BATCH: start with configurable batch size; can shrink if overflow happens
  const BATCH_SIZE = 4;
  const MAX_README_TOKENS = 20000;

  const groups = Array.from(
    { length: Math.ceil(batchRepos.length / BATCH_SIZE) },
    (_, i) => batchRepos.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
  );

  for (const group of groups) {
    // Use auto-shrink wrapper for overflow fallback
    yield* streamWithAutoShrink(async (batchGroup: RepoFeature[]) => {
      const compact = batchGroup.map((r) => ({
        repo: {
          id: r.id,
          name: r.name,
          language: r.language,
          topics: r.topics,
          readme:
            r.purpose || r.capabilities?.length
              ? ''
              : headTailSlice(r.readme_full ?? '', MAX_README_TOKENS),
        },
        return_schema:
          '{ facts, purpose, capabilities, tech_stack, keywords, disclaimers }',
        constraints: {
          max_keywords: 16,
          max_caps: 10,
        },
      }));

      const messages: ModelMessage[] = [
        {
          role: 'system',
          content:
            "Constellate Pass-0 (Facts). Given one repository's metadata and README,\nextract concise factual signals for categorization.\nOnly use provided text. Do not invent facts.\n\nSelf-questions (answer implicitly via fields):\n- What is the repo's primary purpose in one short phrase?\n- Which concrete capabilities are explicitly mentioned (avoid generic words)?\n- Which tech stack elements are stated (frameworks, runtimes, CLIs)?\n- Which keywords best disambiguate domain (≤16)?\n- Any clear signals the repo is a CLI, library, framework, demo?\n- Any license or disclaimers worth noting?",
        },
        {
          role: 'user',
          content: JSON.stringify(slim(compact)),
        },
      ];

      // Estimate tokens and select appropriate model (optimized - avoid JSON.stringify)
      const messageTokens = estimateTokensFromMessages(messages);
      const { model: selectedModel, modelId: selectedModelId } =
        await getModelForTokens(messageTokens);

      return await safeStreamObject({
        model: selectedModel,
        modelId: selectedModelId,
        schema: z.object({
          results: z
            .array(
              z.object({
                id: z.string(),
                facts: RepoFacts,
                purpose: z.string().default(''),
                capabilities: z.array(z.string()).default([]),
                tech_stack: z.array(z.string()).default([]),
                keywords: z.array(z.string()).default([]),
                disclaimers: z.array(z.string()).default([]),
              })
            )
            .default([]),
        }),
        messages,
        reserveOutput: Number(1024) || 1024,
      });
    }, group);
  }
}

// Pass-1 (Expand + Summaries) - Revised with structured prompts and safe context handling
export async function* aiPass1ExpandStreaming(batchRepos: RepoFeature[]) {
  const MAX_README_TOKENS = 20000;

  const compact = batchRepos.map((r) => ({
    id: r.id,
    name: r.name,
    language: r.language,
    topics: r.topics,
    // Include Pass-0 extracted facts for richer context
    facts: r.facts ?? null,
    purpose: r.purpose ?? '',
    capabilities: r.capabilities ?? [],
    tech_stack: r.tech_stack ?? [],
    keywords: r.keywords ?? [],
    // Use token-aware truncation instead of fixed char limit
    readme: headTailSlice(r.readme_full ?? '', MAX_README_TOKENS),
  }));

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.
- Use ONLY provided text; never browse or invent.

Constellate Pass-1 (Expand). For each repo:
(A) 1–2 sentence factual summary (no hype).
(B) 3–10 key_topics (deduped, lowercase).
(C) Propose candidate categories (title, short description, inclusion criteria).
(D) Assign each repo to EXACTLY ONE primary category with short reasons referencing evidence.

Rules:
- Use ONLY provided signals (facts, purpose, capabilities, tech_stack, topics, README chunk).
- Prefer domain/intent over tech stack when deciding category (e.g., "Browser Automation" > "TypeScript").
- Category titles: Title Case. Slugs: kebab-case, stable, deterministic.
- Criteria begin with "Includes …" and describe what belongs/doesn't.
- Avoid product-marketing language. Be concrete. No chain-of-thought; include a short reason field instead.

Granularity guidance:
- Split broad umbrellas like "Libraries" into focused domains when evidence supports it (e.g., "Vector Databases", "Prompt UI Components", "CLI Utilities", "Color Tools", "PDF Rendering", "RAG Frameworks", "Agent Protocols", "Benchmarking", "LLM Routing", "Token Utilities").
- Prefer ≥ 20–40 distinct categories overall if repos meaningfully differ; avoid collapsing unrelated tools.
- Create small categories (size 1) when clearly distinct; they can be merged later in QA.
- If unsure, prefer creating a more specific category over a broad one.

Segmentation guidance:
- When categories like "Libraries" or "Web Development" are too broad, segment by:
  1) Primary language (TypeScript/JavaScript, Python, Rust, Go, etc.)
  2) Software layer (API/SDK, UI components, CLI tools, Database/Storage, Infra/DevOps)
  3) Major framework (React, Vue, Svelte) when it meaningfully improves precision.
- Reflect segmentation in category titles and criteria.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        return_schema: '{ categories[], assignments[], summaries[] }', // assignments: [{ repo, category, reason, tags }]
        repos: compact,
        policy: {
          max_new_categories: 180,
          category_name_len: { title_max: 32, desc_max: 140 },
          summary_len_max_chars: 220,
          segmentation: { by_language: true, by_layer: true, min_group: 2 },
        },
      }),
    },
  ];

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: ExpandPlanPlus,
    messages,
    reserveOutput: Number(2048) || 2048,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

// Pass-1b (Refine & Split Oversized Categories)
export async function* aiPass1BRefineCategories(
  allRepos: RepoFeature[],
  merged: {
    categories: z.infer<typeof CategoryDraft>[];
    assignments: z.infer<typeof AssignmentDraft>[];
    summaries: Record<string, { summary: string; key_topics: string[] }>;
  },
  policies: { maxCategories: number; splitThreshold?: number }
) {
  const repoSignals = allRepos.map((r) => ({
    id: r.id,
    name: r.name,
    topics: r.topics,
    key_topics: r.key_topics || [],
    keywords: r.keywords || [],
    facts: r.facts || null,
    capabilities: r.capabilities || [],
    tech_stack: r.tech_stack || [],
  }));

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `Constellate Pass-1b (Refine & Split Oversized Categories).
Given a proposed category list and preliminary assignments, refine the category taxonomy by:
1) Splitting oversized or mixed categories into more specific subdomains using keywords/key_topics and facts.
2) Renaming vague categories to clearer, domain-specific titles with precise criteria.
3) Limiting total categories to <= maxCategories, but prioritize splitting when mixed.

Segmentation axes:
- Primary language (TypeScript/JavaScript, Python, Rust, Go, etc.)
- Software layer (API/SDK, UI components, CLI tools, Database/Storage, Infra/DevOps)
- Major framework (React, Vue, Svelte) when it adds clarity.

Guidelines:
- If a category contains ≥ splitThreshold repos spanning multiple languages or layers, split along that axis.
- Keep slugs stable and deterministic (kebab-case). Avoid hype in descriptions and criteria.

Criteria format requirement:
- For every category, ensure criteria has both lines:
  Includes: ...\n  Excludes: ...

Rules:
- Split when a category contains clearly separable subdomains (e.g., rendering vs. routing vs. caching).
- Keep slugs stable; generate kebab-case slugs from titles.
- Provide updated categories and updated assignments (one or multiple per repo allowed in this refinement).`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies: { ...policies, splitThreshold: policies.splitThreshold || 6 },
        repos: repoSignals,
        proposed: merged,
        return_schema: '{ categories[], assignments[] }',
      }),
    },
  ];

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: ExpandPlanPlus, // reuse: categories+assignments are compatible
    messages,
    reserveOutput: Number(2048) || 2048,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

// Pass-2.5 (Category Budget Consolidation)
export async function* aiPass25BudgetConsolidate(
  store: ConstellateStore,
  allRepos: RepoFeature[],
  budget: { min: number; max: number }
) {
  const repoMeta = allRepos.map((r) => ({
    id: r.id,
    name: r.name,
    language: r.language,
    key_topics: r.key_topics || [],
    keywords: r.keywords || [],
    facts: r.facts || null,
    capabilities: r.capabilities || [],
    tech_stack: r.tech_stack || [],
  }));

  const snapshot = {
    categories: store.categories.map((c) => ({
      slug: c.slug,
      title: c.title,
      description: c.description,
      criteria: c.criteria,
      repos: c.repos.map((r) => r.id),
    })),
  };

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `Constellate Pass-2.5 (Category Budget Consolidation).
You will consolidate categories to fit within a target range while preserving specificity.
Goals:
1) Merge near-duplicates and micro-categories into the best-fit parent.
2) Keep important, widely-recognized domains distinct.
3) Prefer layer/language splits only when helpful within the target budget.

Target range: min = ${22}, max = ${36}.
Return updated canonical categories and a reassignment map (id -> category).`,
    },
    {
      role: 'user',
      content: JSON.stringify({ budget, snapshot, repoMeta }),
    },
  ];

  const BudgetFix = z.object({
    categories: z
      .array(
        z.object({
          slug: z.string().optional(),
          title: z.string(),
          description: z.string().optional().default(''),
          criteria: z.string().optional().default(''),
        })
      )
      .default([]),
    aliases: z.record(z.string(), z.string()).default({}),
    reassign: z
      .array(z.object({ id: z.string(), toCategory: z.string() }))
      .default([]),
    delete: z.array(z.string()).default([]),
  });

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: BudgetFix,
    messages,
    reserveOutput: Number(2048) || 2048,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export async function mergeExpandPlans(
  plans: z.infer<typeof ExpandPlanPlus>[]
) {
  const catMap = new Map<string, z.infer<typeof CategoryDraft>>();
  const assign: z.infer<typeof AssignmentDraft>[] = [];
  const summaries: Record<string, { summary: string; key_topics: string[] }> =
    {};

  for (const p of plans) {
    for (const c of p.categories) {
      if (c.slug || c.title) {
        const key = cachedSlugify(c.slug || c.title);
        if (!catMap.has(key))
          catMap.set(key, {
            title: c.title,
            description: c.description ?? '',
            criteria: c.criteria ?? '',
            slug: key,
          });
      }
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

// Pass-2 (Streamline + Primary) - Revised with Category Glossary
export async function* aiPass2StreamlineStreaming(
  allRepos: RepoFeature[],
  merged: {
    categories: z.infer<typeof CategoryDraft>[];
    assignments: z.infer<typeof AssignmentDraft>[];
    summaries: Record<string, { summary: string; key_topics: string[] }>;
  },
  policies: {
    minCategorySize: number;
    maxCategories: number;
    max_new_categories: number;
  }
) {
  const glossary = await loadCategoryGlossary();

  const repoSummaries = allRepos.map((r) => ({
    id: r.id,
    name: r.name,
    language: r.language,
    topics: r.topics,
    summary: merged.summaries[r.id]?.summary ?? '',
    key_topics: merged.summaries[r.id]?.key_topics ?? [],
    // Include Pass-0 extracted facts for richer context
    facts: r.facts ?? null,
    capabilities: r.capabilities ?? [],
    tech_stack: r.tech_stack ?? [],
  }));

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.

Constellate Pass-2 (Streamline). Merge overlapping categories, map aliases to a
canonical set, and assign EXACTLY ONE primary category per repo.

Decision rules:
- Prefer purpose/domain over implementation tech.
- Language/framework-specific categories are acceptable if they improve clarity or if the parent category would otherwise be too broad (e.g., size ≥ splitThreshold or mixed subdomains). Note the specificity in criteria.
- If a repo fits multiple domains, choose the one a newcomer would expect from the README title/opening.

Outputs must be deterministic:
- Reuse canonical slugs from the provided Category Glossary when semantically equivalent.
- Create at most N new categories (given by policies).
- Provide a short per-assignment reason citing evidence fields (purpose, capabilities, keywords).

Criteria format requirement:
- For every category, ensure criteria has both lines:
  Includes: ...\n  Excludes: ...

When conflicting signals exist:
1) Purpose > Capabilities > Facts > Keywords > Topics > Tech stack.
2) Prefer domain over implementation.
3) Prefer Glossary canonical names over new names.

Tie-breakers:
If two categories fit equally, choose the one with more repos after consolidation; otherwise choose the one in the Glossary; otherwise the broader domain.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies: {
          ...policies,
          max_new_categories: policies.max_new_categories || 80,
          splitThreshold: 6,
        },
        repos: repoSummaries,
        proposed: merged,
        glossary: {
          preferred: glossary.preferred,
          discouraged_aliases: glossary.discouraged_aliases,
        },
      }),
    },
  ];

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: StreamlinedPlan,
    messages,
    reserveOutput: Number(2048) || 2048,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export async function* aiPass3QualityAssuranceStreaming(
  storeDraft: ConstellateStore,
  allRepos: RepoFeature[],
  policies: { minCategorySize: number }
) {
  const glossary = await loadCategoryGlossary();

  const compactCats = storeDraft.categories.map((c) => ({
    slug: c.slug,
    title: c.title,
    count: c.repos.length,
    sample: c.repos.slice(0, 6).map((r) => r.id),
  }));

  const repoMeta: Record<string, any> = {};
  for (const r of allRepos) {
    repoMeta[r.id] = {
      summary: r.summary ?? '',
      topics: r.key_topics ?? r.topics ?? [],
      // Include Pass-0 facts for richer context
      facts: r.facts ?? null,
      capabilities: r.capabilities ?? [],
      tech_stack: r.tech_stack ?? [],
    };
  }

  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.

Constellate Pass-3 (QA). You receive canonical categories, an index of primary
assignments, and repo meta. Your job:
1) Detect near-duplicate categories and propose alias merges.
2) Drop or merge categories below min size, unless they are uniquely useful.
3) Flag obvious misfits and propose reassignments with reason_short.
4) Improve category titles/descriptions/criteria for clarity, not marketing.

Rules:
- Never create a new category unless consolidating 2+ into one.
- Keep slugs stable; if renaming, include alias { old: new }.
- Provide reasons referencing evidence fields (summary, key_topics, capabilities).

Undersized categories policy:
If count < minCategorySize, either (a) alias to closest match, or (b) keep if it is a widely recognized term (e.g., 'Authentication') with ≥ 2 and distinctive criteria.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies,
        categories: compactCats,
        index: storeDraft.index,
        repo_meta: repoMeta,
        glossary: {
          preferred: glossary.preferred,
          discouraged_aliases: glossary.discouraged_aliases,
        },
      }),
    },
  ];

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: QaFix,
    messages,
    reserveOutput: Number(1024) || 1024,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export function applyQaFix(store: ConstellateStore, fix: z.infer<typeof QaFix>) {
  // 1) Build canonical slug map
  const aliasTo = new Map<string, string>();
  for (const [alias, target] of Object.entries(fix.aliases || {})) {
    if (
      typeof alias === 'string' &&
      alias.trim() &&
      typeof target === 'string' &&
      target.trim()
    ) {
      const a = cachedSlugify(alias);
      const t = cachedSlugify(target);
      aliasTo.set(a, t);
    }
  }

  // 2) Canonical category list
  const canon = new Map<string, Category>();
  for (const c of fix.categories || []) {
    if (c.slug || c.title) {
      const s = cachedSlugify(c.slug || c.title);
      canon.set(s, {
        slug: s,
        title: c.title,
        description: c.description ?? '',
        criteria: c.criteria ?? '',
        repos: [],
      });
    }
  }

  // 3) Move repos under canonical, applying aliasing + deletions + reassign overrides
  const reassign = new Map(
    (fix.reassign || [])
      .filter(
        (x) =>
          typeof x.id === 'string' &&
          x.id.trim() &&
          typeof x.toCategory === 'string' &&
          x.toCategory.trim()
      )
      .map((x) => [x.id, cachedSlugify(x.toCategory)])
  );

  const kill = new Set(
    (fix.delete || [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => cachedSlugify(s))
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
      let cat = canon.get(catSlug);

      if (!cat) {
        // Create the category if it doesn't exist
        cat = {
          slug: catSlug,
          title: catSlug,
          description: '',
          criteria: '',
          repos: [],
        };
        canon.set(catSlug, cat);
      }

      cat.repos.push(r);
      store.index[r.id] = { category: catSlug };
    }
  }

  // 4) Replace store categories with canonical, drop empties
  store.categories = Array.from(canon.values()).filter(
    (c) => c.repos.length > 0
  );

  // 5) Sort consistently
  for (const c of store.categories) {
    // Sort by recency (most recent commits first), then alphabetically by ID
    c.repos.sort((a, b) => {
      const aDays = a.quality?.last_commit_days ?? Infinity;
      const bDays = b.quality?.last_commit_days ?? Infinity;
      if (aDays !== bDays) return aDays - bDays;
      return (a.id || '').localeCompare(b.id || '');
    });
  }
  store.categories.sort((a, b) => a.title.localeCompare(b.title));
}

// --- add after mergeExpandPlans and before Pass-2 ---
export function graftSummariesIntoFeatures(
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

// Graft Pass-0 facts into features
export function graftFactsIntoFeatures(
  features: RepoFeature[],
  factsResult: any
) {
  const byId = new Map(features.map((r) => [r.id, r] as const));
  for (const result of factsResult.results) {
    const f = byId.get(result.id);
    if (f) {
      f.facts = result.facts;
      f.purpose = result.purpose;
      f.capabilities = result.capabilities;
      f.tech_stack = result.tech_stack;
      if (Array.isArray(result.keywords)) f.keywords = result.keywords;
    }
  }
}

// Ensure features have non-empty summary/capabilities/keywords/tech_stack/purpose
export function ensureMinimumFeatureSignals(features: RepoFeature[]) {
  // Pre-compile regex for performance
  const whitespaceRegex = /\s+/g;

  const toSentence = (s: string) =>
    (s || '').replace(whitespaceRegex, ' ').trim().slice(0, 220);

  // Optimized string processing function
  const processStrings = (arr: any[], maxLength: number, fallback: string) => {
    const result: string[] = [];
    for (let i = 0; i < arr.length && result.length < maxLength; i++) {
      const str = String(arr[i] || '')
        .toLowerCase()
        .trim();
      if (str && !result.includes(str)) {
        result.push(str);
      }
    }
    return result.length ? result : [fallback];
  };

  for (const f of features) {
    const topics = Array.isArray(f.topics) ? f.topics : [];
    const keywords = Array.isArray(f.keywords) ? f.keywords : [];
    const caps = Array.isArray(f.capabilities) ? f.capabilities : [];
    const stack = Array.isArray(f.tech_stack) ? f.tech_stack : [];

    // Capabilities: derive from keywords or topics if empty (optimized)
    if (!caps.length) {
      f.capabilities = processStrings(
        keywords.length ? keywords : topics,
        8,
        'general'
      );
    }

    // Keywords: ensure at least something (from topics/capabilities) (optimized)
    if (!keywords.length) {
      f.keywords = processStrings(
        topics.length ? topics : f.capabilities,
        12,
        'misc'
      );
    }

    // Tech stack: ensure includes language and CLI/lib flags
    if (!stack.length) {
      const s: string[] = [];
      if (f.language) s.push(String(f.language));
      if (f.facts?.is_cli) s.push('CLI');
      if (f.facts?.is_library) s.push('library');
      if (f.facts?.is_framework) s.push('framework');
      f.tech_stack = s.length ? s : f.language ? [String(f.language)] : [];
    }

    // Purpose: fallback from description or summary
    if (!f.purpose || !String(f.purpose).trim()) {
      const d = typeof f.description === 'string' ? f.description : '';
      f.purpose = toSentence(d) || undefined;
    }

    // Summary: ensure non-empty fallback
    if (
      !f.summary ||
      !String(f.summary).trim() ||
      String(f.summary).length < 20
    ) {
      const desc = typeof f.description === 'string' ? f.description : '';
      const lang = f.language ? `${f.language} ` : '';
      const capsSnippet = (f.capabilities || []).slice(0, 3).join(', ');
      const topicsSnippet = topics.slice(0, 3).join(', ');
      const base = desc || `${f.name} – ${lang}${capsSnippet || topicsSnippet}`;
      f.summary = toSentence(base || `${f.name} repository.`);
    }
  }
}

// Backfill categories from index - ensures every slug in store.index has a corresponding category
export function backfillCategoriesFromIndex(
  store: ConstellateStore,
  allRepos: RepoFeature[]
) {
  const catBySlug = new Map(store.categories.map((c) => [c.slug, c]));
  const repoById = new Map(allRepos.map((r) => [r.id, r]));

  // Ensure category objects exist for every indexed slug
  for (const { category } of Object.values(store.index)) {
    if (!catBySlug.has(category)) {
      const title = category
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (s) => s.toUpperCase());
      const c: Category = {
        slug: category,
        title,
        description: '',
        criteria: '',
        repos: [],
      };
      catBySlug.set(category, c);
    }
  }

  // Clear repos to rebuild from index
  for (const c of catBySlug.values()) c.repos = [];

  // Rebuild repos from index with full quality data
  for (const [id, { category }] of Object.entries(store.index)) {
    const categoryObj = catBySlug.get(category);
    if (categoryObj) {
      const sourceRepo = repoById.get(id);
      categoryObj.repos.push({
        id,
        reason: '',
        tags: [],
        confidence: 0.75,
        quality: sourceRepo
          ? {
              last_commit_days: sourceRepo.pushed_at
                ? Math.floor(
                    (Date.now() - new Date(sourceRepo.pushed_at).getTime()) /
                      (1000 * 60 * 60 * 24)
                  )
                : undefined,
              archived: sourceRepo.archived,
            }
          : undefined,
      });
    }
  }

  // Update store.categories with backfilled categories
  store.categories = Array.from(catBySlug.values()).filter(
    (c) => c.repos.length > 0
  );

  // Sort for stable output
  store.categories.sort((a, b) => a.title.localeCompare(b.title));
  for (const c of store.categories) {
    // Sort by recency (most recent commits first), then alphabetically by ID
    c.repos.sort((a, b) => {
      const aDays = a.quality?.last_commit_days ?? Infinity;
      const bDays = b.quality?.last_commit_days ?? Infinity;
      if (aDays !== bDays) return aDays - bDays;
      return (a.id || '').localeCompare(b.id || '');
    });
  }
}
