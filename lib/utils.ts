import { Effect } from 'effect';

export const runCommand = (cmd: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { spawn } = require('child_process');
        const [command, ...args] = cmd.split(' ');
        const child = spawn(command, args, { stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('close', (code: number) =>
          code === 0
            ? resolve(stdout)
            : reject(new Error(stderr || `Command failed ${code}`))
        );
        child.on('error', (e: Error) => reject(e));
      }),
    catch: e => new Error(String(e)),
  });

export const parseNextLink = (link: string | null): string | '' => {
  if (!link) return '';
  for (const seg of link.split(',')) {
    const m = seg.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (m && m[1]) return m[1];
  }
  return '';
};

export const daysSince = (iso?: string): number | undefined => {
  if (!iso?.trim()) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
};

export const batch = <T>(arr: T[], size: number): T[][] => {
  if (size <= 0) throw new Error('Batch size must be positive');
  if (arr.length === 0) return [];

  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
};
