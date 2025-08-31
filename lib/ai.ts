import { createOpenAI } from '@ai-sdk/openai';
import { RepoFeature, RepoFacts, CategoryGlossary } from './schemas';
import { streamObject } from 'ai';
import { ExpandPlanPlus } from './schemas';
import { CategoryDraft, AssignmentDraft } from './schemas';
import { StreamlinedPlan } from './schemas';
import { NebulaStore } from './schemas';
import { QaFix } from './schemas';
import { Category } from './schemas';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import slugify from 'slugify';
import { safeStreamObject } from './safe-stream';
import { headTailSlice } from './tokens';
import {
  NEBULA_PASS0_BATCH,
  NEBULA_MAX_README_TOKENS,
  NEBULA_RESERVE_TOKENS_PASS0,
  NEBULA_RESERVE_TOKENS_PASS1,
  NEBULA_RESERVE_TOKENS_PASS2,
  NEBULA_RESERVE_TOKENS_PASS3,
} from './config';
// ------------------------------ AI Utilities --------------------------------
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const modelName = process.env.NEBULA_MODEL || 'gpt-4o-mini';
export const model = openai(modelName);

// Category Glossary utilities
export async function loadCategoryGlossary(): Promise<
  z.infer<typeof CategoryGlossary>
> {
  try {
    const fs = await import('fs/promises');
    const data = await fs.readFile('data/category-glossary.json', 'utf-8');
    return CategoryGlossary.parse(JSON.parse(data));
  } catch {
    // Return default if file doesn't exist
    return CategoryGlossary.parse({
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
          criteria: 'Includes application frameworks and development platforms',
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
  }
}

export async function saveCategoryGlossary(
  glossary: z.infer<typeof CategoryGlossary>
): Promise<void> {
  const fs = await import('fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(
    'data/category-glossary.json',
    JSON.stringify(glossary, null, 2)
  );
}

export function stripNonJson(s: string) {
  // remove code fences and leading/trailing noise
  const cleaned = s.replace(/```json\s*|```/gi, '').trim();
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
  const BATCH_SIZE = NEBULA_PASS0_BATCH;
  const MAX_README_TOKENS = NEBULA_MAX_README_TOKENS;

  const groups = Array.from(
    { length: Math.ceil(batchRepos.length / BATCH_SIZE) },
    (_, i) => batchRepos.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
  );

  for (const group of groups) {
    const compact = group.map((r) => ({
      repo: {
        id: r.id,
        name: r.name,
        language: r.language,
        stars: r.stars,
        topics: r.topics,
        readme: headTailSlice(r.readme_full ?? '', MAX_README_TOKENS),
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
          "Nebula Pass-0 (Facts). Given one repository's metadata and README,\nextract concise factual signals for categorization.\nOnly use provided text. Do not invent facts.",
      },
      {
        role: 'user',
        content: JSON.stringify(compact),
      },
    ];

    const { partialObjectStream } = await safeStreamObject({
      model,
      modelId: modelName,
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
      reserveOutput: NEBULA_RESERVE_TOKENS_PASS0,
    });

    for await (const chunk of partialObjectStream) {
      yield chunk;
    }
  }
}

// Pass-1 (Expand + Summaries) - Revised with structured prompts and safe context handling
export async function* aiPass1ExpandStreaming(batchRepos: RepoFeature[]) {
  const MAX_README_TOKENS = NEBULA_MAX_README_TOKENS;

  const compact = batchRepos.map((r) => ({
    id: r.id,
    name: r.name,
    language: r.language,
    stars: r.stars,
    topics: r.topics,
    // Include Pass-0 extracted facts for richer context
    facts: r.facts ?? null,
    purpose: r.purpose ?? '',
    capabilities: r.capabilities ?? [],
    tech_stack: r.tech_stack ?? [],
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

Nebula Pass-1 (Expand). For each repo:
(A) 1–2 sentence factual summary (no hype).
(B) 3–10 key_topics (deduped, lowercase).
(C) Propose candidate categories (title, short description, inclusion criteria).
(D) Propose multi-category assignments with short reasons referencing evidence.

Rules:
- Use ONLY provided signals (facts, purpose, capabilities, tech_stack, topics, README chunk).
- Prefer domain/intent over tech stack when deciding category (e.g., "Browser Automation" > "TypeScript").
- Category titles: Title Case. Slugs: kebab-case, stable, deterministic.
- Criteria begin with "Includes …" and describe what belongs/doesn't.
- Avoid product-marketing language. Be concrete. No chain-of-thought; include a short reason field instead.

Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.
- Use ONLY provided text; never browse or invent.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        return_schema: '{ categories[], assignments[], summaries[] }',
        repos: compact,
        policy: {
          max_new_categories: 80,
          category_name_len: { title_max: 32, desc_max: 140 },
          summary_len_max_chars: 220,
        },
      }),
    },
  ];

  const { partialObjectStream } = await safeStreamObject({
    model,
    modelId: modelName,
    schema: ExpandPlanPlus,
    messages,
    reserveOutput: NEBULA_RESERVE_TOKENS_PASS1,
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
    stars: r.stars,
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

Nebula Pass-2 (Streamline). Merge overlapping categories, map aliases to a
canonical set, and assign EXACTLY ONE primary category per repo.

Decision rules:
- Prefer purpose/domain over implementation tech.
- If two categories differ only by framework (e.g., "Prompt UI" vs "Prompt UI (React)"),
  keep the framework-agnostic one; note framework in criteria if helpful.
- If a repo fits multiple domains, choose the one a newcomer would expect from the README title/opening.

Outputs must be deterministic:
- Reuse canonical slugs from the provided Category Glossary when semantically equivalent.
- Create at most N new categories (given by policies).
- Provide a short per-assignment reason citing evidence fields (purpose, capabilities, keywords).

When conflicting signals exist:
1) Purpose > Capabilities > Facts > Keywords > Topics > Tech stack.
2) Prefer domain over implementation.
3) Prefer Glossary canonical names over new names.

Tie-breakers:
If two categories fit equally, choose the one with more repos after consolidation; otherwise choose the one in the Glossary; otherwise the broader domain.

Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        policies: {
          ...policies,
          max_new_categories: policies.max_new_categories || 12,
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
    reserveOutput: NEBULA_RESERVE_TOKENS_PASS2,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export async function* aiPass3QualityAssuranceStreaming(
  storeDraft: NebulaStore,
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
      stars: r.stars,
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

Nebula Pass-3 (QA). You receive canonical categories, an index of primary
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
If count < minCategorySize, either (a) alias to closest match, or (b) keep if it is a widely recognized term (e.g., 'Authentication') with ≥ 2 and distinctive criteria.

Conventions:
- Titles: Title Case. Slugs: kebab-case. Deterministic from title.
- Descriptions ≤ 140 chars; Criteria start with "Includes …".
- Cite evidence fields (purpose/capabilities/facts/keywords/README) in reason_short.
- No marketing language. No chain-of-thought. Keep reasons ≤ 140 chars.`,
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
    reserveOutput: NEBULA_RESERVE_TOKENS_PASS3,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export function applyQaFix(store: NebulaStore, fix: z.infer<typeof QaFix>) {
  // 1) Build canonical slug map
  const aliasTo = new Map<string, string>();
  for (const [alias, target] of Object.entries(fix.aliases || {})) {
    if (
      typeof alias === 'string' &&
      alias.trim() &&
      typeof target === 'string' &&
      target.trim()
    ) {
      const a = slugify(alias, { lower: true, strict: true, trim: true });
      const t = slugify(target, { lower: true, strict: true, trim: true });
      aliasTo.set(a, t);
    }
  }

  // 2) Canonical category list
  const canon = new Map<string, Category>();
  for (const c of fix.categories || []) {
    if (c.slug || c.title) {
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
      .map((x) => [
        x.id,
        slugify(x.toCategory, { lower: true, strict: true, trim: true }),
      ])
  );

  const kill = new Set(
    (fix.delete || [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => slugify(s, { lower: true, strict: true, trim: true }))
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
  for (const c of store.categories)
    c.repos.sort((a, b) => (b.quality?.stars ?? 0) - (a.quality?.stars ?? 0));
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
    }
  }
}

// Backfill categories from index - ensures every slug in store.index has a corresponding category
export function backfillCategoriesFromIndex(
  store: NebulaStore,
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
              stars: sourceRepo.stars,
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
    c.repos.sort((a, b) => (b.quality?.stars ?? 0) - (a.quality?.stars ?? 0));
  }
}
