// The per-feature measurement scripts in examples/package-benchmarks (what `bench:all --gpu` used to run), each once
// under this run's gate and GPU lock. Not part of the default run (about an hour): `npm run bench -- features`.
// A script that exits non-zero fails its case. Every file a script writes under examples/package-benchmarks is copied
// to benchmarks/runs/<id>/features/ and the committed version restored, so a run never edits committed results.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root } from '../lib/env.mjs';

const bench = 'examples/package-benchmarks';
const STEPS = [
  ['vfx-size', `${bench}/vfx-size.mjs`],
  ['package-sizes', `${bench}/proofs/size.js`],
  ['textured-instancing-mock', `${bench}/textured-instancing.mjs`],
  ['exporters-model', `${bench}/exporters-model.mjs`],
  ['parts-culling', `${bench}/parts/culling.mjs`, '--label=bench-culling'],
  ['post-stack', `${bench}/gates/post-stack.mjs`],
  ['loaders-memory', `${bench}/gates/memory.mjs`],
  ['shadow-shimmer', `${bench}/shadow-shimmer.mjs`],
  ['textured-instancing-gpu', `${bench}/textured-instancing-gpu.mjs`],
  ['atlas-vat', `${bench}/atlas-vat/check.mjs`],
  ['workers', `${bench}/workers/run.mjs`],
  ['browser-tests', `${bench}/gates/run-browser-tests.mjs`],
];

// Not a trimmed git() call: the leading space of the first ' M path' line matters.
const changed = () =>
  execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', bench], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => [l.slice(0, 2), l.slice(3)]);

export default {
  name: 'features',
  title: 'Per-feature scripts in examples/package-benchmarks (opt-in, about an hour)',
  uses: 'gpu',
  async cases(ctx) {
    return STEPS.map(([id, script, ...args]) => ({
      id,
      title: `node ${[script, ...args].join(' ')}`,
      runs: 1,
      warmup: 0,
      metrics: { seconds: { unit: 's', better: 'lower' } },
      setup() {
        if (changed().length)
          throw new Error(`${bench} has uncommitted changes; commit or stash them (this suite restores its results)`);
      },
      async run() {
        const out = join(ctx.shots, 'features'),
          start = Date.now(),
          r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${id}.log`), `${script} ${args.join(' ')}\n\n${r.stdout ?? ''}${r.stderr ?? ''}`);
        const files = [];
        for (const [status, path] of changed()) {
          cpSync(resolve(root, path), join(out, path));
          files.push(path);
          if (status === '??') rmSync(resolve(root, path), { force: true });
          else execFileSync('git', ['-C', root, 'checkout', '--', path]);
        }
        if (id === 'atlas-vat' && existsSync(resolve(root, 'test-results/atlas-vat-check.json')))
          cpSync(resolve(root, 'test-results/atlas-vat-check.json'), join(out, 'atlas-vat-check.json'));
        if (r.status !== 0) throw new Error(`exit ${r.status}; log ${join(out, `${id}.log`)}`);
        return { values: { seconds: (Date.now() - start) / 1000 }, info: { files } };
      },
    }));
  },
};
