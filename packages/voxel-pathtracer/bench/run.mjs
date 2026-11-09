import { deferSpeed, isSpeedEntry } from '../../../scripts/support/speed-phase.mjs';
if (
  isSpeedEntry(import.meta.url) &&
  !process.argv.some((arg) => ['--help', '-h', '--list'].includes(arg)) &&
  deferSpeed('packages/voxel-pathtracer/bench/run.mjs')
)
  process.exit(0);
// Path tracer numbers: runs the package's GPU checks (the five test:gpu scripts of package.json, then the `timing` case)
// one after another and writes everything they measured to bench/results.json, with the machine, browser, driver and
// commit. The README's "Measured performance" and "Verification" numbers cite that file.
//
//   node packages/voxel-pathtracer/bench/run.mjs [--out=packages/voxel-pathtracer/bench/results.json] [--only=base,timing]
//
// Run it through the GPU lock (this folder is named bench, so the lock makes it exclusive and nothing else touches the
// GPU meanwhile): node scripts/gpu-lock.mjs run --exclusive --max=60 --owner=<id> -- node packages/voxel-pathtracer/bench/run.mjs
// Each check keeps its own assertions: a step that fails is recorded with passed: false and the run exits 1, and a results
// file with passed: false is not a result to commit.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  out = arg('out', fileURLToPath(new URL('./results.json', import.meta.url))),
  only = arg('only')?.split(','),
  manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// The package scripts name the cases and report files, so this list cannot drift from `npm run test:gpu*`. The two
// fault-injection scripts (slow-compile, spec-math) and the stall check measure nothing and are left out.
const steps = Object.entries(manifest.scripts)
  .filter(([name]) => /^test:gpu(:(denoise|denoise-materials|denoise-caustics|viewport))?$/.test(name))
  .map(([name, command]) => {
    const [, args] = /tests\/browser-check\.mjs (.+)$/.exec(command) ?? [];
    const words = args.split(' '),
      report = words.find((w) => w.startsWith('--report=')).slice(9);
    return { script: name, report, args: words };
  });
steps.push({ script: 'timing', report: 'timing', args: ['--report=timing', 'timing'] });

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const results = {},
  hardware = [];
let passed = true;
for (const step of steps.filter((s) => !only || only.includes(s.report))) {
  const started = performance.now();
  console.log(`== ${step.report}: ${step.args.join(' ')}`);
  const run = spawnSync(process.execPath, ['packages/voxel-pathtracer/tests/browser-check.mjs', ...step.args], {
    cwd: root,
    stdio: 'inherit',
  });
  let report;
  try {
    report = JSON.parse(
      readFileSync(join(root, `test-results/voxel-pathtracer-browser-check-${step.report}.json`), 'utf8'),
    );
  } catch {
    // The check died before it wrote its results.
  }
  const ok = run.status === 0 && report !== undefined;
  passed &&= ok;
  if (report) hardware.push(report.hardware);
  results[step.report] = {
    script: step.script,
    cases: step.args.filter((a) => !a.startsWith('--')),
    passed: ok,
    wallSeconds: Math.round((performance.now() - started) / 100) / 10,
    date: report?.date,
    timings: report?.timings,
    results: report?.results,
  };
}
const first = hardware[0] ?? {};
const file = {
  about:
    'Everything the path tracer GPU checks measured on one machine in one run (packages/voxel-pathtracer/bench/run.mjs). ' +
    "timings are seconds per case; results are the checks' own numbers; passed is false when a check failed.",
  passed,
  commit: git('rev-parse', 'HEAD'),
  dirty:
    git(
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      'packages/voxel-pathtracer',
      'packages/math',
      'packages/core',
    ).length > 0,
  date: new Date().toISOString(),
  machine: {
    cpu: cpus()[0]?.model,
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    platform: process.platform,
    node: process.version,
    gpu: first.webgpu,
    browser: [first.browserName, first.browserVersion].filter(Boolean).join(' '),
    userAgent: first.userAgent,
    launchArgs: first.launchArgs,
    powerPreference: first.powerPreference,
  },
  steps: results,
};
writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
console.log(`wrote ${out}: ${passed ? 'every check passed' : 'A CHECK FAILED'}`);
process.exitCode = passed ? 0 : 1;
