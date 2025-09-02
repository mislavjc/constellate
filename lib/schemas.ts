import { z } from 'zod';

// -------------------------- Categorization schema ---------------------------
export const RepoFacts = z.object({
  is_framework: z.boolean().default(false),
  is_cli: z.boolean().default(false),
  is_library: z.boolean().default(false),
  is_demo: z.boolean().default(false),
  has_examples_dir: z.boolean().default(false),
  has_benchmark: z.boolean().default(false),
  license: z.string().optional(),
});

export const RepoFeature = z.object({
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
  // NEW: Pass-0 extracted facts
  facts: RepoFacts.optional(),
  purpose: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  tech_stack: z.array(z.string()).default([]),
  // NEW: keywords extracted (Pass-0)
  keywords: z.array(z.string()).optional().default([]),
  // NEW: Pass-1 generated content
  summary: z.string().optional().default(''),
  key_topics: z.array(z.string()).optional().default([]),
});
export type RepoFeature = z.infer<typeof RepoFeature>;

export const RepoEntry = z.object({
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
export const Category = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().optional().default(''),
  criteria: z.string().optional().default(''),
  repos: z.array(RepoEntry).default([]),
});
export type Category = z.infer<typeof Category>;

export const ConstellateStore = z.object({
  version: z.number().default(1),
  generated_at: z.string(),
  policies: z
    .object({
      minCategorySize: z
        .number()
        .int()
        .positive()
        .default(parseInt(process.env.CONSTELLATE_MIN_CAT_SIZE || '2')),
      maxCategories: z
        .number()
        .int()
        .positive()
        .default(parseInt(process.env.CONSTELLATE_MAX_CATEGORIES || '80')),
    })
    .default({
      minCategorySize: parseInt(process.env.CONSTELLATE_MIN_CAT_SIZE || '2'),
      maxCategories: parseInt(process.env.CONSTELLATE_MAX_CATEGORIES || '80'),
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
export type ConstellateStore = z.infer<typeof ConstellateStore>;

// NEW: short, factual summary for each repo (from README)
export const RepoSummary = z.object({
  id: z.string(),
  summary: z.string().min(20).max(500),
  key_topics: z.array(z.string()).max(10).default([]),
});

// ------------------------------ AI Schemas ----------------------------------
export const CategoryDraft = z
  .object({
    slug: z.string().optional(),
    title: z.string(),
    description: z.string().optional().default(''),
    criteria: z.string().optional().default(''),
  })
  .passthrough(); // ignore extra keys from the model

export const AssignmentDraft = z
  .object({
    repo: z.string(),
    category: z.string(), // Single category assignment
    reason: z.string().optional().default(''),
    tags: z.array(z.string()).optional().default([]),
  })
  .passthrough();

// Pass-1 now returns categories/assignments + summaries
export const ExpandPlanPlus = z.object({
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
export const QaFix = z.object({
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
export const StreamlinedRepo = z
  .object({
    id: z.string(),
    primaryCategory: z.string(),
    reason: z.string().optional().default(''),
    tags: z.array(z.string()).optional().default([]),
    confidence: z.number().min(0).max(1).optional().default(0.75),
  })
  .passthrough();

export const StreamlinedPlan = z
  .object({
    categories: z.array(CategoryDraft).optional().default([]),
    aliases: z.record(z.string(), z.string()).optional().default({}),
    repos: z.array(StreamlinedRepo).optional().default([]),
  })
  .passthrough();

// Category Glossary for persistent memory
export const CategoryGlossary = z.object({
  version: z.number().default(3),
  preferred: z
    .array(
      z.object({
        slug: z.string(),
        title: z.string(),
        criteria: z.string(),
      })
    )
    .default([]),
  discouraged_aliases: z.record(z.string(), z.string()).default({}),
});
