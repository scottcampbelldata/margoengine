// Shared harness for optimization proofs: build one package from a Git ref and from a candidate, check both give the same
// answers on a real workload, then time them in interleaved rounds. The candidate is pinned to the commit where the claim
// was made (`refs`), so a proof reproduces its claim whatever the working tree does later; `--current` checks the working
// tree instead (ongoing guarantees, `npm run proofs -- --current`). Pinned runs read the compared packages' src and
// packages/shared from Git; @margoengine/core (frozen at 1.0.0), the proof script and its test fixtures are today's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '../../..'),
  slash = (value) => value.replaceAll('\\', '/');
const bare = (id) => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) && !id.startsWith('\0');

/** One package entry bundled by Vite from `ref` (its src and packages/shared), or from the working tree without one; bare
 * imports stay external. Returns the output chunks. */
export async function bundle(name, entry, ref, minify = false) {
  // The package's src and packages/shared (inlined into every bundle) both come from the ref.
  const sources = [slash(resolve(root, 'packages', name, 'src')) + '/', slash(resolve(root, 'packages/shared')) + '/'];
  const show = (file) => {
    try {
      return execFileSync('git', ['show', `${ref}:${file.slice(slash(root).length + 1)}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1 << 26,
      });
    } catch {
      return;
    }
  };
  const plugins = ref
    ? [
        {
          name: 'git-source',
          enforce: 'pre',
          resolveId(id, importer) {
            // A file deleted or renamed since the ref (e.g. shared/math.js, gltf-pro's instances.ts) is missing on disk; resolve it
            // to its path in the ref (.ts when the ref has one) so load() reads the ref.
            if (!importer || !id.startsWith('.')) return;
            const file = slash(resolve(dirname(importer.split('?')[0]), id)),
              ts = file.replace(/\.js$/, '.ts');
            if (sources.some((s) => file.startsWith(s)) && !existsSync(file) && !existsSync(ts))
              return show(ts) === undefined ? file : ts;
          },
          load(id) {
            const file = slash(id.split('?')[0]);
            if (sources.some((s) => file.startsWith(s))) return show(file); // undefined (not in the ref): the working tree
          },
        },
      ]
    : [];
  const result = await build({
    root: resolve(root, 'packages', name),
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins,
    build: {
      write: false,
      minify,
      target: 'es2022',
      lib: { entry: resolve(root, 'packages', name, entry), formats: ['es'] },
      rollupOptions: { external: bare },
    },
  });
  return result[0].output.filter((item) => item.type === 'chunk');
}

/** One package entry built as a single module from `ref` (its src and packages/shared), or from the working tree. */
export async function load(name, entry, ref) {
  const chunks = await bundle(name, entry, ref);
  assert.equal(chunks.length, 1, `${name} must build to one module for comparison`);
  // Written inside the repository so bare imports such as @margoengine/core resolve normally.
  const directory = resolve(root, 'test-results/proofs-tmp');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${name}-${entry.replace(/\W+/g, '_')}-${ref ?? 'working'}-${process.pid}.mjs`);
  await writeFile(file, chunks[0].code);
  return import(pathToFileURL(file).href);
}

const argv = process.argv.slice(2);
export const commit = (value) =>
  execFileSync('git', ['rev-parse', '--verify', `${value}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
/** `--current`: compare with the working tree instead of the pinned candidate (proofs of an ongoing guarantee). */
export const current = argv.includes('--current');
/** Refs for `node <proof> [ref] [pin] [--current]`. By default the baseline `ref` against `pin`, the commit where the claim
 * was made, so the result never depends on today's tree. With --current: `currentRef` (the last intended change to the
 * output, else `ref`) against the working tree (`pin` undefined). */
export function refs(ref, pin, currentRef = ref) {
  const [a, b] = argv.filter((arg) => !arg.startsWith('--'));
  return current ? { ref: a ?? currentRef, pin: undefined } : { ref: a ?? ref, pin: b ?? pin };
}

/** A repository file's text at `ref` (the fixtures a pinned claim was made with), or in the working tree without one. */
export const fileAt = (path, ref) =>
  ref
    ? execFileSync('git', ['show', `${commit(ref)}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
    : readFileSync(resolve(root, path), 'utf8');

/** Logs what a proof compares, one `[proof]` line on stderr (the runner's table reads them). */
export const announce = (what, ref, pin) => console.error(`[proof] ${what}: ${ref} -> ${pin ?? 'working tree'}`);

/** A package entry a proof sets its story up with (`src/x.ts`): built at `pin` when pinned, else the working tree's dist. */
export const entryAt = (name, entry, pin) =>
  pin
    ? load(name, entry, commit(pin))
    : import(
        pathToFileURL(resolve(root, 'packages', name, entry.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js'))).href
      );

/** `baseline` is the package at `ref`; `candidate` is the package at `candidateRef` (a proof's pin), or the working tree. */
export async function versions(name, ref, entry = 'src/index.ts', candidateRef) {
  announce(`${name} ${entry}`, ref, candidateRef);
  return {
    baseline: await load(name, entry, commit(ref)),
    candidate: await load(name, entry, candidateRef && commit(candidateRef)),
  };
}

const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];
/** Interleave baseline (A) and candidate (B) runs A B B A so drift affects both alike. Each run returns nothing. */
export function time(runBaseline, runCandidate, rounds = 12) {
  for (let i = 0; i < 3; i++) {
    runBaseline();
    runCandidate();
  }
  const a = [],
    b = [],
    once = (run) => {
      const start = performance.now();
      run();
      return performance.now() - start;
    };
  for (let i = 0; i < rounds; i++) {
    a.push(once(runBaseline));
    b.push(once(runCandidate));
    b.push(once(runCandidate));
    a.push(once(runBaseline));
  }
  const baselineMs = median(a),
    candidateMs = median(b);
  return {
    baselineMs: +baselineMs.toFixed(4),
    candidateMs: +candidateMs.toFixed(4),
    speedup: +(baselineMs / candidateMs).toFixed(3),
  };
}

/** Writes `results/<file>.json`. Records are pinned runs: --current never writes, and `npm run proofs` sets
 * PROOFS_NO_WRITE so its runs leave the committed records alone. */
export async function save(file, report) {
  if (process.env.PROOFS_NO_WRITE || current) return;
  await mkdir(resolve(import.meta.dirname, 'results'), { recursive: true });
  await writeFile(resolve(import.meta.dirname, 'results', `${file}.json`), JSON.stringify(report, null, 2) + '\n');
}

/** Save one package's proof next to this file and fail when the candidate (`pin`, else the working tree) is not faster. */
export async function record(name, ref, cases, notes = '', pin) {
  for (const item of cases)
    assert.ok(item.speedup >= 1, `${name} ${item.case} is slower than ${ref}: ${item.speedup}x`);
  const report = {
    package: name,
    baseline: ref,
    candidate: pin ?? 'working tree',
    node: process.version,
    recordedAt: new Date().toISOString(),
    outputsIdentical: true,
    notes,
    cases,
  };
  await save(name, report);
  console.log(JSON.stringify(report, null, 2));
}

const agxRederived = new Map(),
  descends = (ancestor, ref) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, commit(ref)], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
/** Recorded GPU calls with the `agx()` WGSL body blanked: eaddd64 re-derived AgX from primary sources (same constants to
 * 1.2e-8, full-precision Rec.709/Rec.2020 matrices), an intended change that proofs against older refs must not flag.
 * Only when the baseline `ref` predates eaddd64; against a later ref the calls are returned unchanged. */
export const ignoreAgx = (calls, ref) => {
  if (!agxRederived.has(ref)) agxRederived.set(ref, descends('eaddd64', ref));
  return agxRederived.get(ref)
    ? calls
    : JSON.parse(JSON.stringify(calls).replace(/fn agx\(v:vec3f\)->vec3f \{.*?\\n\}/g, 'fn agx(v:vec3f)->vec3f {}'));
};
