// The built package as a classic script for a blank page: its export list becomes globalThis.__compat. Shared by the
// capability report (scripts/capabilities.mjs) and the browser check (test/browser-check.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Script text that defines globalThis.__compat with every export of dist/index.js. */
export function probeScript() {
  const source = readFileSync(join(import.meta.dirname, '..', 'dist', 'index.js'), 'utf8');
  return `{${source.replace(
    /export\s*\{([^}]*)\};?\s*$/,
    (_, list) =>
      `globalThis.__compat = {${list
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/))
        .map(([local, name]) => `${name ?? local}: ${local}`)
        .join(', ')}};`,
  )}}`;
}
