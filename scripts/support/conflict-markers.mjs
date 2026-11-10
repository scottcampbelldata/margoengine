import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Inspect the working content of tracked text, including old markers outside the current diff.
export function conflictMarkers(root) {
  const git = (args, input) =>
    execFileSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 << 20 });
  const files = git(['ls-files', '-z'])
    .split('\0')
    .filter((file) => file && (file.startsWith('docs/') || /\.(md|ts|js|json|mjs|wgsl|glsl)$/i.test(file)));
  if (!files.length) return [];
  const attrs = git(['check-attr', '-z', '--stdin', 'filter', 'diff'], files.join('\0') + '\0').split('\0');
  const excluded = new Set();
  for (let i = 0; i + 2 < attrs.length; i += 3)
    if ((attrs[i + 1] === 'filter' && attrs[i + 2] === 'lfs') || (attrs[i + 1] === 'diff' && attrs[i + 2] === 'unset'))
      excluded.add(attrs[i]);
  const findings = [];
  for (const file of files) {
    if (excluded.has(file)) continue;
    const path = join(root, file);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (
      text.startsWith('version https://git-lfs.github.com/spec/v1\n') ||
      text.startsWith('version https://git-lfs.github.com/spec/v1\r\n')
    )
      continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++)
      if (/^(?:<<<<<<< |=======$|>>>>>>>)/.test(lines[i])) findings.push(`${file}:${i + 1}`);
  }
  return findings;
}

export function assertNoConflictMarkers(root) {
  const findings = conflictMarkers(root);
  if (findings.length)
    throw new Error(
      `Unresolved conflict markers; preserve both sides and resolve these lines:\n${findings.join('\n')}`,
    );
}
