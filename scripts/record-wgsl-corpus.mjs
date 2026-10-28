// Records the WGSL corpus (`npm run record:wgsl-corpus`): every WGSL module the packages create, captured at runtime
// from the existing real-GPU browser checks, deduplicated, with the entry points, pipeline constants, bind group layouts
// and render flags of the pipelines built from it. The corpus is test data for @margoengine/webgl2-compat's WGSL front
// end (packages/webgl2-compat/test/corpus/, roadmap docs/webgl2-compat-roadmap.md, "Corpus").
//   node scripts/record-wgsl-corpus.mjs                         build, run the default suites, merge, write the corpus
//   node scripts/record-wgsl-corpus.mjs --suites=check:wgsl     only these npm scripts (comma separated)
//   node scripts/record-wgsl-corpus.mjs --merge-only            merge the shards of the last run again
//   node scripts/record-wgsl-corpus.mjs --no-build              dist is current
//   node scripts/record-wgsl-corpus.mjs --keep --suites=...     add to the shards of the last run (rerun a suite that
//                                                               failed for a reason outside the recorder)
// Each suite runs as it does in check:merge, with NODE_OPTIONS=--import=scripts/support/wgsl-corpus-hook.mjs and
// MARGO_WGSL_CORPUS=test-results/wgsl-corpus, so every browser it launches records into a shard; the suites take the
// GPU lock themselves. A suite that fails is reported and the run exits 1 after writing what was recorded, so a broken
// check cannot silently shrink the corpus. Every suite has a hard time limit (30 minutes; MARGO_CORPUS_SUITE_MIN).
// Kept in the corpus: modules that compiled without errors on the recording browser and declare an entry point.
// Fragments that check:wgsl compiles on purpose (they fail alone) and anything with an error are counted, not kept.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLimited } from './support/run-limited.mjs';
import { mergeShards } from './support/wgsl-corpus.mjs';
import { writeCorpus } from '../packages/webgl2-compat/test/corpus/store.mjs';

const root = resolve(import.meta.dirname, '..'),
  dir = join(root, 'test-results', 'wgsl-corpus'),
  arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** The suites that create every package's shaders: the static builder sweep, every package GPU test, views, demos. */
export const SUITES = [
  'check:wgsl',
  'check:gpu-packages -- --no-build',
  'check:views',
  'check:depth',
  'visual:check -- --no-build',
];

const suites = arg('suites')?.split(',') ?? SUITES,
  failed = [];
if (!process.argv.includes('--merge-only')) {
  if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!process.argv.includes('--no-build')) {
    const built = spawnSync('npm run build:packages', { cwd: root, shell: true, stdio: 'inherit' });
    if (built.status !== 0) throw new Error('npm run build:packages failed; fix the build before recording the corpus');
    if (suites.some((s) => s.startsWith('visual:check'))) {
      const site = spawnSync(process.execPath, ['scripts/build-site.js'], { cwd: root, stdio: 'inherit' });
      if (site.status !== 0) throw new Error('scripts/build-site.js failed; fix the site build before recording');
    }
  }
  const hook = pathToFileURL(join(root, 'scripts', 'support', 'wgsl-corpus-hook.mjs')).href,
    env = {
      ...process.env,
      MARGO_WGSL_CORPUS: dir,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${hook}`.trim(),
    },
    limitMs = Number(process.env.MARGO_CORPUS_SUITE_MIN ?? 30) * 60_000;
  for (const suite of suites) {
    console.log(`record-wgsl-corpus: npm run ${suite}`);
    const result = await runLimited(`npm run ${suite}`, { cwd: root, env, limitMs, label: suite });
    if (!result.ok) failed.push(`${suite}: ${result.message ?? 'failed'}`);
  }
}

const { shards, modules } = mergeShards(dir),
  summary = writeCorpus([...modules.values()]);
console.log(
  `record-wgsl-corpus: ${shards} shards, ${modules.size} distinct modules seen; kept ${summary.kept} (${summary.bytes} bytes of WGSL, ${summary.packages.length} packages), dropped ${summary.fragments} that failed to compile alone (fragments) and ${summary.unknown} whose compile result never arrived`,
);
if (failed.length) {
  for (const f of failed) console.error(`  suite failed: ${f}`);
  process.exit(1);
}
