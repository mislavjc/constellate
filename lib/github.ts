import { Effect } from 'effect';
import { parseNextLink } from './utils';


export type StarredRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
};

export type DetailedRepo = {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at: string;
  updated_at: string;
  pushed_at?: string;
  size: number;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  topics: string[];
  license: { name: string } | null;
  owner: { login: string; avatar_url: string; type: string };
};

export const getRepoDetails = (token: string, repoFullName: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repoFullName}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'constellator',
        },
      }),
    catch: (e) => new Error(String(e)),
  }).pipe(
    Effect.flatMap((r) =>
      r.ok
        ? Effect.succeed(r)
        : Effect.fail(new Error(`GitHub error ${r.status}`))
    ),
    Effect.flatMap((r) =>
      Effect.tryPromise({
        try: () => r.json() as Promise<any>,
        catch: (e) => new Error(String(e)),
      })
    ),
    Effect.map(
      (repo: Record<string, unknown>): DetailedRepo => ({
        full_name: repo.full_name as string,
        description: repo.description as string | null,
        html_url: repo.html_url as string,
        stargazers_count: repo.stargazers_count as number,
        language: repo.language as string | null,
        created_at: repo.created_at as string,
        updated_at: repo.updated_at as string,
        pushed_at: repo.pushed_at as string | undefined,
        size: repo.size as number,
        fork: repo.fork as boolean,
        archived: repo.archived as boolean,
        disabled: repo.disabled as boolean,
        topics: (repo.topics as string[]) || [],
        license: repo.license as { name: string } | null,
        owner: {
          login: (repo.owner as Record<string, unknown>).login as string,
          avatar_url: (repo.owner as Record<string, unknown>)
            .avatar_url as string,
          type: (repo.owner as Record<string, unknown>).type as string,
        },
      })
    )
  );

export const getRepoReadme = (token: string, repoFullName: string) =>
  Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repoFullName}/readme`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'constellator',
        },
      }),
    catch: (e) => new Error(String(e)),
  }).pipe(
    Effect.flatMap((r) => {
      if (r.status === 404) return Effect.succeed(null);
      if (!r.ok) return Effect.fail(new Error(`GitHub error ${r.status}`));
      return Effect.tryPromise({
        try: () => r.json() as Promise<any>,
        catch: (e) => new Error(String(e)),
      });
    }),
    Effect.map((json: Record<string, unknown> | null) => {
      if (!json?.content || json.encoding !== 'base64') return null;
      try {
        return Buffer.from(json.content as string, 'base64').toString('utf-8');
      } catch {
        return null;
      }
    })
  );

export const listStarred = (token: string) =>
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
              'User-Agent': 'constellator',
            },
          }),
        catch: (e) => new Error(String(e)),
      });
      if (!r.ok) yield* Effect.fail(new Error(`GitHub error ${r.status}`));
      const batch = (yield* Effect.tryPromise({
        try: () => r.json() as Promise<StarredRepo[]>,
        catch: (e) => new Error(String(e)),
      })) as StarredRepo[];
      for (const it of batch)
        all.push({
          full_name: it.full_name,
          description: it.description,
          html_url: it.html_url,
          stargazers_count: it.stargazers_count,
          language: it.language,
        });
      url = parseNextLink(r.headers.get('link'));
    }
    return all;
  });
