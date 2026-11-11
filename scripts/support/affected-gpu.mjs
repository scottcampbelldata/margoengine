// Which GPU work a change affects (`npm run check:merge`, scripts/check-merge.mjs). Session rule 20: check only what a
// change can affect, and never narrow by skipping a test the change can affect.
//
// 1. Every changed file has a class (scripts/support/file-classes.mjs). A workspace file maps to its package; every
//    package that depends on it, transitively, is affected too (the workspace dependency graph). A package's own
//    package.json counts as that package.
// 2. Each step has a footprint: the packages and files it exercises, found by reading its sources (a package's test
//    dirs, a check script and the pages it opens, a demo's html and the modules it imports, and the repo paths those
//    files name). stepClosure does this for every check:merge step, every verify command and every GPU test, so a
//    script, test page or fixture runs exactly the steps whose closure holds it, and a file no closure holds runs
//    nothing beyond verify. A GPU step runs when its footprint meets the affected set or holds a changed file.
// 3. Everything runs for core, stage, shared or the margoengine umbrella; the root package.json, a lock file or .npmrc;
//    build configuration; the check code itself (file-classes.mjs CHECK_CODE plus the build:packages closure); a
//    WGSL file outside a package; an asset no check reaches or names; a file no class places; more than MAX_AFFECTED
//    packages; MARGO_FULL=1. An umbrella change that only adds or removes `export * from` entries (its package.json
//    exports and the matching thin files; umbrella-change.mjs) is not one of these: the packages that gained the
//    entries are the change, and the umbrella smoke test always runs. A change to the GPU package runner (RUNNER) runs RUNNER_SMOKE plus what it affects.
// Everything here is pure (files and a package graph in, a decision out) except the readers at the bottom.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { baselineDemo, CLASSES, classify, FULL_DIRS, CHECK_CODE, RUNNER, workspaceOf } from './file-classes.mjs';
import { demos } from './visual-demos.js';

export { FULL_DIRS, workspaceOf };

/** More affected packages than this (dependents included) and the full GPU run is cheaper than being wrong. */
export const MAX_AFFECTED = 12;

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

/** Classes whose file, when no footprint holds it, is looked for by name in the footprints' files (`mentions`). */
const NAMED = new Set(['script', 'fixture', 'asset', 'root-browser', 'proof']);

/**
 * What a change needs. `footprints`: { [stepId]: { packages: Set<name>, files: Set<path>, patterns: RegExp[], all: boolean } }.
 * `checkCode`: the files that run everything (buildCheckCode); `smoke`: the footprint ids a RUNNER change runs
 * (RUNNER_SMOKE as `gpu/<test id>`); `mentions(file)`: footprint ids whose files name a file no footprint holds.
 * Returns { mode: 'full' | 'affected', reason, changed, affected, hits } where hits are the footprint ids to run.
 */
export function analyse({
  files,
  workspaces,
  footprints,
  env = {},
  max = MAX_AFFECTED,
  checkCode = CHECK_CODE,
  smoke = [],
  mentions,
  umbrellaReexport,
}) {
  const full = (reason) => ({ mode: 'full', reason, changed: [], affected: [], hits: Object.keys(footprints) });
  if (env.MARGO_FULL === '1') return full('MARGO_FULL=1');
  const changed = new Set(),
    loose = [];
  for (const raw of files) {
    const file = posix(raw);
    // An umbrella change that only adds or removes re-export entries is not a floor change (umbrella-change.mjs).
    if (file.startsWith('packages/margoengine/') && !file.endsWith('.md') && umbrellaReexport?.(file)) {
      loose.push({ file, cls: 'umbrella-reexport' });
      continue;
    }
    const c = classify(file, { workspaces, checkCode });
    if (CLASSES[c.cls] === 'full' && c.cls !== 'asset') return full(`${c.reason} (${file})`);
    if (c.cls === 'package') changed.add(workspaceOf(workspaces, file).name);
    else loose.push({ file, cls: c.cls });
  }
  const ids = Object.keys(footprints),
    visual = ids.filter((id) => id.startsWith('visual/')),
    roots = ids.filter((id) => id.startsWith('gpu/root/')),
    fileHit = (print, file) => print.files.has(file) || print.patterns.some((p) => p.test(file)),
    touched = new Set(),
    notes = new Set();
  for (const { file, cls } of loose) {
    let hit = ids.filter((id) => fileHit(footprints[id], file));
    if (!hit.length && mentions && NAMED.has(cls)) hit = mentions(file);
    if (cls === 'runner') {
      hit = [...hit, ...smoke];
      notes.add('GPU package runner changed: RUNNER_SMOKE');
    } else if (cls === 'visual-baseline') {
      const id = baselineDemo(
        file,
        visual.map((v) => v.slice(7)),
      );
      hit = [...hit, ...(id ? [`visual/${id}`] : visual)];
    } else if (cls === 'visual-record') hit = [...hit, ...visual];
    else if (cls === 'root-browser' && !hit.length) hit = roots;
    else if (cls === 'asset' && !hit.length) return full(`no check reaches or names the asset ${file}`);
    else if (cls === 'unknown') return full(`cannot classify ${file}`);
    for (const id of hit) touched.add(id);
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
  const steps = [...touched].filter((id) => !id.includes('/')),
    reach = steps.length ? `; changed check files reach ${steps.sort().join(', ')}` : '',
    reason =
      (changed.size
        ? `changed ${[...changed].join(', ')}; affected ${affected.size} package${affected.size === 1 ? '' : 's'}`
        : loose.length
          ? 'no package changed (documents, scripts, tests and demo sources only)'
          : 'no changed files') +
      reach +
      [...notes].map((n) => `; ${n}`).join('');
  return { mode: 'affected', reason, changed: [...changed], affected: [...affected], hits };
}

// ---- Footprints: read the sources a GPU step runs. ----

const texts = new Map();
/** A repo file's text, read once per process (footprints read the same sources many times). */
function readText(root, file) {
  const key = join(root, file);
  if (!texts.has(key)) texts.set(key, readFileSync(key, 'utf8'));
  return texts.get(key);
}

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
    const text = readText(root, file),
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
  if (path === 'demos/boulder/')
    return ['examples/boulder.html', 'examples/boulder', 'examples/assets/boulder-robot.glb'];
  let m = /^demos\/(dof|tonemap|animator)\/$/.exec(path);
  if (m) return [`packages/${m[1]}/examples`];
  m = /^demos\/([a-z0-9-]+)\.html$/.exec(path);
  if (m) return [`examples/${m[1]}.html`];
  m = /^gallery\/([a-z0-9-]+)\.html$/.exec(path);
  if (m) return [`examples/gallery/${m[1]}.html`];
  m = /^(examples\/[a-z0-9-]+\.html)$/.exec(path);
  if (m) return [m[1]];
  return undefined;
}

/** Paths in a command line that are .js/.mjs/.ts files (a `node scripts/x.js` or `node --test tests/x.test.js` command). */
const commandFiles = (command) => (command.match(/[\w./-]+\.(?:m?js|ts)\b/g) ?? []).map(posix);

/**
 * The repo files a root command runs, following `npm run <name>` into package.json `scripts` (once each). A part run
 * in a workspace (`--workspace <dir>`) is that package's own and is left out: its files belong to the package.
 */
export function commandEntries(scripts, command, seen = new Set()) {
  const out = [];
  for (const part of command.split(/&&|\|\||;/)) {
    if (/--workspace\b/.test(part)) continue;
    const name = /\bnpm run ([\w:.-]+)/.exec(part)?.[1];
    if (name) {
      if (scripts[name] && !seen.has(name)) {
        seen.add(name);
        out.push(...commandEntries(scripts, scripts[name], seen));
      }
      continue;
    }
    out.push(...commandFiles(part));
  }
  return out;
}

/** A repo path a file names in a string (`'scripts/build-site.js'`, `"tests/fixtures/basic-scene"`). */
const NAMED_PATH = /['"`/]((?:scripts|tests|examples|bench|tools)\/[\w./-]*[\w-])(?=['"`?#\s)])/g;
const READABLE = /\.(html|m?js|tsx?|css|json)$/;

/**
 * scan() of `entries`, then the repo paths its files name in strings (a script it spawns, a page or fixture it loads by
 * path), scanned in turn until nothing new is named. `packages` and `all` are scan()'s of the entries alone; `files`
 * holds every file reached either way (files inside a workspace, or a workspace folder named whole, stay that package's). `follow(path)` limits which
 * named paths are followed.
 */
export function closure(root, entries, workspaces, follow = () => true) {
  const first = scan(root, entries, workspaces),
    files = new Set(first.files);
  let frontier = [...first.files];
  while (frontier.length) {
    const named = new Set();
    for (const file of frontier) {
      if (!READABLE.test(file) || !existsSync(join(root, file))) continue;
      for (const [, path] of readText(root, file).matchAll(NAMED_PATH))
        if (
          !files.has(path) &&
          follow(path) &&
          existsSync(join(root, path)) &&
          !workspaceOf(workspaces, path) &&
          // A workspace folder named whole (`'examples/voxel-sandbox'`, a Vite root) is that package, which scan()
          // records from the same mention; its files, and what they import from outside it, stay the package's.
          !workspaces.some((w) => w.dir === path)
        )
          named.add(path);
    }
    if (!named.size) break;
    frontier = [];
    for (const file of scan(root, [...named], workspaces).files)
      if (!files.has(file) && !workspaceOf(workspaces, file)) {
        files.add(file);
        frontier.push(file);
      }
  }
  return { packages: first.packages, files, all: first.all };
}

/**
 * Named paths a step follows, when not all: the visual check follows only the scripts it runs (the site build), not
 * the pages that build makes beside the demos (each demo's own sources are its footprint; bench/ is not captured).
 */
const FOLLOW = { 'visual:check': (path) => /^scripts\/.+\.m?js$/.test(path) };

/**
 * The files each step reaches, keyed by step: every check:merge step by its npm script name (`verify` also through
 * the verify.mjs SERIAL and PARALLEL commands given as `verify`), and every GPU test by `gpu/<test id>` (its command,
 * plus the PREPARE commands of a root suite). `tests` is plan() of scripts/gpu-package-tests.mjs. Returns
 * { [id]: { packages, files, all } } with a non-enumerable `placed(file)`: the ids whose closure holds a file.
 */
export function stepClosure(root, workspaces, scripts, { verify = [], tests = [], prepare = {} } = {}) {
  const out = {},
    exists = (f) => existsSync(join(root, f));
  for (const command of (scripts['check:merge:steps'] ?? '').split(' && ')) {
    const name = /^npm run (\S+)/.exec(command)?.[1];
    if (!name || !scripts[name]) continue;
    const entries = commandEntries(scripts, command);
    if (name === 'verify') for (const c of verify) entries.push(...commandEntries(scripts, c));
    out[name] = closure(root, [...new Set(entries)].filter(exists), workspaces, FOLLOW[name]);
  }
  for (const test of tests) {
    const id = `gpu/${test.name ? `root/${test.name}` : test.label.replace(' ', '/')}`;
    const entries = test.name
      ? [scripts[test.name] ?? '', ...(prepare[test.name] ?? [])].flatMap((c) => commandEntries(scripts, c))
      : commandFiles(test.command).flatMap((f) => [posix(join(test.cwd, f)), f]);
    out[id] = closure(root, [...new Set(entries)].filter(exists), workspaces);
  }
  Object.defineProperty(out, 'placed', {
    value: (file) => Object.keys(out).filter((id) => out[id].files.has(posix(file))),
  });
  return out;
}

/** CHECK_CODE plus every file outside a workspace that the build:packages chain reaches: a change there runs everything. */
export function buildCheckCode(root, workspaces, scripts) {
  const entries = commandEntries(scripts, 'npm run build:packages').filter((f) => existsSync(join(root, f)));
  const reached = [...closure(root, entries, workspaces).files].filter((f) => !RUNNER.includes(f));
  return new Set([...CHECK_CODE, ...reached]);
}

/** `tests/*.html` pages a check script mentions. */
const pagesOf = (root, file) =>
  existsSync(join(root, file))
    ? [...readText(root, file).matchAll(/['"`/](tests\/[\w./-]+\.html)\b/g)].map((m) => m[1])
    : [];

const everything = (print) => ({ ...print, all: true });
const filesOnly = (print) => ({ packages: new Set(), files: new Set(print?.files ?? []), patterns: [], all: false });

/**
 * Footprints of every step, keyed by id: `visual/<demo id>`, `views`, `depth`, `no-webgpu`, `gpu/<dir>/<script>`
 * (a package's browser or gpu test script), `gpu/root/<script>` (a root suite), and, by the files they reach only,
 * `wgsl` (check:wgsl whole), `packages` (modern:test:packages whole), `bundlers` (modern:test:bundlers runs), `examples-types` (check:examples-types runs), `readme-run` (check:readme-run whole), `rust-kernels` (check:rust-kernels whole), and
 * `verify`, `fresh-clone`, `site`, `quickstart` (steps that always run; the id only places a file). Every visual demo
 * also holds the visual check's own files (visual-regression.js and the site build it names), and every GPU test the
 * runner's files other than RUNNER. `tests` is plan() of scripts/gpu-package-tests.mjs; `verify` the verify.mjs
 * commands; `prepare` its PREPARE map. WGSL by package is not here: it narrows by package directory.
 */
export function buildFootprints({ root, workspaces, tests, scripts, verify = [], prepare = {} }) {
  const out = {},
    steps = stepClosure(root, workspaces, scripts, { verify, tests, prepare }),
    stepFiles = (name) => [...(steps[name]?.files ?? [])];
  const visualFiles = stepFiles('visual:check');
  for (const demo of demos) {
    const sources = demoSources(demo),
      print = sources ? closure(root, sources, workspaces) : everything(empty());
    for (const file of visualFiles) print.files.add(file);
    out[`visual/${demo.id}`] = { ...print, patterns: [] };
  }
  const ofScript = (file, extra = []) => {
    const pages = pagesOf(root, file);
    return closure(root, [file, ...pages, ...extra], workspaces);
  };
  out.views = merge(
    ofScript('scripts/test-views-browser.mjs'),
    ...['split-screen', 'minimap'].map((id) => out[`visual/${id}`]),
  );
  out.depth = ofScript('scripts/test-depth-browser.mjs');
  out['no-webgpu'] = ofScript('scripts/test-no-webgpu-browser.mjs');
  // It opens every page of site/dist that runs a module script, the landing page included.
  out['no-webgpu'].patterns = [/^site\/.*\.(html|m?js)$/, /^examples\/gallery\/.*\.(html|m?js|ts)$/];
  const runner = stepFiles('check:gpu-packages').filter((f) => !RUNNER.includes(f));
  for (const test of tests) {
    const id = test.name ? `gpu/root/${test.name}` : `gpu/${test.label.replace(' ', '/')}`;
    const own = steps[id] ?? empty();
    let print;
    if (test.name) {
      const entries = [scripts[test.name] ?? '', ...(prepare[test.name] ?? [])]
        .flatMap((c) => commandEntries(scripts, c))
        .filter((f) => existsSync(join(root, f)));
      print = merge(...entries.map((f) => ofScript(f)));
      for (const m of (scripts[test.name] ?? '').matchAll(/examples\/[a-z0-9-]+|apps\/[a-z0-9-]+/g)) {
        const w = workspaces.find((x) => x.dir === m[0]);
        if (w) print.packages.add(w.name);
      }
      if (test.name === 'test:catalog:browser') print.patterns.push(/^docs\/(?!.*\.md$)/);
      // The Python package is not a workspace: every file under python/ is this suite's.
      if (test.name === 'test:python:browser') print.patterns.push(/^python\//);
      // Generated pages name their imports explicitly. Include each row and its packages, rather than trusting
      // a computed URL in the browser runner to be discovered by the source scanner.
      if (test.name === 'test:composition:browser') {
        const matrix = JSON.parse(readText(root, 'tests/composition/generated.json'));
        print = merge(print, ...matrix.rows.map((row) => ofScript(`tests/composition/${row.id}.html`)));
        print.files.add('tests/composition/generated.json');
        print.files.add('scripts/generate-composition.mjs');
      }
      if (test.name === 'test:integration:browser') {
        const pages = readdirSync(join(root, 'examples/test-pages')).filter((f) => /^integration-.*\.html$/.test(f));
        print = merge(print, ...pages.map((page) => ofScript(`examples/test-pages/${page}`)));
      }
      // A suite whose sources name no package at all cannot be mapped: run it whenever a package is affected.
      if (!(print.packages.size || print.files.size)) print = everything(print);
    } else {
      print = merge(own);
      const w = workspaces.find((x) => x.dir === test.cwd);
      if (w) print.packages.add(w.name);
    }
    for (const file of [...own.files, ...runner]) print.files.add(file);
    out[id] = print;
  }
  out.wgsl = filesOnly(steps['check:wgsl']);
  out.packages = filesOnly(steps['modern:test:packages']);
  out.bundlers = filesOnly(steps['modern:test:bundlers']);
  out['examples-types'] = filesOnly(steps['check:examples-types']);
  out['readme-run'] = filesOnly(steps['check:readme-run']);
  out.owners = filesOnly(steps['check:owners']);
  out['rust-kernels'] = filesOnly(steps['check:rust-kernels']);
  out.verify = filesOnly(steps.verify);
  out['fresh-clone'] = filesOnly(steps['check:fresh-clone']);
  out.site = filesOnly(steps['build:site']);
  out.quickstart = filesOnly(steps['check:quickstart']);
  for (const print of Object.values(out)) print.patterns ??= [];
  return out;
}

/** The step ids that only place a file: they always run, so a hit on them runs nothing more. */
export const PLACEMENT_IDS = ['verify', 'fresh-clone', 'site', 'quickstart'];

/** How a file no footprint holds is looked for by name: its basename, or `parent/basename` for a generic one. */
export const mentionKey = (file) => {
  const parts = posix(file).split('/'),
    base = parts.at(-1);
  return /^(index|main|README|package|manifest|config)\./.test(base) ? parts.slice(-2).join('/') : base;
};

/**
 * `mentions(file)` for analyse(): the footprint ids whose own files name `file` by mentionKey (a fixture or page
 * loaded by a path built at run time). Placement ids are left out: those steps always run.
 */
export function mentionIndex(root, footprints) {
  const byFile = new Map();
  for (const [id, print] of Object.entries(footprints)) {
    if (PLACEMENT_IDS.includes(id)) continue;
    for (const file of print.files) byFile.set(file, [...(byFile.get(file) ?? []), id]);
  }
  return (file) => {
    const key = mentionKey(file),
      hit = new Set();
    for (const [other, ids] of byFile) {
      if (other === file || !READABLE.test(other) || !existsSync(join(root, other))) continue;
      if (readText(root, other).includes(key)) for (const id of ids) hit.add(id);
    }
    return [...hit];
  };
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
