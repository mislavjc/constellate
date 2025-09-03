import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import {
  Select,
  Spinner as UiSpinner,
  Alert,
  StatusMessage,
  Badge,
  ProgressBar,
  UnorderedList,
} from '@inkjs/ui';
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
  CONSTELLATE_MAX_CATEGORIES,
  CONSTELLATE_MIN_CAT_SIZE,
  CONSTELLATE_MAX_NEW_CATEGORIES,
} from './lib/config';
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
import { getConfiguredPolicies } from './lib/budget';
import { aiPass3QualityAssuranceStreaming } from './lib/ai';
import { QaFix, Category } from './lib/schemas';

// ----------------------------------- Layout Component -----------------------------------

interface StepLayoutProps {
  title: string;
  description?: string;
  currentStep?: number;
  totalSteps?: number;
  progress?: number;
  showProgress?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  savedConfig?: Record<string, string>;
}

const StepLayout: React.FC<StepLayoutProps> = ({
  title,
  description,
  currentStep,
  totalSteps,
  progress,
  showProgress = true,
  children,
  footer,
  savedConfig,
}) => {
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  return (
    <Box flexDirection="column" width={contentWidth}>
      {/* Header */}
      <Text color="blue" bold>
        {title}
      </Text>

      {/* Step indicator with progress */}
      {currentStep && totalSteps && (
        <Box flexDirection="column" marginBottom={2} marginTop={1}>
          <Box marginBottom={1}>
            <Text color="cyan" dimColor>
              Step {currentStep} of {totalSteps}
            </Text>
          </Box>
          {showProgress && progress !== undefined && (
            <Box flexDirection="column" marginTop={1}>
              <ProgressBar value={Math.min(100, Math.max(0, progress))} />
              <Box marginTop={1}>
                <Text color="gray" dimColor>
                  {Math.round(progress)}% complete
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Description */}
      {description && (
        <Box marginBottom={1}>
          <Text color="gray" dimColor>
            {description}
          </Text>
        </Box>
      )}

      {/* Progress bar (when no step indicator) */}
      {showProgress && progress !== undefined && !currentStep && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <ProgressBar value={Math.min(100, Math.max(0, progress))} />
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              {Math.round(progress)}% complete
            </Text>
          </Box>
        </Box>
      )}

      {/* Content */}
      <Box marginTop={1}>{children}</Box>

      {/* Saved Configuration Footer */}
      {savedConfig && Object.keys(savedConfig).length > 0 && (
        <Box flexDirection="column" marginTop={2}>
          <Box
            flexDirection="column"
            paddingY={1}
            paddingX={2}
            borderStyle="single"
            borderColor="gray"
          >
            <Box marginBottom={1}>
              <Text color="green" bold>
                ✅ Loaded saved configuration from .constellator/config.json
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text color="yellow" bold>
                📋 Current Configuration:
              </Text>
            </Box>
            {Object.entries(savedConfig).map(([key, value]) => {
              const configOption = CONFIG_OPTIONS.find(
                (opt) => opt.key === key
              );
              const displayName = configOption?.label || key;
              const displayValue = key.toLowerCase().includes('token')
                ? '••••••••'
                : value;
              return (
                <Box key={key} marginBottom={1}>
                  <Text color="gray">
                    {'  '}
                    {displayName}: {displayValue}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Additional Footer */}
      {footer && <Box marginTop={1}>{footer}</Box>}
    </Box>
  );
};

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
  {
    key: 'CONSTELLATE_MAX_CATEGORIES',
    label: 'Maximum Category Count',
    defaultValue: String(CONSTELLATE_MAX_CATEGORIES),
    description: 'Upper bound for total categories after consolidation (8–200)',
    type: 'text',
  },
  {
    key: 'CONSTELLATE_MIN_CAT_SIZE',
    label: 'Minimum Category Size',
    defaultValue: String(CONSTELLATE_MIN_CAT_SIZE),
    description:
      'Minimum repos per category before being merged/aliased (1–10)',
    type: 'text',
  },
  {
    key: 'CONSTELLATE_MAX_NEW_CATEGORIES',
    label: 'Max New Categories (Pass-2)',
    defaultValue: String(CONSTELLATE_MAX_NEW_CATEGORIES),
    description: 'Cap on new categories created during streamlining (16–200)',
    type: 'text',
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
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { stdout } = useStdout();
  const contentWidth = Math.min((stdout?.columns ?? 80) - 4, 100);

  const getCurrentStep = () => (selectedProvider ? 2 : 1);
  const getTotalSteps = () => 2;
  const getProgress = () => (selectedProvider ? 50 : 0);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        const result = await gateway.getAvailableModels();
        const languageModels = result.models.filter(
          (m: any) => m.modelType === 'language'
        );
        setAvailableModels(languageModels);

        // Extract unique providers
        const uniqueProviders = [
          ...new Set(
            languageModels.map((m: any) => {
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

        setProviders(uniqueProviders.sort());

        // Don't auto-select provider - let user choose
        // The currentValue is just for reference if they skip to default
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch models');
      } finally {
        setLoading(false);
      }
    };

    fetchModels();
  }, [currentValue]);

  useInput((input, key) => {
    if (key.escape) {
      if (selectedProvider) {
        // Go back to provider selection
        setSelectedProvider(null);
      } else {
        // Cancel and go back to configuration
        onCancel();
      }
    } else if (key.tab && !selectedProvider) {
      // Skip to default model directly
      onModelSelect(currentValue);
    }
  });

  // Helper function to format pricing per million tokens
  const formatPricePerMillion = (pricePerToken: number): string => {
    return (pricePerToken * 1000000).toFixed(2);
  };

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

  // Create provider options
  const providerOptions = providers.map((provider) => {
    const providerModels = availableModels.filter((m: any) => {
      const modelProvider =
        m.provider ||
        m.providerName ||
        m.company ||
        m.vendor ||
        (m.id && m.id.includes('/') ? m.id.split('/')[0] : 'Unknown');
      return modelProvider === provider;
    });

    return {
      label: `${provider} (${providerModels.length} models)`,
      value: provider,
    };
  });

  // Create model options for selected provider
  const modelOptions = filteredModels.map((model) => {
    const pricing = model.pricing
      ? ` ($${formatPricePerMillion(
          model.pricing.input
        )}/$${formatPricePerMillion(model.pricing.output)})`
      : '';

    return {
      label: `${model.name || model.id}${pricing}`,
      value: model.id,
    };
  });

  if (loading) {
    return (
      <StepLayout
        title="🤖 Select AI Model"
        description="Loading available models..."
        currentStep={1}
        totalSteps={2}
        progress={0}
      >
        <StatusMessage variant="info">
          Loading available models...
        </StatusMessage>
        <UiSpinner label="Fetching models" />
      </StepLayout>
    );
  }

  if (error) {
    return (
      <StepLayout
        title="🤖 Select AI Model"
        description="Failed to load models"
        currentStep={1}
        totalSteps={2}
        progress={0}
        footer={
          <Text color="gray" dimColor>
            Press ESC to return to configuration
          </Text>
        }
      >
        <Alert variant="error">Failed to load models: {error}</Alert>
      </StepLayout>
    );
  }

  return (
    <StepLayout
      title="🤖 Select AI Model"
      description={
        selectedProvider
          ? `Select model from ${selectedProvider}`
          : `Choose your AI provider first (current: ${currentValue})`
      }
      currentStep={getCurrentStep()}
      totalSteps={getTotalSteps()}
      progress={getProgress()}
      footer={
        <Text color="gray" dimColor>
          {selectedProvider
            ? `Press ESC to go back to providers • ${modelOptions.length} models available`
            : `Press ESC to return to configuration • Press TAB to use ${currentValue} • ${providers.length} providers available`}
        </Text>
      }
    >
      {!selectedProvider ? (
        // Provider Selection
        <Box flexDirection="column">
          <Text color="cyan" bold>
            Select Provider:
          </Text>
          <Newline />
          <Select
            options={providerOptions}
            onChange={(value) => setSelectedProvider(value)}
          />
        </Box>
      ) : (
        // Model Selection
        <Box flexDirection="column">
          <Text color="cyan" bold>
            Select Model from {selectedProvider}:
          </Text>
          <Newline />
          <Select
            options={modelOptions}
            onChange={(value) => onModelSelect(value)}
          />
        </Box>
      )}
    </StepLayout>
  );
};

// Interactive Configuration Component
const InteractiveConfigApp: React.FC<{
  onConfigComplete: (config: Record<string, string>) => void;
  savedConfig?: Record<string, string>;
}> = ({ onConfigComplete, savedConfig }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [inputValue, setInputValue] = useState('');
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const currentOption = CONFIG_OPTIONS[currentIndex];

  // Guard against invalid index
  if (!currentOption) {
    return (
      <StepLayout title="⚙️ Constellator Configuration Setup">
        <Alert variant="error">Invalid configuration option index</Alert>
      </StepLayout>
    );
  }

  const progress = ((currentIndex + 1) / CONFIG_OPTIONS.length) * 100;

  // Helper: find option definition by key
  const getOptionByKey = (key: string) =>
    CONFIG_OPTIONS.find((opt) => opt.key === key);

  // Compute effective (possibly derived) default values based on earlier answers
  const getEffectiveDefault = (key: string): string => {
    const base = getOptionByKey(key)?.defaultValue ?? '';
    const maxReposStr =
      configValues['CONSTELLATE_MAX_REPOS'] ||
      getOptionByKey('CONSTELLATE_MAX_REPOS')?.defaultValue ||
      String(MAX_REPOS_TO_PROCESS);
    const maxRepos = Math.max(
      1,
      parseInt(maxReposStr || '0') || MAX_REPOS_TO_PROCESS
    );

    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Math.round(v)));

    if (key === 'CONSTELLATE_MAX_CATEGORIES') {
      // Roughly 1 category per ~10 repos, within 8–200 bounds
      const recommended = clamp(maxRepos / 10, 8, 200);
      return String(recommended);
    }
    if (key === 'CONSTELLATE_MIN_CAT_SIZE') {
      // Scale with repo count; 1–10
      const recommended = clamp(maxRepos / 50, 1, 10);
      return String(recommended);
    }
    if (key === 'CONSTELLATE_MAX_NEW_CATEGORIES') {
      // Allow fewer new categories than overall max; 16–200
      const recommended = clamp(maxRepos / 12, 16, 200);
      return String(recommended);
    }
    return base;
  };

  // Clamp numeric inputs for known numeric options
  const sanitizeValue = (key: string, value: string): string => {
    const asNum = parseInt(value, 10);
    if (Number.isNaN(asNum)) return value;
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, Math.round(v)));
    switch (key) {
      case 'CONSTELLATE_MAX_REPOS':
        return String(clamp(asNum, 1, 5000));
      case 'CONSTELLATE_MAX_CATEGORIES':
        return String(clamp(asNum, 8, 200));
      case 'CONSTELLATE_MIN_CAT_SIZE':
        return String(clamp(asNum, 1, 10));
      case 'CONSTELLATE_MAX_NEW_CATEGORIES':
        return String(clamp(asNum, 16, 200));
      default:
        return value;
    }
  };

  const handleNext = (value: string) => {
    const newConfig = {
      ...configValues,
      [currentOption.key]: value
        ? sanitizeValue(currentOption.key, value)
        : getEffectiveDefault(currentOption.key),
    };
    setConfigValues(newConfig);
    setInputValue('');
    setIsEditing(false);

    if (currentIndex < CONFIG_OPTIONS.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      // Configuration complete
      onConfigComplete(newConfig);
    }
  };

  const handleSkip = () => {
    const newConfig = {
      ...configValues,
      [currentOption.key]: getEffectiveDefault(currentOption.key),
    };
    setConfigValues(newConfig);
    setIsEditing(false);
    setInputValue('');

    if (currentIndex < CONFIG_OPTIONS.length - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      onConfigComplete(newConfig);
    }
  };

  useInput((input, key) => {
    if (key.tab) {
      // Skip to default for any option
      handleSkip();
    } else if (key.escape) {
      if (isEditing) {
        setIsEditing(false);
        setInputValue('');
      } else if (currentIndex > 0) {
        // Go back to previous option
        setCurrentIndex(currentIndex - 1);
        setShowModelSelector(false);
        setInputValue('');
      }
    } else if (key.return) {
      if (currentOption.type === 'model-select') {
        setShowModelSelector(true);
      } else if (!isEditing) {
        // Begin editing this option
        const existing =
          configValues[currentOption.key] ||
          getEffectiveDefault(currentOption.key);
        setInputValue(String(existing));
        setIsEditing(true);
      }
    }
  });

  // Show model selector if active
  if (showModelSelector && currentOption.type === 'model-select') {
    return (
      <ModelSelector
        onModelSelect={(modelId) => {
          handleNext(modelId);
          setShowModelSelector(false);
        }}
        currentValue={
          configValues[currentOption.key] ||
          getEffectiveDefault(currentOption.key)
        }
        onCancel={() => setShowModelSelector(false)}
      />
    );
  }

  return (
    <StepLayout
      title="⚙️ Constellator Configuration Setup"
      currentStep={currentIndex + 1}
      totalSteps={CONFIG_OPTIONS.length}
      progress={progress}
      savedConfig={savedConfig}
      footer={
        <StatusMessage variant="info">
          Tip: You can re-run this setup anytime with 'constellator config'
        </StatusMessage>
      }
    >
      <Box flexDirection="column" paddingX={2}>
        <Text color="yellow" bold>
          {currentOption.label}
        </Text>
        <Text color="gray" dimColor>
          {currentOption.description}
        </Text>
        <Newline />

        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">
            Current value:{' '}
            {currentOption.isSecret
              ? '••••••••'
              : configValues[currentOption.key] ||
                getEffectiveDefault(currentOption.key)}
          </Text>
        </Box>

        {currentOption.type === 'model-select' ? (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color="cyan">Choose your AI model:</Text>
            </Box>
            <Text color="gray" dimColor>
              Press ENTER to browse models • Press TAB to use default • ESC to
              go back
            </Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            {!isEditing ? (
              <>
                <Text color="gray" dimColor>
                  Press ENTER to edit • Press TAB to use recommended • ESC to go
                  back
                </Text>
                {[
                  'CONSTELLATE_MAX_CATEGORIES',
                  'CONSTELLATE_MIN_CAT_SIZE',
                  'CONSTELLATE_MAX_NEW_CATEGORIES',
                ].includes(currentOption.key) && (
                  <Box marginTop={1}>
                    <Badge>
                      Recommended: {getEffectiveDefault(currentOption.key)}
                    </Badge>
                  </Box>
                )}
              </>
            ) : (
              <>
                <Box marginBottom={1}>
                  <Text color="cyan">Enter new value:</Text>
                </Box>
                <Box marginBottom={1}>
                  <TextInput
                    value={inputValue}
                    onChange={setInputValue}
                    placeholder={getEffectiveDefault(currentOption.key)}
                    onSubmit={handleNext}
                  />
                </Box>
                <Text color="gray" dimColor>
                  Press ENTER to confirm • Press TAB to use recommended • ESC to
                  cancel edit
                </Text>
              </>
            )}
          </Box>
        )}
      </Box>
    </StepLayout>
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
  // Decorative starfield header
  lines.push('```');
  lines.push('         .    *   .  .  *    .    *   .');
  lines.push('     .     *      .    *      .     *    .');
  lines.push('  *    .     *   .     *    .     *   .   *');
  lines.push('   .     *       .     *    .     *      .  .');
  lines.push(' *   .     *   .     *    .     *   .     * .');
  lines.push('  .     *    .     *      .     *    .     *');
  lines.push('    *    .     *   .     *    .     *   .');
  lines.push('   .     *      .     *    .     *      .');
  lines.push('     *    .     *   .     *    .     *');
  lines.push('       .    *      .    *      .    *');
  lines.push('```');
  lines.push('');
  lines.push('# Awesome – Generated by Constellator');
  lines.push('');
  lines.push(
    `> Generated by [Constellator](https://github.com/mislavjc/constellator). Categories distilled from your stars via multi‑pass AI. Updated ${new Date()
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
  timeoutMs?: number;
}> = ({ token, maxRepos, username, onStarsFetched, timeoutMs = 30000 }) => {
  const [fetchingPhase, setFetchingPhase] = useState<
    'connecting' | 'fetching' | 'complete'
  >('connecting');
  const [starsFetched, setStarsFetched] = useState(0);
  const [totalStars, setTotalStars] = useState(0);
  const [currentBatch, setCurrentBatch] = useState(0);
  const [recentStars, setRecentStars] = useState<StarredRepo[]>([]);
  const [isComplete, setIsComplete] = useState(false);

  // Handle keyboard input for quitting
  useInput((input, key) => {
    if (input === 'q') {
      console.log('\n👋 Exiting Constellator...');
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

          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), timeoutMs);
          let response: Response;
          try {
            response = await fetch(url, {
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'constellator',
              },
              signal: controller.signal,
            });
          } finally {
            clearTimeout(t);
          }

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

  const getTitle = () => {
    const phaseTitles = {
      connecting: '⭐ Constellator – Connecting to GitHub',
      fetching: `⭐ Constellator – Fetching ${
        username ? `@${username}'s ` : 'Your '
      }Starred Repositories`,
      complete: '⭐ Constellator – Repository Fetch Complete',
    };
    return phaseTitles[fetchingPhase];
  };

  const getDescription = () => {
    const phaseDescriptions = {
      connecting: 'Establishing connection to GitHub API',
      fetching: 'Downloading your starred repositories',
      complete: 'Repository data successfully retrieved',
    };
    return phaseDescriptions[fetchingPhase];
  };

  const getProgress = () => {
    if (fetchingPhase === 'complete') return 100;
    if (fetchingPhase === 'connecting') return 0;
    if (starsFetched > 0 && totalStars > 0) {
      return Math.min(
        100,
        (starsFetched / Math.max(totalStars, maxRepos)) * 100
      );
    }
    return Math.min(100, (currentBatch % 10) * 10);
  };

  const getCurrentStep = () => {
    if (fetchingPhase === 'connecting') return 1;
    if (fetchingPhase === 'fetching') return 2;
    return 3;
  };

  const getTotalSteps = () => 3;

  const getFooter = () => {
    if (fetchingPhase === 'fetching') {
      return (
        <Text color="gray" dimColor>
          Batch {currentBatch} • Press Q to quit
        </Text>
      );
    }
    return null;
  };

  const getContent = () => {
    switch (fetchingPhase) {
      case 'connecting':
        return (
          <>
            <StatusMessage variant="info">
              Connecting to GitHub...
            </StatusMessage>
            <UiSpinner label="Connecting" />
          </>
        );

      case 'fetching':
        return (
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
            </Box>

            {recentStars.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="cyan" bold>
                  Latest repositories:
                </Text>
                <UnorderedList>
                  {recentStars.map((star, idx) => (
                    <UnorderedList.Item key={idx}>
                      <Text color="green">
                        {star.full_name} ({star.stargazers_count} ⭐)
                      </Text>
                    </UnorderedList.Item>
                  ))}
                </UnorderedList>
              </Box>
            )}
          </>
        );

      case 'complete':
        return (
          <>
            <StatusMessage variant="success">
              Found {starsFetched} starred repositories
              {starsFetched >= maxRepos ? ` (limited to ${maxRepos})` : ''}!
            </StatusMessage>
            <Newline />
            <StatusMessage variant="info">
              Starting AI processing...
            </StatusMessage>
            <UiSpinner label="Processing" />
          </>
        );

      default:
        return null;
    }
  };

  return (
    <StepLayout
      title={getTitle()}
      description={getDescription()}
      currentStep={getCurrentStep()}
      totalSteps={getTotalSteps()}
      progress={getProgress()}
      footer={getFooter()}
    >
      {getContent()}
    </StepLayout>
  );
};

// Streaming version of Constellator processing with AI streaming
const ConstellateStreamingApp: React.FC<{
  stars: StarredRepo[];
  maxRepos: number;
  token: string;
  onFinish: (store: ConstellateStore) => void;
  outputFilename: string;
  artifactsDir?: string;
  readmeMinSize?: number;
  batchSize?: number;
  openOnComplete?: boolean;
}> = ({
  stars,
  maxRepos,
  token,
  onFinish,
  outputFilename,
  artifactsDir = '.constellator',
  readmeMinSize = 1,
  batchSize = 4,
  openOnComplete = false,
}) => {
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

  useInput((input, key) => {
    if (currentPhase === 'complete') {
      if (input === 'q') process.exit(0);
    } else if (
      currentPhase === 'ai-processing' &&
      allBatchesData.length > 0 &&
      aiPhase !== 'pass1'
    ) {
      // Allow panning between batches during AI processing (except Pass-1)
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
            // Update streaming data for UI - accumulate total processed count
            setStreamingData((prevData: any) => {
              const currentBatchCount = partialResult?.results?.length || 0;
              const previousTotal = prevData?.totalProcessed || 0;
              return {
                phase: 'pass0',
                partialResult,
                factsCount: currentBatchCount,
                totalProcessed: previousTotal + currentBatchCount,
              };
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
          const batches = batch(repoFeatures, Math.max(1, batchSize || 4));
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
        const policies = getConfiguredPolicies(repoFeatures.length);
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
            min: policies.minCategorySize,
            max: policies.maxCategories,
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
        await fs.mkdir(artifactsDir, { recursive: true });
        await fs.writeFile(
          `${artifactsDir}/repos.json`,
          JSON.stringify(repoFeatures, null, 2),
          'utf-8'
        );
        await fs.writeFile(
          `${artifactsDir}/constellator.json`,
          JSON.stringify(store, null, 2),
          'utf-8'
        );
        const md = renderReadme(store, repoFeatures, readmeMinSize ?? 1);
        await fs.writeFile(outputFilename, md, 'utf-8');

        if (openOnComplete) {
          try {
            await Bun.$`open ${outputFilename}`;
          } catch {}
        }

        setCurrentPhase('complete');
        onFinish(store);
      } catch (error) {
        console.error('Processing error:', error);
        setCurrentPhase('complete');
      }
    };

    processEverything();
  }, [stars, maxRepos, token, onFinish]);

  // Helper functions for rendering different phases
  const getPhaseInfo = () => {
    const phaseInfo = {
      fetching: {
        title: '🚀 Constellator – Fetching Repository Data',
        description: 'Downloading repository details and READMEs',
        progress: Math.min(
          100,
          Math.max(0, Math.round((currentStep / totalSteps) * 100))
        ),
      },
      'ai-processing': {
        title: '🤖 Constellator – AI Processing',
        description: 'Processing repositories with AI',
        progress: undefined,
      },
      complete: {
        title: '🎉 Constellator – Processing Complete!',
        description: 'All processing complete successfully',
        progress: 100,
      },
    };

    const current = phaseInfo[currentPhase];

    // Customize AI processing title and description based on current phase
    if (currentPhase === 'ai-processing' && aiPhase) {
      const phaseNames = {
        pass0: 'Facts Extraction',
        pass1: 'Category Analysis',
        pass2: 'Streamlining',
        pass3: 'Quality Assurance',
      };
      const descriptions = {
        pass0: 'Extracting factual signals from repository READMEs',
        pass1: 'Analyzing repositories and creating categories',
        pass2: 'Streamlining and organizing categories',
        pass3: 'Final quality assurance and optimization',
      };

      current.title = `🤖 Constellator – ${phaseNames[aiPhase]}`;
      current.description = descriptions[aiPhase];
    }

    return current;
  };

  const getTitle = () => getPhaseInfo().title;
  const getDescription = () => getPhaseInfo().description;
  const getProgress = () => getPhaseInfo().progress;

  const getCurrentStep = () => {
    if (currentPhase === 'fetching') return 1;
    if (currentPhase === 'ai-processing') return 2;
    return 3;
  };

  const getTotalSteps = () => 3;

  // Helper function to render repository facts
  const renderRepositoryFacts = (results: any[]) => {
    if (!results || results.length === 0) return null;

    return (
      <Box flexDirection="column" paddingLeft={2} marginTop={1}>
        <Text color="cyan" bold>
          Latest Facts Extracted:
        </Text>
        {results.slice(-3).map((result: any, idx: number) => (
          <Box key={idx} flexDirection="column" paddingLeft={2}>
            <Text color="magenta" bold>
              • {result.id?.split('/').pop() || 'Unknown'}
            </Text>
            <Text color="gray">
              Purpose: {result.purpose?.slice(0, 50) || 'None'}...
            </Text>
            <Text color="gray">
              Capabilities: {(result.capabilities || []).slice(0, 2).join(', ')}
              {(result.capabilities || []).length > 2 ? '...' : ''}
            </Text>
          </Box>
        ))}
      </Box>
    );
  };

  // Render different UI based on current phase
  if (currentPhase === 'fetching') {
    return (
      <StepLayout
        title={getTitle()}
        description={getDescription()}
        currentStep={getCurrentStep()}
        totalSteps={getTotalSteps()}
        progress={getProgress()}
      >
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
            <UiSpinner label={`Processing: ${stars[currentStep]?.full_name}`} />
          </Box>
        )}
      </StepLayout>
    );
  }

  if (currentPhase === 'ai-processing') {
    // For Pass-1, always show the current processing batch, not allow navigation
    const batchIndex =
      aiPhase === 'pass1' ? currentBatch - 1 : selectedBatchIndex;
    const currentBatchData = allBatchesData[batchIndex];
    const isViewingCurrentBatch = selectedBatchIndex === currentBatch - 1;

    const getFooter = () => {
      if (allBatchesData.length > 1 && aiPhase === 'pass1') {
        return (
          <Box flexDirection="column">
            {isViewingCurrentBatch && totalBatches > 0 && (
              <UiSpinner
                label={`Processing batch ${currentBatch} of ${totalBatches}`}
              />
            )}
            {!isViewingCurrentBatch && totalBatches > 0 && (
              <Text color="gray" dimColor>
                Viewing completed batch {selectedBatchIndex + 1} of{' '}
                {totalBatches}
              </Text>
            )}
          </Box>
        );
      }
      return null;
    };

    return (
      <StepLayout
        title={getTitle()}
        description={getDescription()}
        currentStep={getCurrentStep()}
        totalSteps={getTotalSteps()}
        footer={getFooter()}
      >
        {aiPhase === 'pass0' && (
          <Box flexDirection="column">
            <Box marginBottom={2}>
              <Text color="cyan">
                Pass-0: Extracting factual signals from repository READMEs
              </Text>
            </Box>

            {/* Progress Bar */}
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <ProgressBar
                value={
                  streamingData?.totalProcessed
                    ? (streamingData.totalProcessed / features.length) * 100
                    : 0
                }
              />
              <Box marginTop={1}>
                <Text color="gray" dimColor>
                  {streamingData?.totalProcessed || 0} of {features.length}{' '}
                  repositories processed
                </Text>
              </Box>
            </Box>

            {/* Facts Extraction */}
            {streamingData && streamingData.phase === 'pass0' && (
              <Box flexDirection="column" marginTop={1}>
                <Box marginBottom={1}>
                  <Text color="yellow" bold>
                    🔴 Facts Extraction:
                  </Text>
                </Box>
                <Box paddingLeft={2} marginBottom={1}>
                  <Text color="green">
                    Current batch: {streamingData.factsCount || 0} repositories
                  </Text>
                </Box>
                {renderRepositoryFacts(streamingData.partialResult?.results)}
              </Box>
            )}

            {/* Initial loading message */}
            {!streamingData || streamingData.phase !== 'pass0' ? (
              <Text color="green">
                Processing {features.length} repositories for facts
                extraction...
              </Text>
            ) : null}
          </Box>
        )}

        {aiPhase === 'pass1' && currentBatchData && (
          <Box flexDirection="column">
            <Text color="cyan">
              Batch {currentBatchData.batchNumber}: Analyzing{' '}
              {currentBatchData.repositories.length} repositories
            </Text>

            {/* Repository List */}
            <Box flexDirection="column" marginTop={2}>
              <Box marginBottom={1}>
                <Text color="yellow" bold>
                  Repositories in this batch:
                </Text>
              </Box>
              {currentBatchData.repositories
                .slice(0, 5)
                .map((repo: any, idx: number) => (
                  <Text key={idx} color="gray">
                    • {repo.name} ({repo.language || 'Unknown'}, {repo.stars})
                  </Text>
                ))}
              {currentBatchData.repositories.length > 5 && (
                <Text color="gray" dimColor>
                  ... and {currentBatchData.repositories.length - 5} more
                </Text>
              )}
            </Box>

            {/* Analysis Progress */}
            {streamingData && streamingData.phase === 'pass1' && (
              <Box flexDirection="column" marginTop={2}>
                <Box marginBottom={1}>
                  <Text color="yellow" bold>
                    🔄 Analysis Progress:
                  </Text>
                </Box>

                {/* Current Progress */}
                <Box paddingLeft={2} marginBottom={1} gap={4}>
                  <Text color="green">
                    Categories:{' '}
                    {streamingData.partialResult?.categories?.length || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Summaries:{' '}
                    {streamingData.partialResult?.summaries?.length || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Assignments:{' '}
                    {streamingData.partialResult?.assignments?.length || 0}
                  </Text>
                </Box>

                {/* Categories Preview */}
                {streamingData.partialResult?.categories &&
                  streamingData.partialResult.categories.length > 0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Box marginBottom={1}>
                        <Text color="cyan" bold>
                          Latest Categories:
                        </Text>
                      </Box>
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
                      <Box marginBottom={1}>
                        <Text color="cyan" bold>
                          Latest Summaries:
                        </Text>
                      </Box>
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
          </Box>
        )}

        {aiPhase === 'pass2' && (
          <Box flexDirection="column">
            <Box marginBottom={2}>
              <Text color="cyan">
                Pass 2: Streamlining categories and assignments
              </Text>
            </Box>
            {streamingData && (
              <Box flexDirection="column" marginTop={1}>
                <Box marginBottom={1}>
                  <Text color="yellow" bold>
                    🔄 Streamlining:
                  </Text>
                </Box>
                <Box paddingLeft={2} marginBottom={1} gap={4}>
                  <Text color="green">
                    Categories: {streamingData.categoriesCount || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Aliases: {streamingData.aliasesCount || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Repos Assigned: {streamingData.reposCount || 0}
                  </Text>
                </Box>
                {streamingData.partialResult?.categories && (
                  <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                    <Box marginBottom={1}>
                      <Text color="cyan" bold>
                        Categories Being Streamlined:
                      </Text>
                    </Box>
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
          </Box>
        )}

        {aiPhase === 'pass3' && (
          <Box flexDirection="column">
            <Box marginBottom={2}>
              <Text color="cyan">
                Pass 3: Quality assurance and optimization
              </Text>
            </Box>
            {streamingData && (
              <Box flexDirection="column" marginTop={1}>
                <Box marginBottom={1}>
                  <Text color="yellow" bold>
                    🔍 QA Analysis:
                  </Text>
                </Box>
                <Box paddingLeft={2} marginBottom={1} gap={4}>
                  <Text color="green">
                    Categories Analyzed: {streamingData.categoriesCount || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Aliases Found: {streamingData.aliasesCount || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Categories to Delete: {streamingData.deleteCount || 0}
                  </Text>
                  <Newline />
                  <Text color="green">
                    Repos to Reassign: {streamingData.reassignCount || 0}
                  </Text>
                </Box>
                {streamingData.partialResult?.aliases &&
                  Object.keys(streamingData.partialResult.aliases).length >
                    0 && (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      <Box marginBottom={1}>
                        <Text color="cyan" bold>
                          Category Aliases:
                        </Text>
                      </Box>
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
          </Box>
        )}
      </StepLayout>
    );
  }

  return (
    <StepLayout
      title={getTitle()}
      description={getDescription()}
      currentStep={getCurrentStep()}
      totalSteps={getTotalSteps()}
      progress={getProgress()}
      footer={
        <Text color="gray" dimColor>
          Press Q to quit
        </Text>
      }
    >
      <StatusMessage variant="success">
        All processing complete! Check .constellator/ and {outputFilename}
      </StatusMessage>
    </StepLayout>
  );
};

// Configuration file utilities
const getConfigFilePath = (artifactsDir: string) =>
  `${artifactsDir}/config.json`;

const loadSavedConfig = async (
  artifactsDir: string
): Promise<Record<string, string> | null> => {
  try {
    const configData = await fs.readFile(
      getConfigFilePath(artifactsDir),
      'utf-8'
    );
    return JSON.parse(configData);
  } catch {
    return null;
  }
};

const saveConfig = async (
  artifactsDir: string,
  config: Record<string, string>
): Promise<void> => {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(
    getConfigFilePath(artifactsDir),
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
  let artifactsDir = '.constellator';
  let maxReposOverride: number | null = null;
  let readmeMinSize: number | null = null;
  let openOnComplete = false;
  let pass1BatchSize = 4;
  let timeoutMs = 30000;
  let printRateLimit = false;
  const setOverrides: Record<string, string> = {};

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

  // Additional argument parsing
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--artifacts-dir' && i + 1 < args.length) {
      artifactsDir = args[i + 1]!;
      i++;
    } else if (a === '--max-repos' && i + 1 < args.length) {
      const n = parseInt(args[i + 1] || '');
      if (!Number.isNaN(n)) maxReposOverride = Math.max(1, n);
      i++;
    } else if (a === '--min-size' && i + 1 < args.length) {
      const n = parseInt(args[i + 1] || '');
      if (!Number.isNaN(n)) readmeMinSize = Math.max(0, n);
      i++;
    } else if (a === '--open') {
      openOnComplete = true;
    } else if (a === '--batch-size' && i + 1 < args.length) {
      const n = parseInt(args[i + 1] || '');
      if (!Number.isNaN(n)) pass1BatchSize = Math.max(1, n);
      i++;
    } else if (a === '--timeout' && i + 1 < args.length) {
      const n = parseInt(args[i + 1] || '');
      if (!Number.isNaN(n)) timeoutMs = Math.max(1000, n);
      i++;
    } else if (a === '--rate-limit') {
      printRateLimit = true;
    } else if (a === '--set' && i + 1 < args.length) {
      const kv = args[i + 1] || '';
      const eq = kv.indexOf('=');
      if (eq > 0) {
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        if (k) setOverrides[k] = v;
      }
      i++;
    }
  }

  // Help output
  const printHelp = () => {
    const lines: string[] = [];
    lines.push('Constellator – Generate Awesome lists from your GitHub stars');
    lines.push('');
    lines.push('Usage:');
    lines.push('  constellator [command] [options]');
    lines.push('');
    lines.push('Commands:');
    lines.push('  login            Authenticate with GitHub');
    lines.push('  logout           Remove saved token');
    lines.push('  config           Run interactive configuration');
    lines.push('');
    lines.push('Options:');
    lines.push(
      `  --name <file>        Output filename (default: ${outputFilename})`
    );
    lines.push('  --skip-config        Skip interactive configuration');
    lines.push('  --version            Print version and exit');
    lines.push('  --max-repos <n>      Override max repositories for this run');
    lines.push('  --set KEY=VALUE      Override any config key (repeatable)');
    lines.push(
      '  --artifacts-dir <p>  Directory for artifacts (default: .constellator)'
    );
    lines.push('  --min-size <n>       Minimum category size in README');
    lines.push('  --open               Open generated README on completion');
    lines.push('  --batch-size <n>     Pass-1 batch size (default: 4)');
    lines.push(
      '  --timeout <ms>       Network timeout per request (default: 30000)'
    );
    lines.push('  --rate-limit         Print GitHub rate limit before/after');
    lines.push('  -h, --help           Show this help');
    lines.push('');
    lines.push('Environment variables (used as defaults):');
    lines.push(
      `  CONSTELLATE_MAX_REPOS           (default: ${MAX_REPOS_TO_PROCESS})`
    );
    lines.push(
      `  CONSTELLATE_MODEL               (default: ${CONSTELLATE_MODEL})`
    );
    lines.push(
      `  CONSTELLATE_MAX_CATEGORIES      (default: ${CONSTELLATE_MAX_CATEGORIES})`
    );
    lines.push(
      `  CONSTELLATE_MIN_CAT_SIZE        (default: ${CONSTELLATE_MIN_CAT_SIZE})`
    );
    lines.push(
      `  CONSTELLATE_MAX_NEW_CATEGORIES  (default: ${CONSTELLATE_MAX_NEW_CATEGORIES})`
    );
    lines.push('');
    lines.push('Examples:');
    lines.push('  constellator');
    lines.push('  constellator --name AWESOME.md');
    lines.push('  constellator --max-repos 500 --min-size 2');
    lines.push('  constellator --set CONSTELLATE_MAX_CATEGORIES=60');
    lines.push('  constellator --artifacts-dir .cache/constellator');
    lines.push('  constellator login');
    lines.push('  constellator config');
    lines.push('  constellator logout');
    console.log(lines.join('\n'));
  };

  if (args.includes('--help') || args.includes('-h') || cmd === 'help') {
    printHelp();
    return;
  }

  // --version
  if (args.includes('--version')) {
    try {
      const pkgRaw = yield* Effect.tryPromise({
        try: () => fs.readFile('package.json', 'utf-8'),
        catch: (e) => new Error(String(e)),
      });
      const pkg = JSON.parse(pkgRaw || '{}');
      console.log(pkg.version || '0.0.0');
    } catch {
      console.log('0.0.0');
    }
    return;
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
    try: () => loadSavedConfig(artifactsDir),
    catch: () => null,
  });

  if (savedConfig && cmd !== 'config') {
    applyConfigToEnv(savedConfig);
  }

  // Interactive configuration setup (unless skipped)
  if (!skipConfig && (!savedConfig || cmd === 'config')) {
    const configPromise = new Promise<Record<string, string>>((resolve) => {
      const { waitUntilExit } = render(
        <InteractiveConfigApp
          onConfigComplete={resolve}
          savedConfig={savedConfig || undefined}
        />
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
      try: () => saveConfig(artifactsDir, userConfig),
      catch: (e) => console.warn('Failed to save configuration:', e),
    });

    // Apply to environment
    applyConfigToEnv(userConfig);

    if (cmd === 'config') {
      console.log(
        '✅ Configuration saved! You can now run constellator without the config command.'
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

  // Apply --set overrides to env now
  for (const [k, v] of Object.entries(setOverrides)) {
    if (v !== undefined) process.env[k] = v;
  }

  // Optionally print rate limit before
  const printRate = function* (when: string) {
    if (!printRateLimit) return;
    try {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch('https://api.github.com/rate_limit', {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'constellator',
            },
          }),
        catch: (e) => new Error(String(e)),
      });
      const json = (yield* Effect.tryPromise({
        try: () => res.json(),
        catch: (e) => new Error(String(e)),
      })) as any;
      const core = json?.resources?.core || {};
      console.log(
        `[rate-limit:${when}] limit=${core.limit} remaining=${core.remaining} reset=${core.reset}`
      );
    } catch {}
  };

  yield* printRate('before');

  const me = yield* whoAmI(token);

  // Show progress during star fetching (username will be shown in UI)
  const effectiveMaxRepos = maxReposOverride ?? MAX_REPOS_TO_PROCESS;
  const { waitUntilExit } = render(
    <StarFetchingApp
      token={token}
      maxRepos={effectiveMaxRepos}
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
            maxRepos={effectiveMaxRepos}
            token={token}
            outputFilename={outputFilename}
            onFinish={(_store) => {
              Effect.runPromise(
                Console.log(
                  `\n✅ All processing complete! Wrote .constellator/constellator.json and ${outputFilename}`
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

  yield* printRate('after');
}).pipe(
  Effect.provide(Layer.setConfigProvider(ConfigProvider.fromEnv())),
  Effect.map(() => undefined)
);

Effect.runPromise(main).catch((e) => {
  console.error('Error:', e?.message ?? e);
  process.exit(1);
});
