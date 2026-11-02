// What a GPU suite shares with other suites, read from the files it runs, so scripts/support/parallel-run.mjs never
// runs two users of one thing at once: a fixed port (listenWhenFree would make the second wait, up to 20 min, holding a
// GPU slot), an output path under test-results (two runs would overwrite each other's report or capture), or Vite's
// default dependency cache (a re-optimize answers the other server's page 504, bug 26). It over-counts on purpose: a
// false conflict costs seconds, a missed one a wait or a wrong report.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** scripts/browser.js: the default port of openBrowser and startDevServer when a call names none. */
export const DEFAULT_BROWSER_PORT = 5193;

const PORTS = [
  /\b\w*port\s*[:=]\s*(\d{4,5})\b/gi,
  /\.listen\(\s*(\d{4,5})\b/g,
  /(?:127\.0\.0\.1|localhost):(\d{4,5})\b/g,
  /--port[= ](\d{4,5})\b/g,
];
const noComments = (text) => text.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, '');

/** Fixed ports in a file's text, the default port included for an openBrowser or startDevServer call without `port`. */
export function fixedPorts(text) {
  const code = noComments(text),
    found = new Set();
  for (const pattern of PORTS) for (const m of code.matchAll(pattern)) found.add(Number(m[1]));
  for (const m of code.matchAll(/(?<!function\s)\b(?:openBrowser|startDevServer)\(/g)) {
    let depth = 1,
      i = m.index + m[0].length;
    for (; depth && i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    if (!/\bport\b/i.test(code.slice(m.index, i))) found.add(DEFAULT_BROWSER_PORT);
  }
  return [...found].sort((a, b) => a - b);
}

/** Paths a file writes or names under test-results, cut to `test-results/<first name>`; reads of the venv are left out. */
export function outputPaths(text) {
  const code = noComments(text),
    found = new Set();
  for (const m of code.matchAll(/['"`]test-results\/([\w.-]+)/g)) found.add(m[1]);
  for (const m of code.matchAll(/['"`]test-results['"`]\s*,\s*['"`]([\w.-]+)/g)) found.add(m[1]);
  for (const name of ['.venv-data', 'gpu-packages.json', 'gpu.lock']) found.delete(name);
  return [...found].sort().map((name) => `test-results/${name}`);
}

/** True for a Vite dev server on the default dependency cache that may optimize into it (no cacheDir, discovery on). */
export function usesDefaultViteCache(text) {
  return (
    /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*['"]vite['"]/.test(text) &&
    !/\bcacheDir\b/.test(text) &&
    !/\bnoDiscovery:\s*true/.test(text)
  );
}

/** Resource names of one file's text: `port:<n>`, `out:<path>`, `vite-default-cache`. */
export function fileResources(text) {
  return [
    ...fixedPorts(text).map((port) => `port:${port}`),
    ...outputPaths(text).map((path) => `out:${path}`),
    ...(usesDefaultViteCache(text) ? ['vite-default-cache'] : []),
  ];
}

// scripts/browser.js holds the default port itself, and its cache root is one fresh folder per server.
const HELPERS = new Set(['scripts/browser.js']);
const SPECS = /(?:\bnew URL\(\s*|\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"\n]+)['"]/g;
const NAMED = /['"`/]((?:scripts|tests|examples|packages)\/[\w./-]+\.m?js)\b/g;
const IGNORED = /(^|\/)(src|dist|node_modules)\//;

/** Repo files a command runs: its `node <file>` paths following `cd`, and `npm run <name>` through `scripts`, once each. */
export function commandFiles(cwd, command, scripts = {}, seen = new Set()) {
  const files = [];
  for (const part of command.split(/&&|\|\||;/)) {
    const name = /\bnpm run ([\w:.-]+)/.exec(part)?.[1];
    if (name) {
      if (scripts[name] && !/--workspace\b/.test(part) && !seen.has(name)) {
        seen.add(name);
        files.push(...commandFiles('.', scripts[name], scripts, seen));
      }
      continue;
    }
    const cd = /^\s*cd (\S+)\s*$/.exec(part)?.[1];
    if (cd) cwd = join(cwd, cd);
    else for (const m of part.match(/[\w./-]+\.m?js\b/g) ?? []) files.push(join(cwd, m).split(sep).join('/'));
  }
  return files;
}

/**
 * The resources of each planned suite: `{ [id]: [names] }`, read from the files its command runs (`scripts`: the root
 * package.json scripts; `prepare`: commands a root suite needs first) and every test or script file those import or name
 * by path, another package's included (webgl2-compat replays other packages' checks). Package sources are not followed.
 */
export function suiteResources(root, steps, { scripts = {}, prepare = {} } = {}) {
  const out = {},
    read = (file) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
  for (const step of steps) {
    const seen = new Set(),
      names = new Set(),
      queue = [
        ...commandFiles(step.cwd ?? '.', step.command, scripts),
        ...(prepare[step.name] ?? []).flatMap((c) => commandFiles('.', c, scripts)),
      ];
    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file) || IGNORED.test(file) || relative(root, join(root, file)).startsWith('..')) continue;
      seen.add(file);
      const text = read(file);
      if (!HELPERS.has(file)) for (const name of fileResources(text)) names.add(name);
      for (const [, spec] of text.matchAll(SPECS)) {
        const rel = relative(root, resolve(root, dirname(file), spec))
          .split(sep)
          .join('/');
        if (/\.m?js$/.test(rel)) queue.push(rel);
      }
      for (const [, path] of text.matchAll(NAMED)) queue.push(path);
    }
    out[step.id] = [...names].sort();
  }
  return out;
}
