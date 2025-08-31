import { createOpenAI } from '@ai-sdk/openai';
import { RepoFeature } from './schemas';
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
// ------------------------------ AI Utilities --------------------------------
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const modelName = process.env.NEBULA_MODEL || 'gpt-4o-mini';
export const model = openai(modelName);

export function stripNonJson(s: string) {
  // remove code fences and leading/trailing noise
  const cleaned = s.replace(/```json\s*|```/gi, '').trim();
  // try to find first/last JSON object
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return cleaned.slice(first, last + 1);
  return cleaned;
}

// Pass-1 (expand + summaries) - Streaming version
export async function* aiPass1ExpandStreaming(batchRepos: RepoFeature[]) {
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

  const { partialObjectStream } = streamObject({
    model,
    schema: ExpandPlanPlus,
    messages,
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

// Pass-2 (streamline, uses summaries) - Streaming version
export async function* aiPass2StreamlineStreaming(
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

  const { partialObjectStream } = streamObject({
    model,
    schema: StreamlinedPlan,
    messages,
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

  const { partialObjectStream } = streamObject({
    model,
    schema: QaFix,
    messages,
  });

  for await (const partialObject of partialObjectStream) {
    yield partialObject;
  }
}

export function applyQaFix(store: NebulaStore, fix: z.infer<typeof QaFix>) {
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
