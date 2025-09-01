import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Effect, Console, Layer, ConfigProvider } from 'effect';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import slugify from 'slugify';
import { ensureAuthenticatedToken, removeToken, whoAmI } from './lib/auth';
import {
  getRepoDetails,
  getRepoReadme,
  listStarred,
  type DetailedRepo,
  type StarredRepo,
} from './lib/github';
import { batch, daysSince } from './lib/utils';
import {
  MAX_REPOS_TO_PROCESS,
  NEBULA_BATCH,
  NEBULA_README_MIN_SIZE,
} from './lib/config';
import {
  RepoFeature,
  NebulaStore,
  StreamlinedPlan,
  ExpandPlanPlus,
} from './lib/schemas';
import { aiPass0FactsExtractorStreaming } from './lib/ai';
import { aiPass1ExpandStreaming } from './lib/ai';
import { aiPass1BRefineCategories } from './lib/ai';
import { mergeExpandPlans } from './lib/ai';
import { graftSummariesIntoFeatures } from './lib/ai';
import { graftFactsIntoFeatures } from './lib/ai';
import { ensureMinimumFeatureSignals } from './lib/ai';
import { backfillCategoriesFromIndex } from './lib/ai';
import {
  applyQaFix,
  absorbAliasesIntoGlossary,
  filterCategoriesForReadme,
} from './lib/ai';
import { aiPass2StreamlineStreaming } from './lib/ai';
import { aiPass25BudgetConsolidate } from './lib/ai';
import { aiPass3QualityAssuranceStreaming } from './lib/ai';
import { QaFix, Category } from './lib/schemas';

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
      // Pass-0 fields (will be populated later)
      facts: undefined,
      purpose: undefined,
      capabilities: [],
      tech_stack: [],
      keywords: [],
      // Pass-1 fields
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
    if (c.slug || c.title) {
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
  }

  // Index repos by id for quality fields
  const repoById = new Map(allRepos.map((r) => [r.id, r] as const));

  // Assign repos (primary only in this pass)
  for (const r of streamlined.repos) {
    // Ensure primaryCategory is a valid string
    const primaryCategory = r.primaryCategory || 'uncategorized';
    const catSlug = slugify(primaryCategory, {
      lower: true,
      strict: true,
      trim: true,
    });
    let cat = store.categories.find((c: Category) => c.slug === catSlug);
    if (!cat) {
      cat = {
        slug: catSlug,
        title: primaryCategory,
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
            archived: source.archived,
          }
        : undefined,
    });
    store.index[r.id] = { category: cat.slug };
  }

  store.aliases = streamlined.aliases || {};

  // Ordering - sort by recency, then alphabetically
  for (const c of store.categories) {
    c.repos.sort((a, b) => {
      const aDays = a.quality?.last_commit_days ?? Infinity;
      const bDays = b.quality?.last_commit_days ?? Infinity;
      if (aDays !== bDays) return aDays - bDays;
      return (a.id || '').localeCompare(b.id || '');
    });
  }
  store.categories.sort((a, b) => a.title.localeCompare(b.title));
  return store;
}

function renderReadme(
  store: NebulaStore,
  features: RepoFeature[],
  minSize = 0
): string {
  const lines: string[] = [];
  lines.push('# Awesome – Generated by Nebula');
  lines.push('');
  lines.push(
    `> Categories distilled from your stars via multi‑pass AI. Updated ${new Date()
      .toISOString()
      .slice(0, 10)}.`
  );
  lines.push('');

  // Filter out categories with no repositories and optionally filter by minimum size
  const categoriesWithRepos = filterCategoriesForReadme(store, minSize).filter(
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
      const starStr = '';
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

// Streaming version of Nebula processing with AI streaming
const NebulaStreamingApp: React.FC<{
  stars: StarredRepo[];
  maxRepos: number;
  token: string;
  onFinish: (store: NebulaStore) => void;
  outputFilename: string;
}> = ({ stars, maxRepos, token, onFinish, outputFilename }) => {
  const [currentPhase, setCurrentPhase] = useState<
    'fetching' | 'ai-processing' | 'complete'
  >('fetching');
  const [currentStep, setCurrentStep] = useState(0);
  const [totalSteps, setTotalSteps] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [totalBatches, setTotalBatches] = useState(0);
  const [streamingData, setStreamingData] = useState<any>(null);
  const [processedRepos, setProcessedRepos] = useState<ProcessedRepo[]>([]);
  const [aiPhase, setAiPhase] = useState<
    'pass0' | 'pass1' | 'pass2' | 'pass3' | null
  >(null);
  const [allBatchesData, setAllBatchesData] = useState<any[]>([]);
  const [selectedBatchIndex, setSelectedBatchIndex] = useState(0);
  const [features, setFeatures] = useState<RepoFeature[]>([]);
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  useInput((input, key) => {
    if (currentPhase === 'complete') {
      if (input === 'q') process.exit(0);
    } else if (currentPhase === 'ai-processing' && allBatchesData.length > 0) {
      // Allow panning between batches during AI processing
      if (key.leftArrow || input === 'h') {
        setSelectedBatchIndex((prev) => Math.max(0, prev - 1));
      } else if (key.rightArrow || input === 'l') {
        setSelectedBatchIndex((prev) =>
          Math.min(allBatchesData.length - 1, prev)
        );
      } else if (input === 'q') {
        process.exit(0);
      }
    } else if (input === 'q') {
      process.exit(0);
    }
  });

  useEffect(() => {
    const processEverything = async () => {
      try {
        // Phase 1: Fetch repository data
        setCurrentPhase('fetching');
        setTotalSteps(Math.min(maxRepos, stars.length));

        const processed: ProcessedRepo[] = [];
        for (let i = 0; i < Math.min(maxRepos, stars.length); i++) {
          setCurrentStep(i + 1);
          const repo = stars[i];

          if (!repo) continue;

          const details = await Effect.runPromise(
            getRepoDetails(token, repo.full_name).pipe(
              Effect.orElse(() => Effect.succeed(null as DetailedRepo | null))
            )
          );

          const readme = await Effect.runPromise(
            getRepoReadme(token, repo.full_name).pipe(
              Effect.orElse(() => Effect.succeed(null as string | null))
            )
          );

          processed.push({
            repo,
            details: details ?? undefined,
            readme: readme ?? undefined,
          });
        }

        setProcessedRepos(processed);

        // Phase 2: AI Processing with streaming
        setCurrentPhase('ai-processing');

        let repoFeatures = toRepoFeatures(processed);
        setFeatures(repoFeatures);

        // Pass-0: Extract factual signals from READMEs (streaming)
        setAiPhase('pass0');
        try {
          const factsStreamingGenerator =
            aiPass0FactsExtractorStreaming(repoFeatures);
          let finalFactsResult: any = null;

          for await (const partialResult of factsStreamingGenerator) {
            // Update streaming data for UI
            setStreamingData({
              phase: 'pass0',
              partialResult,
              factsCount: partialResult?.results?.length || 0,
            });
            // Always update final result with the latest partial
            finalFactsResult = partialResult as any;
          }

          if (finalFactsResult) {
            graftFactsIntoFeatures(repoFeatures, finalFactsResult);
            setFeatures([...repoFeatures]); // Update state with facts
          }
        } catch (e: any) {
          e.message = `[PASS-0] ${e.message}`;
          throw e;
        }

        // Pass-1: Expand with summaries
        setAiPhase('pass1');
        let merged: any = null;
        try {
          const batches = batch(repoFeatures, NEBULA_BATCH);
          setTotalBatches(batches.length);

          const expandPlans: z.infer<typeof ExpandPlanPlus>[] = [];
          const batchData: any[] = [];

          // Initialize batch data with repository information
          for (const [i, b] of batches.entries()) {
            batchData.push({
              batchNumber: i + 1,
              repositories: b.map((repo) => ({
                id: repo.id,
                name: repo.name,
                language: repo.language,
                description: repo.description,
              })),
              streamingHistory: [],
              finalResult: null,
            });
          }
          setAllBatchesData(batchData);

          // Process each batch with streaming
          for (const [i, b] of batches.entries()) {
            setCurrentBatch(i + 1);
            setSelectedBatchIndex(i); // Follow current processing batch

            const streamingGenerator = aiPass1ExpandStreaming(b);
            let finalBatchResult: z.infer<typeof ExpandPlanPlus> | null = null;
            const streamingHistory: any[] = [];

            for await (const partialResult of streamingGenerator) {
              const streamingUpdate = {
                timestamp: Date.now(),
                partialResult,
                categoriesCount: partialResult?.categories?.length || 0,
                summariesCount: partialResult?.summaries?.length || 0,
                assignmentsCount: partialResult?.assignments?.length || 0,
              };

              streamingHistory.push(streamingUpdate);

              // Update batch data
              batchData[i].streamingHistory = [...streamingHistory];

              setStreamingData({
                batch: i + 1,
                totalBatches: batches.length,
                phase: 'pass1',
                partialResult,
                repoCount: b.length,
                repositories: batchData[i].repositories,
                streamingHistory: [...streamingHistory],
              });

              setAllBatchesData([...batchData]);

              // Only update final result if we have complete data
              if (
                partialResult &&
                partialResult.categories &&
                partialResult.assignments &&
                partialResult.summaries
              ) {
                finalBatchResult = partialResult as z.infer<
                  typeof ExpandPlanPlus
                >;
                batchData[i].finalResult = finalBatchResult;
              }
            }

            if (finalBatchResult) {
              expandPlans.push(finalBatchResult);
            }
          }

          merged = await mergeExpandPlans(expandPlans);
          if (!merged || !merged.categories || !merged.assignments) {
            throw new Error(
              'mergeExpandPlans failed to return valid merged data'
            );
          }
          graftSummariesIntoFeatures(repoFeatures, merged.summaries);
        } catch (e: any) {
          e.message = `[PASS-1] ${e.message}`;
          throw e;
        }

        // Pass-1b: Refinement step to split oversized/mixed categories
        setAiPhase('pass1');
        // reuse Pass-2 policies defined below; compute local refine policies here
        try {
          const refinePolicies = {
            maxCategories: parseInt(process.env.NEBULA_MAX_CATEGORIES || '100'),
          };
          const refineGen = aiPass1BRefineCategories(
            repoFeatures,
            merged,
            refinePolicies
          );
          let finalRefined: any = null;
          for await (const partial of refineGen) {
            finalRefined = partial as any;
            setStreamingData({
              phase: 'pass1',
              partialResult: finalRefined,
              categoriesCount: finalRefined?.categories?.length || 0,
              summariesCount: finalRefined?.summaries?.length || 0,
              assignmentsCount: finalRefined?.assignments?.length || 0,
            });
          }
          if (
            finalRefined &&
            finalRefined.categories &&
            finalRefined.assignments
          ) {
            merged = await mergeExpandPlans([merged, finalRefined]);
            graftSummariesIntoFeatures(repoFeatures, merged.summaries);
          }
        } catch (e: any) {
          // Non-fatal: continue with existing merged
        }

        // Pass 2: Streamline with streaming
        setAiPhase('pass2');
        let finalStreamlined: z.infer<typeof StreamlinedPlan> | null = null;
        const policies = {
          minCategorySize: parseInt(process.env.NEBULA_MIN_CAT_SIZE || '1'),
          maxCategories: parseInt(process.env.NEBULA_MAX_CATEGORIES || '100'),
          max_new_categories: parseInt(
            process.env.NEBULA_MAX_NEW_CATEGORIES || '50'
          ),
        };
        try {
          const streamlinedGenerator = aiPass2StreamlineStreaming(
            repoFeatures,
            merged,
            policies
          );

          let pass2StreamCount = 0;
          let lastCompleteResult: z.infer<typeof StreamlinedPlan> | null = null;

          for await (const partialResult of streamlinedGenerator) {
            pass2StreamCount++;

            // Update streaming data for UI
            setStreamingData({
              phase: 'pass2',
              partialResult,
              categoriesCount: partialResult.categories?.length || 0,
              aliasesCount: partialResult.aliases
                ? Object.keys(partialResult.aliases).length
                : 0,
              reposCount: partialResult.repos?.length || 0,
            });

            // Only update final result if this partial has the required structure
            if (partialResult && typeof partialResult === 'object') {
              lastCompleteResult = partialResult as z.infer<
                typeof StreamlinedPlan
              >;
            }
          }

          // Use the last complete result if available, otherwise the final partial
          finalStreamlined = lastCompleteResult || finalStreamlined;

          // Fallback: if we still don't have a proper result, create a minimal one
          if (
            !finalStreamlined ||
            !finalStreamlined.repos ||
            finalStreamlined.repos.length === 0
          ) {
            console.warn(
              'Pass-2 did not return repos, creating fallback structure'
            );

            // Try to create fallback repos from merged assignments
            let fallbackRepos: any[] = [];
            if (merged && merged.assignments && merged.assignments.length > 0) {
              fallbackRepos = merged.assignments.map((assignment: any) => ({
                id: assignment.repo,
                primaryCategory:
                  assignment.categories?.[0]?.key || 'uncategorized',
                reason:
                  assignment.categories?.[0]?.reason || 'Fallback assignment',
                tags: assignment.categories?.[0]?.tags || [],
                confidence: 0.5,
              }));
            }

            finalStreamlined = {
              categories: merged?.categories || [],
              aliases: {},
              repos: fallbackRepos,
            };
          }

          // Ensure all repositories are assigned (no missing repos)
          try {
            const assigned = new Set(
              (finalStreamlined?.repos || []).map((r: any) => r.id)
            );
            const missing = repoFeatures.filter((f) => !assigned.has(f.id));
            if (missing.length > 0) {
              // Determine dominant category among already-assigned repos
              const freq = new Map<string, number>();
              for (const r of finalStreamlined.repos as any[]) {
                const slug = slugify(r.primaryCategory || '', {
                  lower: true,
                  strict: true,
                  trim: true,
                });
                if (!slug) continue;
                freq.set(slug, (freq.get(slug) || 0) + 1);
              }
              let dominantSlug = '';
              let dominantCount = -1;
              for (const [slug, n] of freq) {
                if (n > dominantCount) {
                  dominantSlug = slug;
                  dominantCount = n;
                }
              }
              // If none yet, prefer a common canonical category if proposed
              if (!dominantSlug && merged?.categories?.length) {
                const preferred = merged.categories.find(
                  (c: any) =>
                    slugify(c.slug || c.title || '', {
                      lower: true,
                      strict: true,
                      trim: true,
                    }) === 'libraries'
                );
                dominantSlug = preferred
                  ? 'libraries'
                  : slugify(
                      merged.categories[0].slug ||
                        merged.categories[0].title ||
                        'libraries',
                      {
                        lower: true,
                        strict: true,
                        trim: true,
                      }
                    );
              }

              const mergedAssignIndex: Record<string, string> = {};
              if (merged && Array.isArray(merged.assignments)) {
                for (const a of merged.assignments) {
                  if (a?.repo && a?.categories?.[0]?.key) {
                    mergedAssignIndex[a.repo] = slugify(a.categories[0].key, {
                      lower: true,
                      strict: true,
                      trim: true,
                    });
                  }
                }
              }

              for (const m of missing) {
                const inferred =
                  mergedAssignIndex[m.id] || dominantSlug || 'libraries';
                (finalStreamlined.repos as any[]).push({
                  id: m.id,
                  primaryCategory: inferred,
                  reason: 'Auto-filled to ensure full coverage',
                  tags: [],
                  confidence: 0.5,
                });
              }
            }
          } catch {}
        } catch (e: any) {
          e.message = `[PASS-2] ${e.message}`;
          throw e;
        }

        const store = makeStoreFromStreamlined(repoFeatures, finalStreamlined);

        // Pass 2.5: Category budget consolidation
        setAiPhase('pass2');
        try {
          const budget = {
            min: parseInt(process.env.NEBULA_CAT_TARGET_MIN || '22'),
            max: parseInt(process.env.NEBULA_CAT_TARGET_MAX || '36'),
          };
          const budgetGen = aiPass25BudgetConsolidate(
            store,
            repoFeatures,
            budget
          );
          let budgetFix: any = null;
          for await (const partial of budgetGen) {
            budgetFix = partial as any;
            setStreamingData({
              phase: 'pass2',
              partialResult: budgetFix,
              categoriesCount: budgetFix?.categories?.length || 0,
              aliasesCount: budgetFix?.aliases
                ? Object.keys(budgetFix.aliases).length
                : 0,
              reassignCount: budgetFix?.reassign?.length || 0,
            });
          }
          if (budgetFix) {
            applyQaFix(store, budgetFix);
          }
        } catch (e) {
          // proceed regardless
        }

        // Pass 3: Quality Assurance with streaming
        setAiPhase('pass3');
        let finalQaFix: z.infer<typeof QaFix> | null = null;
        try {
          const qaGenerator = aiPass3QualityAssuranceStreaming(
            store,
            repoFeatures,
            policies
          );

          let pass3StreamCount = 0;
          for await (const partialResult of qaGenerator) {
            pass3StreamCount++;
            // Update streaming data for UI
            setStreamingData({
              phase: 'pass3',
              partialResult,
              categoriesCount: partialResult.categories?.length || 0,
              aliasesCount: partialResult.aliases
                ? Object.keys(partialResult.aliases).length
                : 0,
              deleteCount: partialResult.delete?.length || 0,
              reassignCount: partialResult.reassign?.length || 0,
            });
            // Always update final result with the latest partial
            finalQaFix = partialResult as z.infer<typeof QaFix>;
          }

          if (!finalQaFix) {
            throw new Error('Pass 3 failed to generate result');
          }

          applyQaFix(store, finalQaFix);

          // Absorb QA aliases back into glossary for future runs
          await absorbAliasesIntoGlossary(finalQaFix);
        } catch (e: any) {
          e.message = `[PASS-3] ${e.message}`;
          throw e;
        }

        // Backfill categories from index to ensure all indexed repos appear in README
        backfillCategoriesFromIndex(store, repoFeatures);

        // Final signal backfill to prevent empty summaries/capabilities
        ensureMinimumFeatureSignals(repoFeatures);

        // Write artifacts
        await fs.mkdir('data', { recursive: true });
        await fs.writeFile(
          'data/stars.json',
          JSON.stringify(repoFeatures, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          'data/nebula.json',
          JSON.stringify(store, null, 2),
          'utf-8'
        );
        const md = renderReadme(store, repoFeatures, NEBULA_README_MIN_SIZE);
        await fs.writeFile(outputFilename, md, 'utf-8');

        setCurrentPhase('complete');
        onFinish(store);
      } catch (error) {
        console.error('Processing error:', error);
        setCurrentPhase('complete');
      }
    };

    processEverything();
  }, [stars, maxRepos, token, onFinish]);

  // Render different UI based on current phase
  if (currentPhase === 'fetching') {
    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="blue" bold>
          🚀 Nebula – Fetching Repository Data
        </Text>
        <Newline />
        <ProgressBar
          current={currentStep}
          total={totalSteps}
          width={Math.min(40, contentWidth - 10)}
        />
        {processedRepos.slice(-3).map((p, i) => (
          <Box key={i}>
            <Text color="green">{p.repo.full_name}</Text>
            {p.details && (
              <Text color="gray"> ({p.details.stargazers_count} ⭐)</Text>
            )}
          </Box>
        ))}
        {currentStep < totalSteps && (
          <Box>
            <Spinner type="dots" />
            <Text color="cyan">
              {' '}
              Processing: {stars[currentStep]?.full_name}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  if (currentPhase === 'ai-processing') {
    const currentBatchData = allBatchesData[selectedBatchIndex];
    const isViewingCurrentBatch = selectedBatchIndex === currentBatch - 1;

    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="blue" bold>
          🤖 Nebula – AI Processing Phase{' '}
          {aiPhase === 'pass0' ? 'PASS-0 (Facts)' : aiPhase?.toUpperCase()}
        </Text>
        <Newline />

        {/* Batch Navigation - only show for Pass 1 */}
        {allBatchesData.length > 1 && aiPhase === 'pass1' && (
          <Box justifyContent="space-between" marginBottom={1}>
            <Text color="cyan">
              ←/h Prev • Batch {selectedBatchIndex + 1}/{allBatchesData.length}{' '}
              • Next →/l
            </Text>
            <Text color="gray" dimColor>
              {isViewingCurrentBatch ? '🔴 Live' : '⚪ Past'}
            </Text>
          </Box>
        )}

        {aiPhase === 'pass0' && (
          <>
            <Text color="cyan">
              Pass-0: Extracting factual signals from repository READMEs
            </Text>
            <Newline />
            {streamingData && streamingData.phase === 'pass0' && (
              <Box flexDirection="column">
                <Text color="yellow" bold>
                  🔴 Live Facts Extraction:
                </Text>
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color="green">
                    Repositories Processed: {streamingData.factsCount || 0}
                  </Text>
                </Box>
                {streamingData.partialResult?.results &&
                  streamingData.partialResult.results.length > 0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Text color="cyan" bold>
                        Latest Facts Extracted:
                      </Text>
                      {streamingData.partialResult.results
                        .slice(-3) // Show last 3 results
                        .map((result: any, idx: number) => (
                          <Box key={idx} flexDirection="column" paddingLeft={2}>
                            <Text color="magenta" bold>
                              • {result.id?.split('/').pop() || 'Unknown'}
                            </Text>
                            <Text color="gray">
                              Purpose: {result.purpose?.slice(0, 50) || 'None'}
                              ...
                            </Text>
                            <Text color="gray">
                              Capabilities:{' '}
                              {(result.capabilities || [])
                                .slice(0, 2)
                                .join(', ')}
                              {(result.capabilities || []).length > 2
                                ? '...'
                                : ''}
                            </Text>
                          </Box>
                        ))}
                    </Box>
                  )}
              </Box>
            )}
            {!streamingData || streamingData.phase !== 'pass0' ? (
              <Text color="green">
                Processing {features.length} repositories for facts
                extraction...
              </Text>
            ) : null}
          </>
        )}

        {aiPhase === 'pass1' && currentBatchData && (
          <>
            <Text color="cyan">
              Batch {currentBatchData.batchNumber}: Analyzing{' '}
              {currentBatchData.repositories.length} repositories
            </Text>
            <Newline />

            {/* Repository List */}
            <Box flexDirection="column" marginBottom={1}>
              <Text color="yellow" bold>
                Repositories in this batch:
              </Text>
              {currentBatchData.repositories
                .slice(0, 5)
                .map((repo: any, idx: number) => (
                  <Text key={idx} color="gray">
                    • {repo.name} ({repo.language || 'Unknown'}, {repo.stars}{' '}
                    ⭐)
                  </Text>
                ))}
              {currentBatchData.repositories.length > 5 && (
                <Text color="gray" dimColor>
                  ... and {currentBatchData.repositories.length - 5} more
                </Text>
              )}
            </Box>

            {/* Live Streaming Data */}
            {isViewingCurrentBatch && streamingData && (
              <Box flexDirection="column">
                <Text color="yellow" bold>
                  🔴 Live AI Analysis:
                </Text>

                {/* Current Progress */}
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color="green">
                    Categories:{' '}
                    {streamingData.partialResult?.categories?.length || 0}
                  </Text>
                  <Text color="green">
                    Summaries:{' '}
                    {streamingData.partialResult?.summaries?.length || 0}
                  </Text>
                  <Text color="green">
                    Assignments:{' '}
                    {streamingData.partialResult?.assignments?.length || 0}
                  </Text>
                </Box>

                {/* Categories Preview */}
                {streamingData.partialResult?.categories &&
                  streamingData.partialResult.categories.length > 0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Text color="cyan" bold>
                        Latest Categories:
                      </Text>
                      {streamingData.partialResult.categories
                        .slice(-3) // Show last 3 categories
                        .map((cat: any, idx: number) => (
                          <Box key={idx} flexDirection="column" paddingLeft={2}>
                            <Text color="blue" bold>
                              • {cat.title}
                            </Text>
                            {cat.description && (
                              <Text color="gray" dimColor>
                                {cat.description.slice(0, 60)}...
                              </Text>
                            )}
                          </Box>
                        ))}
                    </Box>
                  )}

                {/* Summaries Preview */}
                {streamingData.partialResult?.summaries &&
                  streamingData.partialResult.summaries.length > 0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Text color="cyan" bold>
                        Latest Summaries:
                      </Text>
                      {streamingData.partialResult.summaries
                        .slice(-2) // Show last 2 summaries
                        .filter(
                          (summary: any) =>
                            summary && summary.id && summary.summary
                        )
                        .map((summary: any, idx: number) => (
                          <Box key={idx} flexDirection="column" paddingLeft={2}>
                            <Text color="magenta" bold>
                              • {summary.id?.split('/').pop() || 'Unknown'}
                            </Text>
                            <Text color="white">
                              {summary.summary?.slice(0, 80) ||
                                'No summary available'}
                              ...
                            </Text>
                          </Box>
                        ))}
                    </Box>
                  )}
              </Box>
            )}

            {/* Historical Batch Data */}
            {!isViewingCurrentBatch &&
              currentBatchData.streamingHistory.length > 0 && (
                <Box flexDirection="column">
                  <Text color="yellow" bold>
                    ⚪ Completed Analysis:
                  </Text>

                  <Box flexDirection="column" paddingLeft={2}>
                    <Text color="green">
                      Final Categories:{' '}
                      {currentBatchData.finalResult?.categories?.length || 0}
                    </Text>
                    <Text color="green">
                      Final Summaries:{' '}
                      {currentBatchData.finalResult?.summaries?.length || 0}
                    </Text>
                  </Box>

                  {/* Show final results for completed batches */}
                  {currentBatchData.finalResult?.categories && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Text color="cyan" bold>
                        Categories Created:
                      </Text>
                      {currentBatchData.finalResult.categories
                        .slice(0, 5)
                        .map((cat: any, idx: number) => (
                          <Text key={idx} color="blue">
                            • {cat.title}
                          </Text>
                        ))}
                    </Box>
                  )}
                </Box>
              )}
          </>
        )}

        {aiPhase === 'pass2' && (
          <>
            <Text color="cyan">
              Pass 2: Streamlining categories and assignments
            </Text>
            <Newline />
            {streamingData && (
              <Box flexDirection="column">
                <Text color="yellow" bold>
                  🔄 Live Streamlining:
                </Text>
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color="green">
                    Categories: {streamingData.categoriesCount || 0}
                  </Text>
                  <Text color="green">
                    Aliases: {streamingData.aliasesCount || 0}
                  </Text>
                  <Text color="green">
                    Repos Assigned: {streamingData.reposCount || 0}
                  </Text>
                </Box>
                {streamingData.partialResult?.categories && (
                  <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                    <Text color="cyan" bold>
                      Categories Being Streamlined:
                    </Text>
                    {streamingData.partialResult.categories
                      .slice(0, 5)
                      .map((cat: any, idx: number) => (
                        <Text key={idx} color="blue">
                          • {cat.title}
                        </Text>
                      ))}
                  </Box>
                )}
              </Box>
            )}
          </>
        )}

        {aiPhase === 'pass3' && (
          <>
            <Text color="cyan">Pass 3: Quality assurance and optimization</Text>
            <Newline />
            {streamingData && (
              <Box flexDirection="column">
                <Text color="yellow" bold>
                  🔍 Live QA Analysis:
                </Text>
                <Box flexDirection="column" paddingLeft={2}>
                  <Text color="green">
                    Categories Analyzed: {streamingData.categoriesCount || 0}
                  </Text>
                  <Text color="green">
                    Aliases Found: {streamingData.aliasesCount || 0}
                  </Text>
                  <Text color="green">
                    Categories to Delete: {streamingData.deleteCount || 0}
                  </Text>
                  <Text color="green">
                    Repos to Reassign: {streamingData.reassignCount || 0}
                  </Text>
                </Box>
                {streamingData.partialResult?.aliases &&
                  Object.keys(streamingData.partialResult.aliases).length >
                    0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Text color="cyan" bold>
                        Category Aliases:
                      </Text>
                      {Object.entries(streamingData.partialResult.aliases || {})
                        .slice(0, 3)
                        .map(([alias, canonical], idx) => {
                          // Handle different types of canonical values
                          let displayValue = 'unknown';
                          if (
                            typeof canonical === 'string' &&
                            canonical.trim()
                          ) {
                            displayValue = canonical;
                          } else if (
                            canonical &&
                            typeof canonical === 'object' &&
                            canonical !== null &&
                            'slug' in canonical &&
                            typeof (canonical as any).slug === 'string'
                          ) {
                            displayValue = (canonical as any).slug;
                          } else if (
                            canonical &&
                            typeof canonical === 'object' &&
                            canonical !== null &&
                            'title' in canonical &&
                            typeof (canonical as any).title === 'string'
                          ) {
                            displayValue = (canonical as any).title;
                          } else if (
                            canonical !== null &&
                            canonical !== undefined
                          ) {
                            displayValue = String(canonical);
                          }
                          return (
                            <Text key={idx} color="magenta">
                              • {alias} → {displayValue}
                            </Text>
                          );
                        })}
                    </Box>
                  )}
              </Box>
            )}
          </>
        )}

        <Newline />
        {isViewingCurrentBatch && totalBatches > 0 && (
          <>
            <Spinner type="dots" />
            <Text color="cyan">
              {' '}
              Processing batch {currentBatch} of {totalBatches}...
            </Text>
          </>
        )}
        {!isViewingCurrentBatch && totalBatches > 0 && (
          <Text color="gray" dimColor>
            Viewing completed batch {selectedBatchIndex + 1} of {totalBatches}
          </Text>
        )}

        {/* Navigation Help */}
        {allBatchesData.length > 1 && aiPhase === 'pass1' && (
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Use ←→ or h/l keys to navigate between batches • Q to quit
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="blue" bold>
        🎉 Nebula – Processing Complete!
      </Text>
      <Newline />
      <Text color="green">
        ✅ All processing complete! Check data/ and {outputFilename}
      </Text>
      <Text color="gray" dimColor>
        Press Q to quit
      </Text>
    </Box>
  );
};

// ----------------------------------- CLI -----------------------------------
const main = Effect.gen(function* () {
  const [, , ...args] = process.argv;

  // Parse command-line arguments
  let outputFilename = 'AWESOME.md';
  let cmd = args[0];

  // Check for --name parameter
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && i + 1 < args.length) {
      outputFilename = args[i + 1]!;
      // Remove --name and its value from args for further processing
      args.splice(i, 2);
      cmd = args[0];
      break;
    }
  }

  if (cmd === 'logout') {
    yield* removeToken;
    console.log('🗑️  Removed saved token.');
    return;
  }

  // Get authenticated token using the abstracted utility
  const token = yield* ensureAuthenticatedToken({
    interactive: cmd === 'login' || !cmd,
    forceLogin: cmd === 'login',
  });

  const me = yield* whoAmI(token);
  if (me) console.log(`\n⭐ Starred repos for @${me.login}\n`);

  const stars = yield* listStarred(token);
  if (stars.length === 0) {
    console.log('No starred repositories found.');
    return;
  }

  const { waitUntilExit } = render(
    <NebulaStreamingApp
      stars={stars}
      maxRepos={MAX_REPOS_TO_PROCESS}
      token={token}
      outputFilename={outputFilename}
      onFinish={(_store) => {
        Effect.runPromise(
          Console.log(
            `\n✅ All processing complete! Wrote data/nebula.json and ${outputFilename}`
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
