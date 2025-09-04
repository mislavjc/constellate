import { Effect, Console } from 'effect';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { runCommand } from './utils';

const TOKEN_PATH = path.join(os.homedir(), '.constellator.json');
const CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? 'Iv1.0000000000000000';
const isClientIdPlaceholder = (id: string | undefined): boolean => {
  if (!id) return true;
  return id === 'Iv1.0000000000000000' || /Iv1\.0{16,}/.test(id);
};
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

async function saveTokenToDotEnv(token: string): Promise<void> {
  const envPath = path.join(process.cwd(), '.env');
  let existing = '';
  try {
    existing = await fs.readFile(envPath, 'utf-8');
  } catch {}
  const lines = existing.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const withoutToken = lines.filter((l) => !/^\s*GITHUB_TOKEN\s*=/.test(l));
  withoutToken.push(`GITHUB_TOKEN=${token}`);
  const content = withoutToken.join('\n') + '\n';
  await fs.writeFile(envPath, content, 'utf-8');
  process.env.GITHUB_TOKEN = token;
}

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
    if (isClientIdPlaceholder(CLIENT_ID))
      yield* Effect.fail(
        new Error(
          'Interactive login is not configured. Set GITHUB_CLIENT_ID to your GitHub OAuth app client id, or use one of:\n' +
            '  • gh auth login (then re-run)\n' +
            '  • set GITHUB_TOKEN in .constellator/config.json and re-run'
        )
      );
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
      yield* Effect.fail(
        new Error(
          `Device code request failed: ${r.status}. If this persists, verify GITHUB_CLIENT_ID is a valid OAuth app client id.`
        )
      );
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
          'User-Agent': 'constellator',
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

    // 4. If interactive, start device flow or guide manual PAT flow
    if (interactive) {
      // Prefer GitHub CLI if available (works without OAuth app)
      const hasCLIInteractive = yield* hasGitHubCLI();
      if (hasCLIInteractive) {
        const cliAuthenticated = yield* isGitHubCLIAuthenticated();
        if (cliAuthenticated) {
          const cliToken = yield* getGitHubCLIToken();
          if (cliToken) {
            const cliUser = yield* whoAmI(cliToken);
            if (cliUser) {
              yield* writeToken(cliToken);
              yield* Effect.tryPromise({
                try: () => saveTokenToDotEnv(cliToken),
                catch: (e) => new Error(String(e)),
              });
              return cliToken;
            }
          }
        } else {
          yield* Console.log(
            '🔐 GitHub CLI found but not authenticated. Run `gh auth login` and then re-run this command.'
          );
        }
      }
      if (GITHUB_TOKEN && forceLogin) {
        yield* Console.log(
          'ℹ️  You have GITHUB_TOKEN set. Use `constellator logout` first to use OAuth.'
        );
        return yield* Effect.fail(
          new Error('GITHUB_TOKEN is set, cannot use interactive login')
        );
      }

      // If no OAuth client id is configured, offer a manual PAT flow
      if (isClientIdPlaceholder(CLIENT_ID)) {
        yield* Console.log(
          '\nGitHub OAuth app is not configured for device flow.'
        );
        yield* Console.log(
          'You can quickly create a Personal Access Token (PAT):\n' +
            '  1) Open: https://github.com/settings/tokens/new?scopes=read:user,public_repo\n' +
            '  2) Copy the token and paste it below.'
        );

        const tokenFromPrompt = yield* Effect.tryPromise({
          try: () =>
            new Promise<string>((resolve) => {
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              rl.question('Paste token here: ', (answer) => {
                rl.close();
                resolve(answer.trim());
              });
            }),
          catch: (e) => new Error(String(e)),
        });

        if (!tokenFromPrompt) {
          return yield* Effect.fail(new Error('No token entered'));
        }

        const user = yield* whoAmI(tokenFromPrompt);
        if (user) {
          yield* writeToken(tokenFromPrompt);
          yield* Effect.tryPromise({
            try: () => saveTokenToDotEnv(tokenFromPrompt),
            catch: (e) => new Error(String(e)),
          });
          yield* Console.log(
            `✅ Logged in as ${user.login}. Saved token to ${TOKEN_PATH} and .env`
          );
          return tokenFromPrompt;
        }

        return yield* Effect.fail(
          new Error('Failed to validate token. Please try again.')
        );
      }

      const token = yield* startDeviceFlow();
      const user = yield* whoAmI(token);
      if (user) {
        yield* writeToken(token);
        yield* Effect.tryPromise({
          try: () => saveTokenToDotEnv(token),
          catch: (e) => new Error(String(e)),
        });
        yield* Console.log(
          `✅ Logged in as ${user.login}. Saved token to ${TOKEN_PATH} and .env`
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
