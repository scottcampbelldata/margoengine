// Six external black boxes, one shared page per paired case. Smoke never publishes timing.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, hostname, platform } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { benchRoot } from './rival-pair.mjs';
import { deferSpeed } from './support/speed-phase.mjs';
import { CASES, INSTALL, RIVALS, compareOptions } from './sciviz-compare/manifest.mjs';
import { vtkAccuracy } from './sciviz-compare/accuracy.mjs';

const options = compareOptions(process.argv.slice(2));
if (options.list) {
  console.log(CASES.map((c) => `${c.id}/${c.rival}: ${c.scales.join(',')} ${c.unit}`).join('\n'));
  process.exit(0);
}
if (options.runs !== 1 && deferSpeed('scripts/sciviz-compare.mjs')) process.exit(0);
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const external = join(benchRoot(), 'batch-182'),
  modules = join(external, 'node_modules');
if (
  options.install ||
  INSTALL.some((spec) => {
    const name = spec.slice(0, spec.lastIndexOf('@'));
    return !existsSync(join(modules, name, 'package.json'));
  })
) {
  mkdirSync(external, { recursive: true });
  const result = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--prefix', external, '--save-exact', '--no-audit', '--no-fund', ...INSTALL],
    { stdio: 'inherit', shell: process.platform === 'win32', timeout: 600_000, windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`External rival install failed: ${result.status}`);
}
const versions = Object.fromEntries(
  Object.entries(RIVALS).map(([name, pkg]) => [
    name,
    JSON.parse(readFileSync(join(modules, pkg, 'package.json'), 'utf8')).version,
  ]),
);
const output = resolve(options.output);
mkdirSync(output, { recursive: true });
if (options.accuracy) {
  // CPU only, no GPU slot: the closed-form references through VTK.js public filters (KB2594a).
  const record = {
    schema: 'margo-sciviz-accuracy/1',
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim(),
    versions: { vtk: versions.vtk },
    vtk: await vtkAccuracy(modules),
    noExtractionApi: Object.keys(RIVALS).filter((name) => name !== 'vtk'),
  };
  writeFileSync(join(output, 'accuracy.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}
const aliases = [
  ...Object.values(RIVALS),
  '@deck.gl/layers',
  '@deck.gl/geo-layers',
  'echarts',
  'gl-matrix',
  'fast-deep-equal',
  'seedrandom',
  'spark-md5',
  'fflate',
].map((name) => ({
  find: name,
  replacement: join(modules, name),
}));
aliases.unshift({ find: 'gl-bench', replacement: join(modules, 'gl-bench/dist/gl-bench.module.js') });
const plugin = {
  name: 'sciviz-external-rivals',
  config: () => ({
    resolve: { alias: aliases },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'plotly.js-dist-min',
        '@deck.gl/core',
        '@deck.gl/layers',
        'echarts',
        'echarts-gl',
        'regl-scatterplot',
        '@cosmograph/cosmograph',
        'gl-bench',
        'gl-matrix',
        'fast-deep-equal',
        'seedrandom',
        'spark-md5',
        'fflate',
      ],
    },
    server: { fs: { allow: [process.cwd(), external] } },
  }),
};
const cpuSnapshot = () =>
  cpus().reduce(
    (a, cpu) => {
      for (const [key, value] of Object.entries(cpu.times)) {
        a.total += value;
        if (key === 'idle') a.idle += value;
      }
      return a;
    },
    { total: 0, idle: 0 },
  );
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 10_000 }).trim();
let driver;
const driverProbe = spawnSync('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], {
  encoding: 'utf8',
  timeout: 10_000,
  windowsHide: true,
});
driver =
  driverProbe.status === 0 ? driverProbe.stdout.trim() : { unavailable: driverProbe.error?.code ?? driverProbe.status };
const results = [];
caseLoop: for (const spec of CASES.filter(
  (c) => !options.cases.length || options.cases.includes(`${c.id}/${c.rival}`),
)) {
  const scales = options.runs === 1 ? spec.scales.slice(0, 1) : spec.scales;
  for (const scale of scales) {
    const label = `${spec.id}-${spec.rival}-${scale}`,
      cpuBefore = cpuSnapshot();
    const lock = await acquire({
      owner: 'bp-182-compare',
      mode: options.runs === 1 ? 'shared' : 'exclusive',
      max: 10,
      waitMax: 15,
      command: `node scripts/sciviz-compare.mjs --runs=${options.runs} --cases=${spec.id}/${spec.rival}`,
    });
    let context;
    try {
      context = await openBrowser({ startPath: '/scripts/sciviz-compare/page.html', port: 'free', plugins: [plugin] });
      const errors = [];
      context.page.on('pageerror', (error) => errors.push(error.message));
      await context.page.waitForFunction(() => typeof window.runComparison === 'function', null, { timeout: 120_000 });
      const report = await context.page.evaluate((value) => window.runComparison(value), {
        ...spec,
        scale,
        runs: options.runs,
      });
      if (errors.length) throw new Error(errors.join('\n'));
      const cpuAfter = cpuSnapshot(),
        total = cpuAfter.total - cpuBefore.total;
      const record = {
        schema: 'margo-sciviz-compare/1',
        commit: git('rev-parse', 'HEAD'),
        dirty: !!git('status', '--porcelain'),
        machine: {
          hostname: hostname(),
          platform: platform(),
          cpu: cpus()[0]?.model,
          cpuLoadFraction: total ? 1 - (cpuAfter.idle - cpuBefore.idle) / total : null,
          driver,
        },
        hardware: context.hardware,
        versions,
        status: 'passed',
        ...report,
      };
      writeFileSync(join(output, `${label}.json`), JSON.stringify(record, null, 2) + '\n');
      for (const id of ['margo', 'rival'])
        await context.page.locator(`#${id}`).screenshot({ path: join(output, `${label}-${id}.png`) });
      await context.page.evaluate(() => window.releaseComparison());
      results.push(record);
      console.log(
        `${label}: ${options.runs === 1 ? 'smoke passed; timing pending the quiet rerun' : 'diagnostic samples recorded'}`,
      );
    } catch (error) {
      const inspection = await Promise.allSettled([
        context?.page.evaluate(() =>
          [...document.querySelectorAll('#rival, #rival canvas')].map((node) => ({
            debug: window.__comparisonDebug,
            tag: node.tagName,
            style: node.getAttribute('style'),
            className: node.className,
            width: node.width,
            height: node.height,
            clientWidth: node.clientWidth,
            clientHeight: node.clientHeight,
            parentStyle: node.parentElement.getAttribute('style'),
          })),
        ),
      ]);
      const failure = {
        inspection,
        status: 'failed',
        id: spec.id,
        rival: spec.rival,
        scale,
        error: String(error.stack ?? error),
      };
      writeFileSync(join(output, `${label}-failure.json`), JSON.stringify(failure, null, 2) + '\n');
      // Failure-to-scale is an observed result, never a swallowed success or a smaller rerun.
      results.push(failure);
      console.error(`${label}: ${failure.error}`);
      process.exitCode = 1;
      if (options.runs === 1) break caseLoop;
      break;
    } finally {
      try {
        await context?.close();
      } finally {
        await lock();
      }
    }
  }
}
writeFileSync(join(output, 'index.json'), JSON.stringify(results, null, 2) + '\n');
