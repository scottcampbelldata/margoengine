// DOF cost and quality, old build vs new build on the real GPU. Serial, under the GPU lock, on AC power.
// From the repository root after `npm run build:packages`:
//   node examples/package-benchmarks/gates/dof.mjs [--baseline=5b9dbbd] [--rounds=6] [--frames=90] [--sizes=1280x720,1920x1080]
//     [--msaa=4,1] [--scenes=gate,near,far,wide] [--out=examples/package-benchmarks/results/gates-dof.json]
// The baseline DOF is rebuilt from packages/dof/src at --baseline into test-results/dof-variants/<ref>/ and loaded in
// the same page as the current packages/dof/dist, so both run on the same engine, scene and GPU clock.
// Scene: dof.html (DamagedHelmet + boxes, env IBL), PostStack [DOF, Tonemap neutral]. Focus settings: gate (the
// post-stack gate's 3.4 m f/1.4 r16), near (1.6 m: helmet and background blurred), far (12 m: helmet and near box in
// the near field), wide (2 m f/0.35 r32: 9-23 px background disks).
// 1. Quality at 1280x720 4x MSAA: screenshot per focus setting, old vs new mean/max 8-bit difference.
// 2. Flicker: 16 frames of a slow sideways camera move per variant; mean frame-to-frame difference, old vs new.
// 3. GPU ms of the DOF's own passes (every pass DOF begins), alternating old/new each round; median of the round
//    medians with min/max spread.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { acPower } from '../cad/power.mjs';

const option = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const rounds = +option('rounds', 6),
  frames = +option('frames', 90),
  baseline = option('baseline', '5b9dbbd');
const sizes = option('sizes', '1280x720,1920x1080')
    .split(',')
    .map((s) => s.split('x').map(Number)),
  msaas = option('msaa', '4,1').split(',').map(Number);
const out = option('out', 'examples/package-benchmarks/results/gates-dof.json');
const allScenes = {
  gate: { focalDistance: 3.4, aperture: 1.4, maxRadius: 16 },
  near: { focalDistance: 1.6, aperture: 1.4, maxRadius: 16 },
  far: { focalDistance: 12, aperture: 1.4, maxRadius: 16 },
  wide: { focalDistance: 2, aperture: 0.35, maxRadius: 32 },
};
const scenes = Object.fromEntries(
  option('scenes', Object.keys(allScenes).join(','))
    .split(',')
    .map((n) => [n, allScenes[n]]),
);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const root = resolve(import.meta.dirname, '../../..'),
  slash = (v) => v.replaceAll('\\', '/'),
  source = slash(resolve(root, 'packages/dof/src')) + '/';

// Baseline build: packages/dof/src read from git at the baseline ref, everything else (shared/) as checked out.
const baseDir = `test-results/dof-variants/${baseline}`;
await build({
  root: resolve(root, 'packages/dof'),
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  plugins: [
    {
      name: 'git-source',
      enforce: 'pre',
      load(id) {
        const file = slash(id.split('?')[0]);
        if (file.startsWith(source)) return git('show', `${baseline}:${file.slice(slash(root).length + 1)}`);
      },
    },
  ],
  build: {
    outDir: resolve(root, baseDir),
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: resolve(root, 'packages/dof/src/index.ts'), formats: ['es'], fileName: 'index' },
    rollupOptions: { external: ['@margoengine/core', '@margoengine/core/extension'] },
  },
});
// --extra=name:/url,... adds more builds (e.g. intermediate variants copied under test-results/) to every comparison.
const variants = {
  old: `/${baseDir}/index.js`,
  new: '/packages/dof/dist/index.js',
  ...Object.fromEntries(
    option('extra', '')
      .split(',')
      .filter(Boolean)
      .map((v) => v.split(':')),
  ),
};
const names = Object.keys(variants);

const lock =
  process.env.MARGO_GPU_LOCK_NESTED ??
  resolve(dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'test-results/gpu.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    console.log('gpu.lock held, waiting');
    await sleep(60_000);
  }
}
const report = {
  date: new Date().toISOString(),
  commit: git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain', 'packages/dof') !== '',
  baseline,
  acPowerBefore: acPower(),
  rounds,
  frames,
  scenes,
  scene: 'DamagedHelmet + 11 core boxes, env IBL, PostStack [DOF, Tonemap neutral], DPR 1',
  quality: {},
  flicker: {},
  timing: {},
};
let context;
try {
  assert.notEqual(report.acPowerBefore, false, 'On battery');
  context = await openBrowser({
    startPath: '/examples/package-benchmarks/gates/dof.html',
    port: 5243,
    args: ['--enable-webgpu-developer-features'],
  });
  const { page, hardware } = context,
    pageErrors = [];
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (
      (m.type() === 'error' || m.type() === 'warning') &&
      !/powerPreference option is currently ignored/.test(m.text())
    )
      pageErrors.push(m.text());
  });
  report.hardware = hardware;
  console.log('adapter', JSON.stringify(hardware.webgpu));
  await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
  const setup = async (config) => {
    const r = await page.evaluate((c) => window.bench.setup(c), config);
    assert.deepEqual(r.errors, [], JSON.stringify(config));
    return r;
  };
  const shot = async (dx, path) => {
    assert.deepEqual((await page.evaluate((d) => window.bench.render(d), dx)).errors, []);
    return decodePNG(await page.locator('canvas').screenshot(path ? { path } : {}));
  };
  const diff = (a, b) => {
    let s = 0,
      max = 0,
      changed = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      let p = 0;
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(a.data[i + c] - b.data[i + c]);
        s += d;
        p = Math.max(p, d);
      }
      max = Math.max(max, p);
      if (p > 6) changed++;
    }
    const n = a.width * a.height;
    return { meanAbsDiff: +(s / n / 3).toFixed(4), maxAbsDiff: max, changedFraction: +(changed / n).toFixed(5) };
  };

  // 1 + 2. Quality and flicker
  for (const [name, dof] of Object.entries(scenes)) {
    const images = {};
    for (const [variant, url] of Object.entries(variants)) {
      await setup({ variant: url, dof });
      images[variant] = await shot(0, `test-results/dof-${name}-${variant}.png`);
    }
    const none =
      (await setup({ variant: variants.new, dof: { ...dof, enabled: false } }),
      await shot(0, `test-results/dof-${name}-off.png`));
    report.quality[name] = {
      oldVsOff: diff(images.old, none),
      ...Object.fromEntries(names.slice(1).map((v) => [`${v}VsOld`, diff(images[v], images.old)])),
    };
    console.log('quality', name, JSON.stringify(report.quality[name]));
  }
  for (const name of ['gate', 'near'].filter((n) => scenes[n])) {
    report.flicker[name] = {};
    for (const [variant, url] of Object.entries(variants)) {
      await setup({ variant: url, dof: scenes[name] });
      let prev,
        sum = 0,
        max = 0;
      for (let i = 0; i < 16; i++) {
        const image = await shot(i * 0.002);
        if (prev) {
          const d = diff(image, prev);
          sum += d.meanAbsDiff;
          max = Math.max(max, d.meanAbsDiff);
        }
        prev = image;
      }
      report.flicker[name][variant] = { meanFrameToFrame: +(sum / 15).toFixed(4), maxFrameToFrame: max };
    }
    console.log('flicker', name, JSON.stringify(report.flicker[name]));
  }

  // 3. Timing
  const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  for (const size of sizes)
    for (const msaa of msaas)
      for (const [name, dof] of Object.entries(scenes)) {
        const key = `${name} ${size.join('x')} ${msaa}x`,
          samples = Object.fromEntries(names.map((n) => [n, []])),
          passes = Object.fromEntries(names.map((n) => [n, {}]));
        for (let round = 0; round < rounds; round++) {
          const order = names.map((_, i) => names[(i + round) % names.length]);
          if (round % 2) order.reverse();
          for (const variant of order) {
            if (acPower() === false) throw new Error('On battery mid-run');
            const s = await setup({ variant: variants[variant], dof, msaa, size });
            assert.deepEqual(s.canvas, size);
            const m = await page.evaluate((f) => window.bench.measure(f), frames);
            assert.deepEqual(m.errors, [], key);
            samples[variant].push(m.ownerMs.dof);
            for (const [k, v] of Object.entries(m.ownerMs))
              if (k.startsWith('dof:')) (passes[variant][k] ??= []).push(v);
          }
        }
        const stat = (a) => ({
          median: +median(a).toFixed(3),
          min: +Math.min(...a).toFixed(3),
          max: +Math.max(...a).toFixed(3),
          rounds: a,
        });
        report.timing[key] = Object.fromEntries(
          names.map((n) => [
            n,
            {
              ...stat(samples[n]),
              speedup: +(median(samples.old) / median(samples[n])).toFixed(2),
              passMedians: Object.fromEntries(Object.entries(passes[n]).map(([k, v]) => [k, +median(v).toFixed(3)])),
            },
          ]),
        );
        console.log(
          'timing',
          key,
          names
            .map((n) => {
              const t = report.timing[key][n];
              return `${n} ${t.median} (${t.min}-${t.max}) x${t.speedup} [${Object.values(t.passMedians).join('+')}]`;
            })
            .join(' | '),
        );
      }
  await page.evaluate(() => window.bench.teardown());
  assert.deepEqual(pageErrors, []);
  report.acPowerAfter = acPower();
  assert.notEqual(report.acPowerAfter, false, 'Ended on battery: discard this run');
  writeFileSync(out, JSON.stringify(report, null, 1));
  console.log('wrote', out);
} finally {
  await context?.close();
  rmSync(lock, { recursive: true, force: true });
}
