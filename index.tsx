#!/usr/bin/env bun
/**
 * Nebula - Bun + Effect + Ink CLI
 * - Supports both Personal Access Tokens and OAuth Device Flow
 * - Beautiful terminal UI with progress bars and real-time updates
 * - If GITHUB_TOKEN is set, uses it directly
 * - If GITHUB_CLIENT_ID is set, uses OAuth Device Flow
 * - Saves token at ~/.nebula.json
 * - Browse starred repos with full READMEs using arrow keys
 *
 * Commands:
 *   nebula                 → browse your starred repos with keyboard navigation
 *   nebula login           → force login (OAuth if no GITHUB_TOKEN)
 *   nebula logout          → remove saved token
 *
 * Navigation:
 *   ←/↑ Previous repo
 *   →/↓ Next repo
 *   Q Quit
 */

import React, { useState, useEffect } from 'react';
import { render, Text, Box, Newline, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { Effect, Console, Layer, ConfigProvider } from 'effect';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------- Ink Components ----------

const ProgressBar: React.FC<{
  current: number;
  total: number;
  width?: number;
}> = ({ current, total, width = 30 }) => {
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((current / total) * 100))
  );
  const filled = Math.min(
    width,
    Math.max(0, Math.round((current / total) * width))
  );
  const empty = Math.max(0, width - filled);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <Text color="cyan">
      {bar} {percentage}% ({current}/{total})
    </Text>
  );
};

const RepositoryCard: React.FC<{
  repo: StarredRepo;
  details?: DetailedRepo;
  readme?: string;
  isProcessing?: boolean;
  progressText?: string;
}> = ({ repo, details, readme, isProcessing, progressText }) => {
  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Box>
        <Text color="green" bold>
          {repo.full_name}
        </Text>
        {repo.language && <Text color="yellow"> · {repo.language}</Text>}
      </Box>

      {repo.description && (
        <Text color="gray" wrap="wrap">
          {repo.description}
        </Text>
      )}

      <Text color="blue" underline>
        {repo.html_url}
      </Text>

      {isProcessing && progressText && (
        <Box marginTop={1}>
          <Spinner type="dots" />
          <Text color="cyan"> {progressText}</Text>
        </Box>
      )}

      {details && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="magenta">📊 Stars: {details.stargazers_count}</Text>
          <Text color="magenta">
            📅 Created: {new Date(details.created_at).toLocaleDateString()}
          </Text>
          <Text color="magenta">
            🔄 Updated: {new Date(details.updated_at).toLocaleDateString()}
          </Text>
          <Text color="magenta">📏 Size: {details.size} KB</Text>
          <Text color="magenta">
            {details.fork ? '🍴 Fork' : '📁 Original'}
          </Text>

          {details.archived && <Text color="red">📦 Archived</Text>}
          {details.disabled && <Text color="red">🚫 Disabled</Text>}

          {details.topics.length > 0 && (
            <Text color="cyan">
              🏷️ Topics: {details.topics.slice(0, 5).join(', ')}
              {details.topics.length > 5 ? '...' : ''}
            </Text>
          )}

          {details.license && (
            <Text color="cyan">📄 License: {details.license.name}</Text>
          )}

          <Text color="cyan">
            👤 Owner: {details.owner.login} ({details.owner.type})
          </Text>
        </Box>
      )}

      {readme && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow" bold>
            📖 README Preview:
          </Text>
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            {readme
              .split('\n')
              .slice(0, 8)
              .map((line, i) => (
                <Text key={i} wrap="wrap">
                  {line || ' '}
                </Text>
              ))}
            {readme.split('\n').length > 8 && (
              <Text color="gray">... [truncated for display]</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};

const NebulaApp: React.FC<{
  stars: StarredRepo[];
  maxRepos: number;
  token: string;
  onComplete: (stats: {
    processed: number;
    detailsFetched: number;
    readmesFetched: number;
  }) => void;
}> = ({ stars, maxRepos, token, onComplete }) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [processedRepos, setProcessedRepos] = useState<
    Array<{
      repo: StarredRepo;
      details?: DetailedRepo;
      readme?: string;
    }>
  >([]);
  const [isComplete, setIsComplete] = useState(false);
  const [stats, setStats] = useState({
    processed: 0,
    detailsFetched: 0,
    readmesFetched: 0,
  });

  // Get terminal dimensions for responsive layout
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 80;
  const terminalHeight = stdout?.rows ?? 24;

  // Calculate responsive dimensions
  const contentWidth = Math.min(terminalWidth - 4, 100); // Max 100 chars, with padding
  const readmeMaxLines = Math.max(10, terminalHeight - 20); // Adjust based on terminal height

  // Helper function to truncate text to fit terminal width
  const truncateText = (
    text: string,
    maxLength: number = contentWidth - 10
  ) => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
  };

  // Navigation with arrow keys
  useInput((input, key) => {
    if (key.leftArrow || key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.rightArrow || key.downArrow) {
      setSelectedIndex((prev) => Math.min(processedRepos.length - 1, prev + 1));
    } else if (input === 'q') {
      process.exit(0);
    }
  });

  useEffect(() => {
    const processNextRepo = async () => {
      if (currentIndex >= maxRepos || currentIndex >= stars.length) {
        setIsComplete(true);
        setSelectedIndex(0); // Start browsing from the first repo
        onComplete(stats);
        return;
      }

      const repo = stars[currentIndex];
      if (!repo) return; // Skip if repo is undefined
      const newStats = { ...stats };

      // Fetch repository details
      const detailsResult = await Effect.runPromise(
        getRepoDetails(token, repo.full_name).pipe(
          Effect.orElse(() => Effect.succeed(null))
        )
      );

      if (detailsResult) {
        newStats.detailsFetched++;
      }

      // Fetch README
      const readmeResult = await Effect.runPromise(
        getRepoReadme(token, repo.full_name).pipe(
          Effect.orElse(() => Effect.succeed(null))
        )
      );

      if (readmeResult) {
        newStats.readmesFetched++;
      }

      setProcessedRepos((prev) => [
        ...prev,
        {
          repo,
          details: detailsResult || undefined,
          readme: readmeResult || undefined,
        },
      ]);

      newStats.processed++;
      setStats(newStats);

      // Process next repo after delay
      setTimeout(() => {
        setCurrentIndex((prev) => prev + 1);
      }, 300); // 300ms delay between repos
    };

    if (!isComplete) {
      processNextRepo();
    }
  }, [currentIndex, isComplete]);

  if (isComplete) {
    const selectedRepo = processedRepos[selectedIndex];
    if (!selectedRepo) return null;

    return (
      <Box flexDirection="column" width={contentWidth}>
        <Text color="blue" bold>
          🚀 Nebula - Browsing {processedRepos.length} repositories
        </Text>
        <Newline />

        {/* Navigation header */}
        <Box justifyContent="space-between" marginBottom={1}>
          <Text color="cyan">
            ←/↑ Previous • {selectedIndex + 1}/{processedRepos.length} • Next
            →/↓
          </Text>
          <Text color="gray" dimColor>
            Press Q to quit
          </Text>
        </Box>

        {/* Repository card */}
        <Box flexDirection="column" marginY={1}>
          <Box>
            <Text color="green" bold>
              {truncateText(selectedRepo.repo.full_name, contentWidth - 15)}
            </Text>
            {selectedRepo.repo.language && (
              <Text color="yellow"> · {selectedRepo.repo.language}</Text>
            )}
          </Box>

          {selectedRepo.repo.description && (
            <Text color="gray" wrap="wrap">
              {truncateText(selectedRepo.repo.description, contentWidth - 5)}
            </Text>
          )}

          <Text color="blue" underline>
            {truncateText(selectedRepo.repo.html_url, contentWidth - 5)}
          </Text>

          {selectedRepo.details && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="magenta">
                📊 Stars: {selectedRepo.details.stargazers_count}
              </Text>
              <Text color="magenta">
                📅 Created:{' '}
                {new Date(selectedRepo.details.created_at).toLocaleDateString()}
              </Text>
              <Text color="magenta">
                🔄 Updated:{' '}
                {new Date(selectedRepo.details.updated_at).toLocaleDateString()}
              </Text>
              <Text color="magenta">
                📏 Size: {selectedRepo.details.size} KB
              </Text>
              <Text color="magenta">
                {selectedRepo.details.fork ? '🍴 Fork' : '📁 Original'}
              </Text>

              {selectedRepo.details.archived && (
                <Text color="red">📦 Archived</Text>
              )}
              {selectedRepo.details.disabled && (
                <Text color="red">🚫 Disabled</Text>
              )}

              {selectedRepo.details.topics.length > 0 && (
                <Text color="cyan">
                  🏷️ Topics: {selectedRepo.details.topics.join(', ')}
                </Text>
              )}

              {selectedRepo.details.license && (
                <Text color="cyan">
                  📄 License: {selectedRepo.details.license.name}
                </Text>
              )}

              <Text color="cyan">
                👤 Owner: {selectedRepo.details.owner.login} (
                {selectedRepo.details.owner.type})
              </Text>
            </Box>
          )}

          {selectedRepo.readme && (
            <Box flexDirection="column" marginTop={2}>
              <Text color="yellow" bold>
                📖 README:
              </Text>
              <Box borderStyle="round" borderColor="gray" paddingX={1}>
                {selectedRepo.readme
                  .split('\n')
                  .slice(0, readmeMaxLines)
                  .map((line, i) => (
                    <Text key={i} wrap="wrap">
                      {truncateText(line || ' ', contentWidth - 6)}
                    </Text>
                  ))}
                {selectedRepo.readme.split('\n').length > readmeMaxLines && (
                  <Text color="gray" italic>
                    ... [truncated for terminal size]
                  </Text>
                )}
              </Box>
            </Box>
          )}
        </Box>

        {/* Statistics footer */}
        <Box
          borderStyle="single"
          borderColor="gray"
          padding={1}
          marginTop={2}
          width={contentWidth}
        >
          <Box flexDirection="column">
            <Text color="cyan">📊 Statistics:</Text>
            <Box flexDirection="column">
              <Text color="yellow" wrap="wrap">
                📂 Processed: {stats.processed}/{maxRepos} • 🔍 Details:{' '}
                {stats.detailsFetched}/{stats.processed}
              </Text>
              <Text color="yellow" wrap="wrap">
                📖 READMEs: {stats.readmesFetched}/{stats.processed}
              </Text>
            </Box>
            <Text color="gray" wrap="wrap">
              💡 Use NEBULA_MAX_REPOS=50 to process more repositories
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={contentWidth}>
      <Text color="blue" bold>
        🚀 Nebula - Processing {Math.min(maxRepos, stars.length)} repositories
      </Text>
      <Newline />

      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan">📈 Overall Progress:</Text>
        <ProgressBar
          current={currentIndex}
          total={Math.min(maxRepos, stars.length)}
          width={Math.min(40, contentWidth - 10)}
        />
        <Text color="gray" dimColor wrap="wrap">
          Details: {stats.detailsFetched}/{stats.processed} | READMEs:{' '}
          {stats.readmesFetched}/{stats.processed}
        </Text>
      </Box>

      <Newline />

      {processedRepos.slice(-3).map(
        (
          item,
          index // Show only last 3 repos during processing
        ) => (
          <Box key={index} marginBottom={1}>
            <Text color="green">
              {truncateText(item.repo.full_name, contentWidth - 5)}
            </Text>
            {item.details && (
              <Text color="gray" dimColor>
                {' '}
                ({item.details.stargazers_count} ⭐)
              </Text>
            )}
          </Box>
        )
      )}

      {currentIndex < Math.min(maxRepos, stars.length) && (
        <Box>
          <Spinner type="dots" />
          <Text color="cyan">
            Processing:{' '}
            {truncateText(
              stars[currentIndex]?.full_name || 'Unknown',
              contentWidth - 15
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ---------- Types ----------
type DeviceCodeResp = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};
type TokenResp =
  | { access_token: string; token_type: string; scope: string }
  | { error: string; error_description?: string; error_uri?: string };

type StarredRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
};

// ---------- Config ----------
const TOKEN_PATH = path.join(os.homedir(), '.nebula.json');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000'; // dummy ID - will be rejected by GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Personal access token support
const MAX_REPOS_TO_PROCESS = parseInt(process.env.NEBULA_MAX_REPOS || '10'); // Configurable limit

// GitHub CLI integration
const hasGitHubCLI = async (): Promise<boolean> => {
  try {
    await runCommand('which gh');
    return true;
  } catch {
    return false;
  }
};

const isGitHubCLIAuthenticated = async (): Promise<boolean> => {
  try {
    await runCommand('gh auth status');
    return true;
  } catch {
    return false;
  }
};

const getGitHubCLIToken = async (): Promise<string | null> => {
  try {
    const result = await runCommand('gh auth token');
    return result.trim();
  } catch {
    return null;
  }
};

const runCommand = (cmd: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const [command, ...args] = cmd.split(' ');
    const child = spawn(command, args, { stdio: 'pipe' });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });

    child.on('error', (error: Error) => {
      reject(error);
    });
  });
};

// ---------- Small utils ----------
const writeToken = (token: string) =>
  fs.writeFile(TOKEN_PATH, JSON.stringify({ access_token: token }, null, 2), {
    mode: 0o600,
  });

const readToken = Effect.gen(function* () {
  const raw = yield* Effect.tryPromise({
    try: () => fs.readFile(TOKEN_PATH, 'utf-8'),
    catch: (e) => new Error(String(e)),
  }).pipe(Effect.orElse(() => Effect.succeed('')));

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.access_token === 'string'
      ? parsed.access_token
      : null;
  } catch (error) {
    return null;
  }
});

const removeToken = Effect.tryPromise({
  try: async () => {
    await fs.rm(TOKEN_PATH, { force: true });
  },
  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
});

const parseNextLink = (link: string | null): string | '' => {
  if (!link) return '';
  for (const seg of link.split(',')) {
    const m = seg.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m && m[1]) return m[1];
  }
  return '';
};

// ---------- OAuth Device Flow ----------
const startDeviceFlow = (
  scope = 'public_repo read:user'
): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    if (!CLIENT_ID) {
      yield* Console.error('❌ Error: No GitHub Client ID found.');
      yield* Console.log('');
      yield* Console.log('To use Nebula, choose one of these methods:');
      yield* Console.log('');
      yield* Console.log('🔑 RECOMMENDED: Personal Access Token');
      yield* Console.log('1. Go to https://github.com/settings/tokens');
      yield* Console.log('2. Generate new token (classic)');
      yield* Console.log('3. Name: "Nebula CLI"');
      yield* Console.log('4. Scopes: check "repo" and "read:user"');
      yield* Console.log('5. Copy token and run:');
      yield* Console.log('   export GITHUB_TOKEN=paste_your_token_here');
      yield* Console.log('   bun run index.ts');
      yield* Console.log('');
      yield* Console.log('💻 ALTERNATIVE: GitHub CLI (if installed)');
      yield* Console.log('   gh auth login');
      yield* Console.log('   bun run index.ts  # Auto-detects CLI auth');
      yield* Console.log('');
      yield* Console.log('🔐 ALTERNATIVE: OAuth App');
      yield* Console.log(
        '   Create app at https://github.com/settings/applications/new'
      );
      yield* Console.log('   export GITHUB_CLIENT_ID=your_client_id');
      yield* Console.log('');
      yield* Effect.fail(new Error('GitHub authentication required'));
    }
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

    if (!r.ok) {
      if (r.status === 404) {
        yield* Console.error('❌ Error: Invalid GitHub Client ID.');
        yield* Console.log('');
        yield* Console.log(
          'The provided GitHub Client ID is not valid. You can:'
        );
        yield* Console.log('');
        yield* Console.log('1. Check that GITHUB_CLIENT_ID is set correctly:');
        yield* Console.log(`   Current value: ${CLIENT_ID}`);
        yield* Console.log(
          '2. Verify your OAuth app at: https://github.com/settings/applications'
        );
        yield* Console.log('');
        yield* Console.log(
          '💡 Alternative: Use a Personal Access Token instead:'
        );
        yield* Console.log('   Go to https://github.com/settings/tokens');
        yield* Console.log('   export GITHUB_TOKEN=your_personal_access_token');
        yield* Console.log('');
      } else {
        yield* Effect.fail(
          new Error(`Device code request failed: ${r.status}`)
        );
      }
      yield* Effect.fail(new Error('GitHub OAuth setup required'));
    }
    const json = (yield* Effect.tryPromise({
      try: () => r.json(),
      catch: (e) => new Error(String(e)),
    })) as DeviceCodeResp;

    yield* Console.log('\n== GitHub Login ==');
    yield* Console.log(`1) Open: ${json.verification_uri}`);
    yield* Console.log(`2) Enter code: ${json.user_code}\n`);

    const token = yield* _pollForToken(json);
    return token;
  });

const pollForToken = (dc: DeviceCodeResp): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    // Type assertion to help TypeScript with complex control flow
    return (yield* _pollForToken(dc)) as string;
  });

const _pollForToken = (dc: DeviceCodeResp): Effect.Effect<string, Error> =>
  Effect.gen(function* () {
    const start = Date.now();
    let intervalMs = (dc.interval ?? 5) * 1000;

    while (Date.now() - start < dc.expires_in * 1000) {
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
      if (!resp.ok)
        yield* Effect.fail(new Error(`Token request failed: ${resp.status}`));

      const json = yield* Effect.tryPromise({
        try: async () => resp.json() as Promise<TokenResp>,
        catch: (e) => new Error(String(e)),
      });

      // Handle successful token response
      if (json && typeof json === 'object' && 'access_token' in json) {
        const tokenResp = json as {
          access_token: string;
          token_type: string;
          scope: string;
        };
        if (
          typeof tokenResp.access_token === 'string' &&
          tokenResp.access_token.length > 0
        ) {
          return tokenResp.access_token as string;
        }
      }

      // Handle error response
      if (json && typeof json === 'object' && 'error' in json) {
        const errorResp = json as { error: string; error_description?: string };
        if (errorResp.error === 'authorization_pending') continue;
        if (errorResp.error === 'slow_down') {
          intervalMs += 5000;
          continue;
        }
        if (errorResp.error === 'access_denied')
          yield* Effect.fail(new Error('Login denied in browser.'));
        if (errorResp.error === 'expired_token')
          yield* Effect.fail(new Error('Device code expired. Please retry.'));
        yield* Effect.fail(
          new Error(
            `OAuth error: ${errorResp.error} ${
              errorResp.error_description ?? ''
            }`.trim()
          )
        );
      }

      // If we get here, the response format is unexpected
      yield* Effect.fail(
        new Error('Unexpected response format from GitHub OAuth')
      );
    }
    yield* Effect.fail(new Error('Timed out waiting for authorization.'));
  }) as Effect.Effect<string, Error>;

// ---------- API calls ----------
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

// ---------- Detailed repository information ----------
type DetailedRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  size: number;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  topics: string[];
  license: { name: string } | null;
  owner: {
    login: string;
    avatar_url: string;
    type: string;
  };
};

const getRepoReadme = (
  token: string,
  repoFullName: string
): Effect.Effect<string | null, Error> =>
  Effect.gen(function* () {
    const r = yield* Effect.tryPromise({
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
    });

    if (r.status === 401)
      yield* Effect.fail(new Error('Unauthorized. Token may be invalid.'));
    if (r.status === 403)
      yield* Effect.fail(
        new Error('API rate limit exceeded. Try again later.')
      );
    if (r.status === 404) return null; // README not found, return null instead of error
    if (!r.ok) yield* Effect.fail(new Error(`GitHub error: ${r.status}`));

    const readme = (yield* Effect.tryPromise({
      try: () => r.json(),
      catch: (e) => new Error(String(e)),
    })) as any;

    // Decode base64 content
    if (readme.content && readme.encoding === 'base64') {
      try {
        const decodedContent = Buffer.from(readme.content, 'base64').toString(
          'utf-8'
        );
        // Limit to first 1000 characters for debugging
        return decodedContent.length > 1000
          ? decodedContent.substring(0, 1000) +
              '\n\n[...truncated for debugging...]'
          : decodedContent;
      } catch (decodeError) {
        return null;
      }
    }

    return null;
  });

const getRepoDetails = (
  token: string,
  repoFullName: string
): Effect.Effect<DetailedRepo, Error> =>
  Effect.gen(function* () {
    const r = yield* Effect.tryPromise({
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
    });

    if (r.status === 401)
      yield* Effect.fail(new Error('Unauthorized. Token may be invalid.'));
    if (r.status === 403)
      yield* Effect.fail(
        new Error('API rate limit exceeded. Try again later.')
      );
    if (r.status === 404)
      yield* Effect.fail(new Error('Repository not found or access denied.'));
    if (!r.ok) yield* Effect.fail(new Error(`GitHub error: ${r.status}`));

    const repo = (yield* Effect.tryPromise({
      try: () => r.json(),
      catch: (e) => new Error(String(e)),
    })) as any;

    return {
      full_name: repo.full_name,
      description: repo.description,
      html_url: repo.html_url,
      stargazers_count: repo.stargazers_count,
      language: repo.language,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      size: repo.size,
      fork: repo.fork,
      archived: repo.archived,
      disabled: repo.disabled,
      topics: repo.topics || [],
      license: repo.license,
      owner: {
        login: repo.owner.login,
        avatar_url: repo.owner.avatar_url,
        type: repo.owner.type,
      },
    };
  });

const listStarred = (token: string): Effect.Effect<StarredRepo[], Error> =>
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

      if (r.status === 401)
        yield* Effect.fail(
          new Error('Unauthorized. Run `nebula login` to authenticate.')
        );
      if (!r.ok) yield* Effect.fail(new Error(`GitHub error: ${r.status}`));

      const batch = (yield* Effect.tryPromise({
        try: () => r.json(),
        catch: (e) => new Error(String(e)),
      })) as any[];

      for (const it of batch) {
        all.push({
          full_name: it.full_name,
          description: it.description,
          html_url: it.html_url,
          stargazers_count: it.stargazers_count,
          language: it.language,
        });
      }
      url = parseNextLink(r.headers.get('link'));
    }
    return all;
  });

// ---------- Main Ink App ----------
const main = Effect.gen(function* () {
  const [, , cmd] = process.argv;

  if (cmd === 'logout') {
    yield* removeToken;
    console.log('🗑️  Removed saved token.');
    return;
  }

  let token = yield* readToken;

  // If no token saved, try GitHub CLI first
  if (!token) {
    const hasCLI = yield* Effect.tryPromise({
      try: () => hasGitHubCLI(),
      catch: () => false,
    });

    if (hasCLI) {
      const isAuthenticated = yield* Effect.tryPromise({
        try: () => isGitHubCLIAuthenticated(),
        catch: () => false,
      });

      if (isAuthenticated) {
        const cliToken = yield* Effect.tryPromise({
          try: () => getGitHubCLIToken(),
          catch: () => null,
        });

        if (cliToken) {
          yield* Effect.tryPromise({
            try: () => writeToken(cliToken),
            catch: (e) => new Error(String(e)),
          });
          token = cliToken;
          const me = yield* whoAmI(token);
          console.log(
            `✅ Using GitHub CLI authentication. Logged in as ${
              me?.login ?? 'unknown'
            }. Saved token to ${TOKEN_PATH}`
          );
        }
      } else {
        console.log('🔐 GitHub CLI found but not authenticated.');
        console.log('Run the following command to authenticate:');
        console.log('');
        console.log('  gh auth login');
        console.log('');
        console.log('Then run nebula again.');
        console.log('');
        yield* Effect.fail(new Error('GitHub CLI authentication required'));
      }
    }
  }

  // If GITHUB_TOKEN is provided via environment, use it directly (fallback)
  if (GITHUB_TOKEN && !token) {
    yield* Effect.tryPromise({
      try: () => writeToken(GITHUB_TOKEN),
      catch: (e) => new Error(String(e)),
    });
    token = GITHUB_TOKEN;
    const me = yield* whoAmI(token);
    console.log(
      `✅ Using GitHub token from environment. Logged in as ${
        me?.login ?? 'unknown'
      }. Saved token to ${TOKEN_PATH}`
    );
  }

  if (cmd === 'login' || !token) {
    // If user has GITHUB_TOKEN but wants to force login, inform them
    if (GITHUB_TOKEN && cmd === 'login') {
      console.log(
        'ℹ️  You have GITHUB_TOKEN set. Use `nebula logout` first if you want to use OAuth instead.'
      );
      return;
    }

    const t = yield* startDeviceFlow(); // scope: public repos by default
    yield* Effect.tryPromise({
      try: () => writeToken(t),
      catch: (e) => new Error(String(e)),
    });
    token = t;
    const me = yield* whoAmI(token);
    console.log(
      `✅ Logged in as ${me?.login ?? 'unknown'}. Saved token to ${TOKEN_PATH}`
    );
    if (cmd === 'login') return;
  }

  const me = yield* whoAmI(token!);
  if (me) console.log(`\n⭐ Starred repos for @${me.login}\n`);

  const stars = yield* listStarred(token!);
  if (stars.length === 0) {
    console.log('No starred repositories found.');
    return;
  }

  // Use Ink UI for the main processing
  const { waitUntilExit } = render(
    <NebulaApp
      stars={stars}
      maxRepos={MAX_REPOS_TO_PROCESS}
      token={token!}
      onComplete={(stats) => {
        console.log('\n✅ All processing complete!');
      }}
    />
  );

  yield* Effect.tryPromise({
    try: () => waitUntilExit(),
    catch: (e) => new Error(String(e)),
  });
}).pipe(
  Effect.provide(
    Layer.setConfigProvider(ConfigProvider.fromEnv()) // ready if you add more config later
  )
);

// ---------- Run ----------
Effect.runPromise(main).catch((e) => {
  console.error('Error:', e?.message ?? e);
  process.exit(1);
});
