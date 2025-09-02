import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { Effect, Console, Layer, ConfigProvider } from 'effect';
import * as fs from 'node:fs/promises';
import { z } from 'zod';
import slugify from 'slugify';
import { gateway } from '@ai-sdk/gateway';

// Environment variables are loaded by the wrapper script
import { ensureAuthenticatedToken, removeToken, whoAmI } from './lib/auth';
import {
  getRepoDetails,
  getRepoReadme,
  type DetailedRepo,
  type StarredRepo,
} from './lib/github';
import { batch, daysSince } from './lib/utils';
import { MAX_REPOS_TO_PROCESS, CONSTELLATE_MODEL } from './lib/config';
import {
  RepoFeature,
  ConstellateStore,
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

// Configuration options for interactive setup
interface ConfigOption {
  key: string;
  label: string;
  defaultValue: string;
  description: string;
  isRequired?: boolean;
  isSecret?: boolean;
  type?: 'text' | 'model-select';
}

const CONFIG_OPTIONS: ConfigOption[] = [
  {
    key: 'CONSTELLATE_MAX_REPOS',
    label: 'Maximum Repositories to Process',
    defaultValue: String(MAX_REPOS_TO_PROCESS),
    description:
      'How many starred repositories to analyze (higher = more comprehensive but slower)',
    type: 'text',
  },
  {
    key: 'CONSTELLATE_MODEL',
    label: 'AI Model',
    defaultValue: String(CONSTELLATE_MODEL),
    description: 'AI model for processing (affects quality and speed)',
    type: 'model-select',
  },
];

// Model Selection Component
const ModelSelector: React.FC<{
  onModelSelect: (modelId: string) => void;
  currentValue: string;
  onCancel: () => void;
}> = ({ onModelSelect, currentValue, onCancel }) => {
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectionStep, setSelectionStep] = useState<'provider' | 'model'>(
    'provider'
  );
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        const result = await gateway.getAvailableModels();
        const languageModels = result.models.filter(
          (m: any) => m.modelType === 'language'
        );
        setAvailableModels(languageModels);

        // Extract unique providers - try different field names
        const uniqueProviders = [
          ...new Set(
            languageModels.map((m: any) => {
              // Try different possible provider field names
              return (
                m.provider ||
                m.providerName ||
                m.company ||
                m.vendor ||
                (m.id && m.id.includes('/') ? m.id.split('/')[0] : 'Unknown')
              );
            })
          ),
        ].filter((p) => p !== 'Unknown');

        // If no providers found through fields, try extracting from model IDs
        let finalProviders = uniqueProviders;
        if (finalProviders.length === 0) {
          finalProviders = [
            ...new Set(
              languageModels.map((m: any) =>
                m.id && m.id.includes('/') ? m.id.split('/')[0] : 'Unknown'
              )
            ),
          ].filter((p) => p !== 'Unknown');
        }

        setProviders(finalProviders.sort());

        // If current model is selected, pre-select its provider but stay in provider selection
        const currentModel = languageModels.find(
          (m: any) => m.id === currentValue
        );
        if (currentModel) {
          const currentProvider =
            currentModel.id && currentModel.id.includes('/')
              ? currentModel.id.split('/')[0]
              : 'Unknown';
          if (
            currentProvider !== 'Unknown' &&
            finalProviders.includes(currentProvider)
          ) {
            // Pre-select the current provider but stay in provider selection step
            const providerIndex = finalProviders.indexOf(currentProvider);
            if (providerIndex >= 0) {
              setSelectedIndex(providerIndex);
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch models');
      } finally {
        setLoading(false);
      }
    };

    fetchModels();
  }, [currentValue]);

  useInput((input, key) => {
    if (loading) return;

    if (key.upArrow || input === 'k') {
      const maxIndex =
        selectionStep === 'provider'
          ? providers.length - 1
          : filteredModels.length - 1;
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow || input === 'j') {
      const maxIndex =
        selectionStep === 'provider'
          ? providers.length - 1
          : filteredModels.length - 1;
      setSelectedIndex((prev) => Math.min(maxIndex, prev + 1));
    } else if (key.return) {
      if (selectionStep === 'provider') {
        // Select provider and move to model selection
        const selectedProviderName = providers[selectedIndex];
        setSelectedProvider(selectedProviderName || '');
        setSelectionStep('model');
        setSelectedIndex(0);
      } else {
        // Select model
        if (filteredModels[selectedIndex]) {
          onModelSelect(filteredModels[selectedIndex].id);
        }
      }
    } else if (
      (input === 'd' || input === 's') &&
      selectionStep === 'provider'
    ) {
      // Use default model directly from provider selection
      onModelSelect(currentValue);
    } else if ((input === 'd' || input === 's') && selectionStep === 'model') {
      // Select default model - check if it's in current filtered list first
      const defaultModel = filteredModels.find(
        (m: any) => m.id === currentValue
      );
      if (defaultModel) {
        const defaultIndex = filteredModels.indexOf(defaultModel);
        setSelectedIndex(defaultIndex);
        onModelSelect(currentValue);
      } else {
        // If default model is not in current provider, just use it directly
        onModelSelect(currentValue);
      }
    } else if (key.escape) {
      // Always go back to the configuration step, not restart config
      onCancel();
    } else if (input === 'b' && selectionStep === 'model') {
      // Go back to provider selection within model selector
      setSelectionStep('provider');
      setSelectedIndex(providers.indexOf(selectedProvider || ''));
    }
  });

  // Filter models by selected provider
  const filteredModels = selectedProvider
    ? availableModels.filter((m: any) => {
        const modelProvider =
          m.provider ||
          m.providerName ||
          m.company ||
          m.vendor ||
          (m.id && m.id.includes('/') ? m.id.split('/')[0] : 'Unknown');
        return modelProvider === selectedProvider;
      })
    : [];

  // Helper function to format pricing per million tokens
  const formatPricePerMillion = (pricePerToken: number): string => {
    return (pricePerToken * 1000000).toFixed(2);
  };

  if (loading) {
    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="cyan">Loading available models...</Text>
        <Spinner type="dots" />
        <Text color="gray" dimColor>
          Press ESC to return to configuration
        </Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="red">Error loading models: {error}</Text>
        <Text color="gray">Press ESC to return to configuration</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="yellow" bold>
        {selectionStep === 'provider'
          ? 'Select Provider'
          : `Select Model from ${selectedProvider}`}
      </Text>
      <Text color="gray" dimColor>
        {selectionStep === 'provider'
          ? '↑↓ to navigate, ENTER to select, S/D for default (if available), ESC to go back'
          : '↑↓ to navigate, ENTER to select, S/D for default, ESC to go back, B for providers'}
      </Text>
      {selectionStep === 'provider' && (
        <Text color="cyan" dimColor>
          💡 Tip: Select your AI provider, then choose your preferred model
        </Text>
      )}
      {selectionStep === 'model' && (
        <Text color="cyan" dimColor>
          💡 Tip: Press S or D to use default model, or browse available models
        </Text>
      )}
      <Newline />

      {selectionStep === 'provider' ? (
        // Provider Selection
        <Box flexDirection="column">
          <Text color="cyan" bold>
            Available Providers:
          </Text>
          {providers.map((provider, index) => {
            const providerModels = availableModels.filter((m: any) => {
              const modelProvider =
                m.provider ||
                m.providerName ||
                m.company ||
                m.vendor ||
                (m.id && m.id.includes('/') ? m.id.split('/')[0] : 'Unknown');
              return modelProvider === provider;
            });
            return (
              <Text
                key={provider}
                color={index === selectedIndex ? 'green' : 'gray'}
              >
                {index === selectedIndex ? '→ ' : '  '}
                {provider} ({providerModels.length} models)
              </Text>
            );
          })}
        </Box>
      ) : (
        // Model Selection
        <>
          {filteredModels[selectedIndex] && (
            <Box flexDirection="column" paddingX={2} marginBottom={1}>
              <Text color="green" bold>
                {filteredModels[selectedIndex].name ||
                  filteredModels[selectedIndex].id}
              </Text>
              {filteredModels[selectedIndex].description && (
                <Text color="gray" dimColor>
                  {filteredModels[selectedIndex].description}
                </Text>
              )}
              {filteredModels[selectedIndex].pricing && (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="cyan" bold>
                    Pricing (per million tokens):
                  </Text>
                  <Text color="white">
                    Input: $
                    {formatPricePerMillion(
                      filteredModels[selectedIndex].pricing.input
                    )}
                  </Text>
                  <Text color="white">
                    Output: $
                    {formatPricePerMillion(
                      filteredModels[selectedIndex].pricing.output
                    )}
                  </Text>
                  {filteredModels[selectedIndex].pricing.cachedInputTokens && (
                    <Text color="white">
                      Cached Input: $
                      {formatPricePerMillion(
                        filteredModels[selectedIndex].pricing.cachedInputTokens
                      )}
                    </Text>
                  )}
                  {filteredModels[selectedIndex].pricing
                    .cacheCreationInputTokens && (
                    <Text color="white">
                      Cache Creation: $
                      {formatPricePerMillion(
                        filteredModels[selectedIndex].pricing
                          .cacheCreationInputTokens
                      )}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan" bold>
              Models from {selectedProvider}:
            </Text>
            {filteredModels.map((model, index) => (
              <Text
                key={model.id}
                color={index === selectedIndex ? 'green' : 'gray'}
              >
                {index === selectedIndex ? '→ ' : '  '}
                {model.name || model.id}
                {model.pricing && (
                  <Text color="magenta">
                    {' '}
                    (${formatPricePerMillion(model.pricing.input)}/$
                    {formatPricePerMillion(model.pricing.output)})
                  </Text>
                )}
              </Text>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
};

// Interactive Configuration Component
const InteractiveConfigApp: React.FC<{
  onConfigComplete: (config: Record<string, string>) => void;
}> = ({ onConfigComplete }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [inputValue, setInputValue] = useState('');
  const [showInput, setShowInput] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  const currentOption = CONFIG_OPTIONS[currentIndex];

  // Guard against invalid index
  if (!currentOption) {
    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="red">Error: Invalid configuration option index</Text>
      </Box>
    );
  }

  useInput((input, key) => {
    if (key.return) {
      if (currentOption.type === 'model-select' && !showInput) {
        setShowModelSelector(true);
      } else if (showInput) {
        // Save current input and move to next
        const newConfig = {
          ...configValues,
          [currentOption.key]: inputValue || currentOption.defaultValue,
        };
        setConfigValues(newConfig);
        setInputValue('');

        if (currentIndex < CONFIG_OPTIONS.length - 1) {
          setCurrentIndex(currentIndex + 1);
          setShowInput(false);
        } else {
          // Configuration complete
          onConfigComplete(newConfig);
        }
      } else {
        setShowInput(true);
        setInputValue(currentOption.defaultValue);
      }
    } else if (input === 's' && !showInput) {
      // Skip to default for any option
      const newConfig = {
        ...configValues,
        [currentOption.key]: currentOption.defaultValue,
      };
      setConfigValues(newConfig);

      if (currentIndex < CONFIG_OPTIONS.length - 1) {
        setCurrentIndex(currentIndex + 1);
        setShowInput(false);
      } else {
        onConfigComplete(newConfig);
      }
    } else if (key.escape) {
      // Go back to previous option
      if (currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
        setShowInput(false);
        setShowModelSelector(false);
        setInputValue('');
      }
    }
  });

  const progress = ((currentIndex + 1) / CONFIG_OPTIONS.length) * 100;

  // Show model selector if active
  if (showModelSelector && currentOption.type === 'model-select') {
    return (
      <ModelSelector
        onModelSelect={(modelId) => {
          const newConfig = {
            ...configValues,
            [currentOption.key]: modelId,
          };
          setConfigValues(newConfig);
          setShowModelSelector(false);

          if (currentIndex < CONFIG_OPTIONS.length - 1) {
            setCurrentIndex(currentIndex + 1);
          } else {
            onConfigComplete(newConfig);
          }
        }}
        currentValue={
          configValues[currentOption.key] || currentOption.defaultValue
        }
        onCancel={() => setShowModelSelector(false)}
      />
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="blue" bold>
        ⚙️ Constellate Configuration Setup
      </Text>
      <Newline />

      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan">
          Progress: {currentIndex + 1} of {CONFIG_OPTIONS.length} settings
        </Text>
        <Text color="green">
          █{'█'.repeat(Math.floor(progress / 5))}
          {'░'.repeat(20 - Math.floor(progress / 5))} {Math.round(progress)}%
        </Text>
      </Box>

      <Newline />

      <Box flexDirection="column" paddingX={2}>
        <Text color="yellow" bold>
          {currentOption.label}
        </Text>
        <Text color="gray" dimColor>
          {currentOption.description}
        </Text>
        <Newline />

        {!showInput ? (
          <Box flexDirection="column">
            <Text color="green">
              Current:{' '}
              {currentOption.isSecret
                ? '••••••••'
                : configValues[currentOption.key] || currentOption.defaultValue}
            </Text>
            <Newline />
            <Text color="cyan">
              {currentOption.type === 'model-select'
                ? 'Press ENTER to browse models • Press S to use default • ESC to go back'
                : 'Press ENTER to customize • Press S to use default • ESC to go back'}
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color="cyan">Enter value (or press ENTER for default):</Text>
            <Box>
              <Text color="green">{'> '}</Text>
              <TextInput
                value={inputValue}
                onChange={setInputValue}
                mask={currentOption.isSecret ? '*' : undefined}
                placeholder={currentOption.defaultValue}
              />
            </Box>
            <Text color="gray" dimColor>
              Press ENTER to confirm
            </Text>
          </Box>
        )}
      </Box>

      <Newline />
      <Text color="gray" dimColor>
        Tip: You can re-run this setup anytime with 'constellate config'
      </Text>
    </Box>
  );
};

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
): ConstellateStore {
  const store = ConstellateStore.parse({
    generated_at: new Date().toISOString(),
  });

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
  store: ConstellateStore,
  features: RepoFeature[],
  minSize = 0
): string {
  const lines: string[] = [];
  lines.push('# Awesome – Generated by Constellate');
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

// Component for fetching starred repos with progress indication
const StarFetchingApp: React.FC<{
  token: string;
  maxRepos: number;
  outputFilename: string;
  username?: string;
  onStarsFetched: (stars: StarredRepo[]) => void;
}> = ({ token, maxRepos, username, onStarsFetched }) => {
  const [fetchingPhase, setFetchingPhase] = useState<
    'connecting' | 'fetching' | 'complete'
  >('connecting');
  const [starsFetched, setStarsFetched] = useState(0);
  const [totalStars, setTotalStars] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [recentStars, setRecentStars] = useState<StarredRepo[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  // Handle keyboard input for quitting
  useInput((input, key) => {
    if (input === 'q') {
      console.log('\n👋 Exiting Constellate...');
      process.exit(0);
    }
  });

  useEffect(() => {
    const fetchStarsWithProgress = async () => {
      try {
        const allStars: StarredRepo[] = [];
        let url = 'https://api.github.com/user/starred?per_page=200';
        let batchCount = 0;

        setFetchingPhase('fetching');

        while (url && allStars.length < maxRepos) {
          batchCount++;
          setCurrentBatch(batchCount);

          const response = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'constellate',
            },
          });

          if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status}`);
          }

          const batch = (await response.json()) as any[];
          const processedBatch: StarredRepo[] = batch.map((repo) => ({
            full_name: repo.full_name,
            description: repo.description,
            html_url: repo.html_url,
            stargazers_count: repo.stargazers_count,
            language: repo.language,
          }));

          // Only add repositories up to the limit
          const remaining = maxRepos - allStars.length;
          const reposToAdd = processedBatch.slice(0, remaining);
          allStars.push(...reposToAdd);

          setStarsFetched(allStars.length);
          setRecentStars(reposToAdd.slice(0, 3)); // Show last 3 from current batch

          // Update progress display - show current count and indicate we're still fetching
          setTotalStars(allStars.length); // Show current count as we fetch

          // Stop if we've reached the limit
          if (allStars.length >= maxRepos) {
            break;
          }

          // Get next page URL from Link header
          const linkHeader = response.headers.get('link');
          const nextMatch = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
          url = nextMatch?.[1] ?? '';

          // Add a small delay to avoid overwhelming the API and UI
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        setFetchingPhase('complete');
        setStarsFetched(allStars.length);
        setTotalStars(allStars.length); // Final accurate count
        setIsComplete(true);

        // Small delay to show completion
        setTimeout(() => {
          onStarsFetched(allStars.slice(0, maxRepos));
        }, 500);
      } catch (error) {
        console.error('Error fetching starred repositories:', error);
        setFetchingPhase('complete');
      }
    };

    fetchStarsWithProgress();
  }, [token, maxRepos, onStarsFetched]);

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="blue" bold>
        ⭐ Constellate – Fetching {username ? `@${username}'s ` : 'Your '}
        Starred Repositories
      </Text>
      <Newline />

      {fetchingPhase === 'connecting' && (
        <>
          <Text color="cyan">🔗 Connecting to GitHub...</Text>
          <Newline />
          <Spinner type="dots" />
        </>
      )}

      {fetchingPhase === 'fetching' && (
        <>
          <Text color="cyan">
            📥 Fetching starred repositories from GitHub...
          </Text>
          <Newline />

          <Box flexDirection="column" marginBottom={1}>
            <Text color="yellow">
              Progress: {starsFetched} repositories fetched
              {isComplete &&
                starsFetched >= maxRepos &&
                ` (limit reached: ${maxRepos})`}
              {isComplete && starsFetched < maxRepos && ' (complete)'}
            </Text>

            <ProgressBar
              current={isComplete ? 10 : currentBatch % 10} // Show full progress when complete
              total={10} // Keep it simple and animated
              width={Math.min(40, contentWidth - 10)}
            />
          </Box>

          <Text color="gray" dimColor>
            Batch {currentBatch} • Press Q to quit
          </Text>

          {recentStars.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan" bold>
                Latest repositories:
              </Text>
              {recentStars.map((star, idx) => (
                <Text key={idx} color="green">
                  • {star.full_name} ({star.stargazers_count} ⭐)
                </Text>
              ))}
            </Box>
          )}
        </>
      )}

      {fetchingPhase === 'complete' && (
        <>
          <Text color="green">
            ✅ Found {starsFetched} starred repositories
            {starsFetched >= maxRepos ? ` (limited to ${maxRepos})` : ''}!
          </Text>
          <Newline />
          <Text color="cyan">🚀 Starting AI processing...</Text>
          <Spinner type="dots" />
        </>
      )}
    </Box>
  );
};

// Streaming version of Constellate processing with AI streaming
const ConstellateStreamingApp: React.FC<{
  stars: StarredRepo[];
  maxRepos: number;
  token: string;
  onFinish: (store: ConstellateStore) => void;
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
          const batches = batch(repoFeatures, 4);
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
            maxCategories: parseInt(
              process.env.CONSTELLATE_MAX_CATEGORIES || '100'
            ),
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
          minCategorySize: parseInt(
            process.env.CONSTELLATE_MIN_CAT_SIZE || '1'
          ),
          maxCategories: parseInt(
            process.env.CONSTELLATE_MAX_CATEGORIES || '100'
          ),
          max_new_categories: parseInt(
            process.env.CONSTELLATE_MAX_NEW_CATEGORIES || '50'
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
            min: 22,
            max: 36,
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
        await fs.mkdir('.constellate', { recursive: true });
        await fs.writeFile(
          '.constellate/repos.json',
          JSON.stringify(repoFeatures, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          '.constellate/constellate.json',
          JSON.stringify(store, null, 2),
          'utf-8'
        );
        const md = renderReadme(store, repoFeatures, 1);
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
          🚀 Constellate – Fetching Repository Data
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
          🤖 Constellate – AI Processing Phase{' '}
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
        🎉 Constellate – Processing Complete!
      </Text>
      <Newline />
      <Text color="green">
        ✅ All processing complete! Check .constellate/ and {outputFilename}
      </Text>
      <Text color="gray" dimColor>
        Press Q to quit
      </Text>
    </Box>
  );
};

// Configuration file utilities
const CONFIG_FILE_PATH = '.constellate/config.json';

const loadSavedConfig = async (): Promise<Record<string, string> | null> => {
  try {
    const configData = await fs.readFile(CONFIG_FILE_PATH, 'utf-8');
    return JSON.parse(configData);
  } catch {
    return null;
  }
};

const saveConfig = async (config: Record<string, string>): Promise<void> => {
  await fs.mkdir('.constellate', { recursive: true });
  await fs.writeFile(
    CONFIG_FILE_PATH,
    JSON.stringify(config, null, 2),
    'utf-8'
  );
};

const applyConfigToEnv = (config: Record<string, string>): void => {
  for (const [key, value] of Object.entries(config)) {
    if (value) {
      process.env[key] = value;
    }
  }
};

// ----------------------------------- CLI -----------------------------------
const main = Effect.gen(function* () {
  const [, , ...args] = process.argv;

  // Parse command-line arguments
  let outputFilename = 'AWESOME.md';
  let cmd = args[0];
  let skipConfig = false;

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

  // Check for --skip-config flag
  if (args.includes('--skip-config')) {
    skipConfig = true;
  }

  if (cmd === 'logout') {
    yield* removeToken;
    console.log('🗑️  Removed saved token.');
    return;
  }

  if (cmd === 'config') {
    // Force interactive configuration
    skipConfig = false;
  }

  // Load saved configuration and apply to environment
  const savedConfig = yield* Effect.tryPromise({
    try: () => loadSavedConfig(),
    catch: () => null,
  });

  if (savedConfig && cmd !== 'config') {
    applyConfigToEnv(savedConfig);
    console.log('✅ Loaded saved configuration from .constellate/config.json');
    console.log('\n📋 Current Configuration:');
    for (const [key, value] of Object.entries(savedConfig)) {
      const configOption = CONFIG_OPTIONS.find((opt) => opt.key === key);
      const displayName = configOption?.label || key;
      const displayValue = key.toLowerCase().includes('token')
        ? '••••••••'
        : value;
      console.log(`  ${displayName}: ${displayValue}`);
    }
    console.log('');
  }

  // Interactive configuration setup (unless skipped)
  if (!skipConfig && (!savedConfig || cmd === 'config')) {
    const configPromise = new Promise<Record<string, string>>((resolve) => {
      const { waitUntilExit } = render(
        <InteractiveConfigApp onConfigComplete={resolve} />
      );
    });

    const userConfig = yield* Effect.tryPromise({
      try: () => configPromise,
      catch: (e) => {
        console.error('Configuration setup failed:', e);
        process.exit(1);
      },
    });

    // Save configuration
    yield* Effect.tryPromise({
      try: () => saveConfig(userConfig),
      catch: (e) => console.warn('Failed to save configuration:', e),
    });

    // Apply to environment
    applyConfigToEnv(userConfig);

    if (cmd === 'config') {
      console.log(
        '✅ Configuration saved! You can now run constellate without the config command.'
      );
      return;
    }
  }

  // GitHub token will be handled by the existing authentication flow

  // Get authenticated token using the abstracted utility
  const token = yield* ensureAuthenticatedToken({
    interactive: cmd === 'login' || !cmd,
    forceLogin: cmd === 'login',
  });

  const me = yield* whoAmI(token);

  // Show progress during star fetching (username will be shown in UI)
  const { waitUntilExit } = render(
    <StarFetchingApp
      token={token}
      maxRepos={MAX_REPOS_TO_PROCESS}
      outputFilename={outputFilename}
      username={me?.login}
      onStarsFetched={(stars) => {
        if (stars.length === 0) {
          console.log('No starred repositories found.');
          process.exit(0);
        }

        // Now render the main processing app with fetched stars
        render(
          <ConstellateStreamingApp
            stars={stars}
            maxRepos={MAX_REPOS_TO_PROCESS}
            token={token}
            outputFilename={outputFilename}
            onFinish={(_store) => {
              Effect.runPromise(
                Console.log(
                  `\n✅ All processing complete! Wrote .constellate/constellate.json and ${outputFilename}`
                )
              ).catch(() => {
                // Error already handled above
              });
            }}
          />
        );
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
