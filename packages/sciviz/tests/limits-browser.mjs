// Run under gpu-lock. Allocation mode is the build-phase default. JSON schema is consumed by batch 182.
import { cpus, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const args = process.argv.slice(2),
  timing = args.includes('--timed');
if (timing && JSON.parse(await readFile('scripts/speed-phase.json', 'utf8')).phase === 'deferred')
  throw new Error('Timed sweeps are deferred until Scott ends the build phase');
const options = Object.fromEntries(
  args.filter((a) => a.startsWith('--') && a.includes('=')).map((a) => a.slice(2).split('=')),
);
const kind = options.kind;
if (kind && !['points', 'voxels', 'cells', 'edges', 'rows'].includes(kind)) throw new Error('Unknown sweep kind');
if (options.sizes && !kind) throw new Error('--sizes requires --kind');
const output = resolve(options.output ?? 'test-results/sciviz-limits.json');
const total = () =>
  cpus()
    .map((cpu) => cpu.times)
    .reduce((out, t) => ({ idle: out.idle + t.idle, all: out.all + Object.values(t).reduce((a, b) => a + b, 0) }), {
      idle: 0,
      all: 0,
    });
const before = total();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
const digest = createHash('sha256');
const sources = ['packages/sciviz/tests/monitor-fixtures.js', 'packages/sciviz/tests/limits-browser.mjs'];
for (const pkg of ['sciviz', 'points', 'lines']) {
  const dir = `packages/${pkg}/src`;
  sources.push(...(await readdir(dir)).filter((name) => name.endsWith('.ts')).map((name) => `${dir}/${name}`));
}
for (const path of sources.sort()) {
  digest.update(path);
  digest.update(await readFile(path));
}
const provenance = {
  sourceDigest: digest.digest('hex'),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 10000 }).length > 0,
};
const browser = await openBrowser({ startPath: '/packages/sciviz/tests/volume-quality.html', port: 'free' });
// Sample CPU counters over real setup work instead of sleeping to create a sampling interval.
const after = total();
const cpuLoad = after.all > before.all ? 1 - (after.idle - before.idle) / (after.all - before.all) : 0;
const errors = [];
browser.page.on('pageerror', (error) => errors.push(error.message));
browser.page.setDefaultTimeout(120000);
try {
  const report = await browser.page.evaluate(
    async ({ timing, cpuLoad, commit, machine, options, kind, provenance }) => {
      const adapter = await navigator.gpu?.requestAdapter(),
        info = adapter?.info;
      const metadata = {
        commit,
        machine,
        cpuLoad,
        browser: navigator.userAgent,
        diagnostic: true,
        ...provenance,
        gpu: {
          vendor: info?.vendor ?? '',
          architecture: info?.architecture ?? '',
          device: info?.device ?? '',
          description: info?.description ?? '',
          driver: 'not exposed by browser',
        },
      };
      const { realDataSweeps, realFormatLoads } = await import('/packages/sciviz/tests/monitor-fixtures.js');
      const sizes = options.sizes ? { [kind]: options.sizes.split(',').map(Number) } : {};
      const scenes = await realDataSweeps({
        fallback: options.backend === 'webgl2',
        timing,
        metadata,
        sizes,
        ...(kind ? { kinds: [kind] } : {}),
      });
      const formats = kind ? [] : await realFormatLoads({ timing, metadata });
      return {
        schema: 'margo-sciviz-limit-suite/1',
        metadata,
        backend: options.backend ?? 'webgpu',
        status: timing ? 'diagnostic-timing' : 'allocation-proof',
        timingOwed: !timing,
        scenes,
        formats,
      };
    },
    { timing, cpuLoad, commit, machine: hostname(), options, kind, provenance },
  );
  if (errors.length) throw new Error(errors.join('\n'));
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ output, rows: [...report.scenes, ...report.formats].reduce((n, r) => n + r.rows.length, 0) }),
  );
  // An explicit storage failure in a scale sweep is evidence. A default correctness fixture must succeed.
  if (!options.sizes && [...report.scenes, ...report.formats].some((r) => r.firstFailure !== null))
    process.exitCode = 1;
} finally {
  await browser.close();
}
