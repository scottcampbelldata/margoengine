// Positive classification of GPU leaves, never of aggregators that happen to contain one.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// The repository's browser launchers: a script that loads one (directly or through its own relative imports) opens a
// real browser on the GPU. Bare playwright imports count too.
const LAUNCHERS = ['scripts/browser.js', 'scripts/lib/browser.mjs', 'scripts/support/browser-host.mjs'];
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;

/**
 * Whether the node script at `file` opens a browser: it imports playwright, or one of the repository's launchers,
 * itself or through relative imports up to `depth` files deep (KB-GL1: browser checks whose names carry no GPU word
 * were refused by `run`, so helpers ran them outside the slot cap).
 */
export function opensBrowser(file, { read = (path) => readFileSync(path, 'utf8'), exists = existsSync, depth = 3 } = {}) {
  const seen = new Set();
  const visit = (path, left) => {
    if (seen.has(path) || !exists(path)) return false;
    seen.add(path);
    let text;
    try {
      text = read(path);
    } catch {
      return false;
    }
    for (const [, , spec] of text.matchAll(SPECIFIER)) {
      if (/^playwright(-core)?($|\/)/.test(spec)) return true;
      if (!spec.startsWith('.')) continue;
      const target = resolve(dirname(path), spec),
        slashed = target.replaceAll('\\', '/');
      if (LAUNCHERS.some((launcher) => slashed.endsWith('/' + launcher))) return true;
      if (left > 0 && /\.[cm]?js$/.test(target) && visit(target, left - 1)) return true;
    }
    return false;
  };
  return visit(resolve(file), depth);
}

export function gpuCommand(words, { cwd = process.cwd(), opens = opensBrowser } = {}) {
  const program = basename((words[0] ?? '').replaceAll('\\', '/'))
    .replace(/\.(exe|cmd)$/i, '')
    .toLowerCase();
  let leaf;
  if (/^(npm|pnpm|yarn)$/.test(program)) {
    const at = words.findIndex((word) => /^(run|run-script)$/.test(word));
    leaf = at < 0 ? words[1] : words[at + 1];
    // A GPU word in any part of a test script's name: test:gpu, test:gpu:x and package suites such as test:mtoon:browser.
    if (/^(test(:[\w-]+)*?:(gpu|browser|xr)(:|$)|check:readme-run$)/.test(leaf ?? '')) return 'gpu';
    if (/^(verify|lint|hygiene|build|typecheck|check|test)(:|$)/.test(leaf ?? '')) return 'cpu';
    return 'unknown';
  }
  if (/^(tsc|eslint|vitest|jest|mocha|cargo|rustc|cmake|make|cmd|powershell|pwsh|bash|sh)$/.test(program)) return 'cpu';
  if (/^node$/.test(program)) {
    if (words.some((word) => word === '--test' || word.startsWith('--test='))) return 'cpu';
    // Inline code is not a script identity. Its strings/arguments cannot classify the command.
    if (words.some((word) => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(word))) return 'unknown';
    for (let i = 1; i < words.length; i++) {
      if (['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions'].includes(words[i])) {
        i++;
        continue;
      }
      if (words[i].startsWith('-')) continue;
      leaf = words[i].replaceAll('\\', '/');
      break;
    }
    if (!leaf) return 'unknown';
    const name = basename(leaf);
    if (
      /^(verify|lint|hygiene|build|typecheck|tsc|check-merge|run-unit-tests)\b/i.test(name) ||
      /\.test\.[cm]?[jt]s$/.test(name)
    )
      return 'cpu';
    if (
      /(^|[-_.])(gpu|browser|pixels?|capture|render|xr)([-_.]|$)/i.test(name) ||
      /^(run-readme-examples|gpu-package-tests)\./.test(name)
    )
      return 'gpu';
    if (/\.[cm]?js$/.test(name) && opens(resolve(cwd, leaf))) return 'gpu';
  }
  return 'unknown';
}
