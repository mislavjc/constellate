import { Effect, Console } from 'effect';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './utils';

const TOKEN_PATH = path.join(os.homedir(), '.nebula.json');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

export const hasGitHubCLI = (): Effect.Effect<boolean> =>
  runCommand('which gh').pipe(
    Effect.map(() => true),
    Effect.orElse(() => Effect.succeed(false))
  );
export const isGitHubCLIAuthenticated = (): Effect.Effect<boolean> =>
  runCommand('gh auth status').pipe(
    Effect.map(() => true),
    Effect.orElse(() => Effect.succeed(false))
  );

export const getGitHubCLIToken = (): Effect.Effect<string | null> =>
  runCommand('gh auth token').pipe(
    Effect.map((t) => t.trim()),
    Effect.orElse(() => Effect.succeed(null))
  );

export const writeToken = (token: string) =>
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

export const readToken = Effect.gen(function* () {
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

export const removeToken = Effect.tryPromise({
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

export const startDeviceFlow = (
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
export const whoAmI = (token: string) =>
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

/**
 * Ensures a valid GitHub token is available, trying multiple sources in order:
 * 1. Saved token file
 * 2. GitHub CLI (if available and authenticated)
 * 3. Environment variable GITHUB_TOKEN
 * 4. Device flow authentication (if interactive)
 *
 * @param options Configuration options
 * @param options.interactive Whether to allow interactive authentication (device flow)
 * @param options.forceLogin Whether to force login even if token exists
 * @returns Effect that resolves to a valid GitHub token
 */
export const ensureAuthenticatedToken = (
  options: { interactive?: boolean; forceLogin?: boolean } = {}
) =>
  Effect.gen(function* () {
    const { interactive = true, forceLogin = false } = options;

    // If not forcing login, try existing sources first
    if (!forceLogin) {
      // 1. Try saved token
      const savedToken = yield* readToken;
      if (savedToken) {
        // Validate the token
        const user = yield* whoAmI(savedToken);
        if (user) {
          return savedToken;
        }
        // Token is invalid, remove it
        yield* Console.log('Saved token is invalid, removing...');
        yield* removeToken;
      }

      // 2. Try GitHub CLI
      const hasCLI = yield* hasGitHubCLI();
      if (hasCLI) {
        const cliAuthenticated = yield* isGitHubCLIAuthenticated();
        if (cliAuthenticated) {
          const cliToken = yield* getGitHubCLIToken();
          if (cliToken) {
            // Validate and save the CLI token
            const user = yield* whoAmI(cliToken);
            if (user) {
              yield* writeToken(cliToken);
              return cliToken;
            }
          }
        } else {
          yield* Console.log(
            '🔐 GitHub CLI found but not authenticated. Run `gh auth login` or use another authentication method.'
          );
        }
      }

      // 3. Try environment variable
      if (GITHUB_TOKEN) {
        // Validate the environment token
        const user = yield* whoAmI(GITHUB_TOKEN);
        if (user) {
          yield* writeToken(GITHUB_TOKEN);
          return GITHUB_TOKEN;
        } else {
          return yield* Effect.fail(
            new Error(
              'GITHUB_TOKEN environment variable contains an invalid token'
            )
          );
        }
      }
    }

    // 4. If interactive, start device flow
    if (interactive) {
      if (GITHUB_TOKEN && forceLogin) {
        yield* Console.log(
          'ℹ️  You have GITHUB_TOKEN set. Use `nebula logout` first to use OAuth.'
        );
        return yield* Effect.fail(
          new Error('GITHUB_TOKEN is set, cannot use interactive login')
        );
      }

      const token = yield* startDeviceFlow();
      const user = yield* whoAmI(token);
      if (user) {
        yield* writeToken(token);
        yield* Console.log(
          `✅ Logged in as ${user.login}. Saved token to ${TOKEN_PATH}`
        );
        return token;
      } else {
        return yield* Effect.fail(
          new Error('Failed to validate token from device flow')
        );
      }
    }

    return yield* Effect.fail(
      new Error(
        'No valid GitHub token found. Please:\n' +
          '1. Set GITHUB_TOKEN environment variable, or\n' +
          '2. Authenticate with GitHub CLI (`gh auth login`), or\n' +
          '3. Run the interactive login flow'
      )
    );
  });
