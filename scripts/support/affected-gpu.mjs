// Which GPU work a change affects (`npm run check:merge`, scripts/check-merge.mjs).
//
// 1. The changed files (merge base with origin/main) map to workspace packages; every package that depends on them,
//    transitively, is affected too (the workspace dependency graph).
// 2. Each GPU step has a footprint: the packages and files it exercises, found by reading its sources (a package's
//    test dirs, a check script and the pages it opens, a demo's html and the modules it imports). A step runs when
//    its footprint meets the affected set; the visual check runs only the demos whose footprint does.
// 3. Anything unsure runs everything: core, stage, shared or the margoengine umbrella; build scripts, check scripts,
//    package.json and lock files; a WGSL file outside a package; a file nothing classifies; more than MAX_AFFECTED
//    packages; MARGO_FULL=1.
// Everything here is pure (files and a package graph in, a decision out) except the readers at the bottom.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { demos } from './visual-demos.js';

/** More affected packages than this (dependents included) and the full GPU run is cheaper than being wrong. */
export const MAX_AFFECTED = 12;

/** Package directories whose change always runs everything: all depend on, or are, the engine's shared floor. */
export const FULL_DIRS = ['packages/core', 'packages/stage', 'packages/shared', 'packages/margoengine'];

const posix = (path) => path.replaceAll('\\', '/');
const TEXT = /\.(html|m?js|tsx?|css)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'test-results',
  'assets',
  'target',
  '.next',
  'test',
  'tests',
]);
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '.html', '.css', '/index.ts', '/index.js'];

/** [{ name, dir, deps }] for every workspace in the root package.json (deps: workspace names it depends on). */
export function loadWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const found = [];
  for (const dir of manifest.workspaces) {
    const file = join(root, dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    found.push({
      name: pkg.name,
      dir: posix(dir),
      deps: [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies].flatMap((d) =>
        Object.keys(d ?? {}),
      ),
    });
  }
  const names = new Set(found.map((w) => w.name));
  return found.map((w) => ({ ...w, deps: [...new Set(w.deps.filter((d) => names.has(d)))] }));
}

/** The seeds plus every workspace that depends on one of them, directly or through others. Returns a Set of names. */
export function dependents(workspaces, seeds) {
  const reverse = new Map();
  for (const w of workspaces) for (const d of w.deps) reverse.set(d, [...(reverse.get(d) ?? []), w.name]);
  const out = new Set(seeds),
    queue = [...seeds];
  while (queue.length)
    for (const name of reverse.get(queue.pop()) ?? []) if (!out.has(name)) out.add(name), queue.push(name);
  return out;
}

/** The workspace whose directory holds `file` (the deepest one), or undefined. */
export function workspaceOf(workspaces, file) {
  let best;
  for (const w of workspaces) if (file.startsWith(`${w.dir}/`) && (!best || w.dir.length > best.dir.length)) best = w;
  return best;
}

/** Why a file forces the full run, or undefined. Documents never do; WGSL inside a package belongs to that package. */
export function fullReason(file, workspaces) {
  if (file.endsWith('.md') || isQualityBaseline(file)) return undefined;
  if (
    /(^|\/)package\.json$/.test(file) ||
    /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(file) ||
    file.endsWith('.npmrc')
  )
    return 'package.json or lock file changed';
  if (file.startsWith('scripts/')) return 'build or check script changed';
  if (
    file.startsWith('.github/') ||
    /^(biome|tsconfig[\w.-]*|rust-toolchain)\.(json|toml)$/.test(file) ||
    /^vite\.config\./.test(file)
  )
    return 'build configuration changed';
  const dir = FULL_DIRS.find((d) => file.startsWith(`${d}/`));
  if (dir) return `${dir.slice(9)} changed`;
  if (file.endsWith('.wgsl') && !workspaceOf(workspaces, file)) return 'WGSL outside a package changed';
  return undefined;
}

/** The quality gate's recorded baselines: data that only `npm run quality` reads, so a new baseline changes no GPU test. */
export const isQualityBaseline = (file) => /^scripts\/quality\/baselines\/[\w.-]+\.json$/.test(file);

/** True for files that never change what a GPU test draws or checks (documents, licences, site pages, ignore files). */
export function isInert(file) {
  return (
    file.endsWith('.md') ||
    isQualityBaseline(file) ||
    /^(LICENSE|NOTICE|\.gitignore|\.gitattributes)$/.test(file) ||
    file.startsWith('docs/') ||
    file.startsWith('site/') ||
    file.startsWith('private/')
  );
}

/**
 * What a change needs. `footprints`: { [stepId]: { packages: Set<name>, files: Set<path>, patterns: RegExp[], all: boolean } }.
 * Returns { mode: 'full' | 'affected', reason, changed, affected, hits } where hits are the footprint ids to run.
 */
export function analyse({ files, workspaces, footprints, env = {}, max = MAX_AFFECTED }) {
  const full = (reason) => ({ mode: 'full', reason, changed: [], affected: [], hits: Object.keys(footprints) });
  if (env.MARGO_FULL === '1') return full('MARGO_FULL=1');
  const changed = new Set(),
    loose = [];
  for (const raw of files) {
    const file = posix(raw),
      reason = fullReason(file, workspaces);
    if (reason) return full(`${reason} (${file})`);
    const owner = file.endsWith('.md') ? undefined : workspaceOf(workspaces, file);
    if (owner) changed.add(owner.name);
    else loose.push(file);
  }
  const fileHit = (print, file) => print.files.has(file) || print.patterns.some((p) => p.test(file)),
    touched = new Set();
  for (const file of loose) {
    const hit = Object.entries(footprints).filter(([, print]) => fileHit(print, file));
    for (const [id] of hit) touched.add(id);
    if (!hit.length && !isInert(file)) return full(`cannot classify ${file}`);
  }
  const affected = dependents(workspaces, changed);
  if (affected.size > max)
    return full(
      `${affected.size} packages affected, more than ${max} (${[...changed].join(', ')} and their dependents)`,
    );
  const hits = Object.entries(footprints)
    .filter(
      ([id, print]) =>
        touched.has(id) || (affected.size && (print.all || [...print.packages].some((p) => affected.has(p)))),
    )
    .map(([id]) => id);
  const reason = changed.size
    ? `changed ${[...changed].join(', ')}; affected ${affected.size} package${affected.size === 1 ? '' : 's'}`
    : loose.length
      ? 'no package changed (documents, site pages and demo sources only)'
      : 'no changed files';
  return { mode: 'affected', reason, changed: [...changed], affected: [...affected], hits };
}

// ---- Footprints: read the sources a GPU step runs. ----

/** Files under a path (a file itself, or a directory without node_modules, dist and asset folders), repo-relative. */
function expand(root, path) {
  const abs = join(root, path);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [posix(path)];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? SKIP_DIRS.has(e.name)
        ? []
        : expand(root, `${path}/${e.name}`)
      : TEXT.test(e.name)
        ? [posix(`${path}/${e.name}`)]
        : [],
  );
}

/**
 * The packages and files a set of entry paths reaches: relative and root-absolute imports and src/href attributes are
 * followed through files outside any other workspace; a hit inside another workspace records that workspace instead.
 * `@margoengine/x` and `packages/x/` mentions record workspaces; a bare `packages/` (a loop over all) sets `all`.
 */
export function scan(root, entries, workspaces) {
  const byName = new Map(workspaces.map((w) => [w.name, w])),
    byDir = new Map(workspaces.map((w) => [w.dir, w])),
    packages = new Set(),
    files = new Set(),
    queue = entries.flatMap((entry) => expand(root, entry)),
    entryOwner = new Map();
  let all = false;
  for (const file of queue) entryOwner.set(file, workspaceOf(workspaces, file));
  for (const file of queue) if (entryOwner.get(file)) packages.add(entryOwner.get(file).name);
  while (queue.length) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    if (!TEXT.test(file)) continue;
    const text = readFileSync(join(root, file), 'utf8'),
      owner = workspaceOf(workspaces, file);
    for (const m of text.matchAll(/@margoengine\/([a-z0-9-]+)/g))
      if (byName.has(`@margoengine/${m[1]}`)) packages.add(`@margoengine/${m[1]}`);
    // The umbrella re-exports: `margoengine/dof` is @margoengine/dof, and the bare `margoengine` import is the stage
    // (packages/margoengine/src/index.ts), not the 77 packages the umbrella lists for its subpaths.
    for (const m of text.matchAll(/['"`]margoengine(?:\/([a-z0-9-]+)[^'"`]*)?['"`]/g)) {
      const sub = m[1] && byName.get(`@margoengine/${m[1]}`);
      if (sub) packages.add(sub.name);
      else if (byName.has('@margoengine/stage')) packages.add('@margoengine/stage');
    }
    for (const m of text.matchAll(/\b(packages|examples|apps)\/([a-z0-9-]+)\b/g)) {
      const w = byDir.get(`${m[1]}/${m[2]}`);
      if (w) packages.add(w.name);
    }
    if (/\bpackages\/(?![a-z0-9-])/.test(text)) all = true;
    const specs = text.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bsrc\s*=\s*|\bhref\s*=\s*|new URL\(\s*)['"]([^'"\n]+)['"]/g,
    );
    for (const [, spec] of specs) {
      if (!/^(\.|\/[^/])/.test(spec)) continue;
      const base = spec.startsWith('/')
        ? join(root, spec.split(/[?#]/)[0])
        : resolve(root, dirname(file), spec.split(/[?#]/)[0]);
      const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts')].flatMap((b) =>
        EXTENSIONS.map((e) => b + e),
      );
      const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
      if (!found) continue;
      const rel = posix(relative(root, found));
      if (rel.startsWith('..') || rel.includes('node_modules/')) continue;
      const target = workspaceOf(workspaces, rel);
      if (target && target !== owner) packages.add(target.name);
      else if (!files.has(rel)) queue.push(rel);
    }
  }
  return { packages, files, all };
}

const empty = () => ({ packages: new Set(), files: new Set(), patterns: [], all: false });
const merge = (...prints) => {
  const out = empty();
  for (const p of prints) {
    for (const x of p.packages) out.packages.add(x);
    for (const x of p.files) out.files.add(x);
    out.patterns.push(...(p.patterns ?? []));
    out.all ||= p.all;
  }
  return out;
};

/** The repo paths a visual-check demo is built from (scripts/build-site.js), or undefined when unknown. */
export function demoSources(demo) {
  const path = demo.path.split(/[?#]/)[0];
  if (path === 'night-citadel/') return ['apps/showcase-night-citadel'];
  if (path === 'gameplay-sandbox/') return ['examples/gameplay-sandbox'];
  if (path === 'voxel/') return ['examples/voxel-sandbox'];
  if (path === 'demos/earth/') return ['packages/creative/examples/earth'];
  let m = /^demos\/(dof|tonemap|animator)\/$/.exec(path);
  if (m) return [`packages/${m[1]}/examples`];
  m = /^demos\/([a-z0-9-]+)\.html$/.exec(path);
  if (m) return [`examples/${m[1]}.html`];
  m = /^(examples\/[a-z0-9-]+\.html)$/.exec(path);
  if (m) return [m[1]];
  return undefined;
}

/** Paths in a command line that are .js/.mjs/.ts files (a `node scripts/x.js` or `node --test tests/x.test.js` command). */
const commandFiles = (command) => (command.match(/[\w./-]+\.(?:m?js|ts)\b/g) ?? []).map(posix);

/** `tests/*.html` pages a check script mentions. */
const pagesOf = (root, file) =>
  existsSync(join(root, file))
    ? [...readFileSync(join(root, file), 'utf8').matchAll(/['"`/](tests\/[\w./-]+\.html)\b/g)].map((m) => m[1])
    : [];

const everything = (print) => ({ ...print, all: true });

/**
 * Footprints of every GPU step, keyed by id: `visual/<demo id>`, `views`, `depth`, `no-webgpu`, `gpu/<dir>/<script>`
 * (a package's browser or gpu test script), `gpu/root/<script>` (a root suite). `tests` is plan() of
 * scripts/gpu-package-tests.mjs; `roots` its ROOT map. WGSL is not here: it narrows by package directory.
 */
export function buildFootprints({ root, workspaces, tests, scripts }) {
  const out = {};
  for (const demo of demos) {
    const sources = demoSources(demo);
    out[`visual/${demo.id}`] = sources ? scan(root, sources, workspaces) : everything(empty());
    out[`visual/${demo.id}`].patterns = [];
  }
  const ofScript = (file, extra = []) => {
    const pages = pagesOf(root, file);
    return scan(root, [file, ...pages, ...extra], workspaces);
  };
  out.views = merge(
    ofScript('scripts/test-views-browser.mjs'),
    ...['split-screen', 'minimap'].map((id) => out[`visual/${id}`]),
  );
  out.depth = ofScript('scripts/test-depth-browser.mjs');
  out['no-webgpu'] = ofScript('scripts/test-no-webgpu-browser.mjs');
  for (const test of tests) {
    const id = test.name ? `gpu/root/${test.name}` : `gpu/${test.label.replace(' ', '/')}`;
    if (test.name) {
      const files = commandFiles(scripts[test.name] ?? '');
      const print = merge(...files.map((f) => ofScript(f)));
      for (const m of (scripts[test.name] ?? '').matchAll(/examples\/[a-z0-9-]+|apps\/[a-z0-9-]+/g)) {
        const w = workspaces.find((x) => x.dir === m[0]);
        if (w) print.packages.add(w.name);
      }
      if (test.name === 'test:catalog:browser') print.patterns.push(/^docs\/(?!.*\.md$)/);
      // The Python package is not a workspace: every file under python/ is this suite's.
      if (test.name === 'test:python:browser') print.patterns.push(/^python\//);
      // A suite whose sources name no package at all cannot be mapped: run it whenever a package is affected.
      out[id] = print.packages.size || print.files.size ? print : everything(print);
    } else {
      const dir = test.cwd,
        own = workspaces.find((w) => w.dir === dir);
      const entries = commandFiles(test.command)
        .flatMap((f) => [posix(join(dir, f)), f])
        .filter((f) => existsSync(join(root, f)));
      const print = scan(root, entries, workspaces);
      if (own) print.packages.add(own.name);
      out[id] = print;
    }
    out[id].patterns ??= [];
  }
  for (const print of Object.values(out)) print.patterns ??= [];
  return out;
}

/** Package directories (packages/x) among the affected names, for narrowing check:wgsl. */
export function wgslPackages(workspaces, affected) {
  return workspaces
    .filter((w) => affected.includes(w.name) && w.dir.startsWith('packages/'))
    .map((w) => w.dir.slice(9));
}

/** Demo ids the visual check should run, shortened when every Khronos model is in. */
export function visualIds(hits) {
  const ids = hits.filter((h) => h.startsWith('visual/')).map((h) => h.slice(7));
  const khronos = demos.filter((d) => d.id.startsWith('khronos-')).map((d) => d.id);
  const rest = ids.filter((id) => !id.startsWith('khronos-'));
  const picked = ids.filter((id) => id.startsWith('khronos-'));
  return picked.length && picked.length === khronos.length ? [...rest, 'khronos-'] : ids;
}
