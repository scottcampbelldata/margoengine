// Real-GPU check of HANDOFF 5c (run on AC power, holding the GPU lock, after npm run build:packages):
//   node examples/package-benchmarks/binding-limit-gpu.mjs [ref]
// binding-limit.html draws a PHYSICAL-variant gltf-pro sphere grid with shadows, environment IBL + fog, clustered lights and
// LocalShadows. 1. With environment as of `ref` (BRDF LUT texture) on a default-limits device the frame fails with gltf-pro's
// named-combination error (17 sampled textures). 2. The same at the adapter's raised limits is the reference. 3. The working
// tree (BRDF LUT in a storage buffer) on a default-limits device renders with no error and must match the reference.
// 4. Karis's analytic fit in place of the LUT, measured only (whole frame, and per sphere: centre vs rim, i.e. grazing).
// Writes results/binding-limit-gpu.json and the frames to test-results/binding-limit-*.png.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { build } from 'vite';
import { openBrowser } from '../../scripts/browser.js';
import { decodePNG } from '../../tests/support/png.js';

const root = resolve(import.meta.dirname, '../..'),
  ref = process.argv[2] ?? 'e017d50',
  slash = (v) => v.replaceAll('\\', '/');
const ac = () =>
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline',
    ],
    { encoding: 'utf8' },
  ).trim();
const powerBefore = ac();
assert.equal(powerBefore, 'True', 'measure on AC power only');

// environment's src at `ref`, bundled to one module (bare imports resolved by the page's dev server).
const source = slash(resolve(root, 'packages/environment/src')) + '/';
const bundle = await build({
  root: resolve(root, 'packages/environment'),
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  plugins: [
    {
      name: 'git-source',
      enforce: 'pre',
      load(id) {
        const file = slash(id.split('?')[0]);
        if (file.startsWith(source))
          return execFileSync('git', ['show', `${ref}:${file.slice(slash(root).length + 1)}`], {
            cwd: root,
            encoding: 'utf8',
            maxBuffer: 1 << 26,
          });
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    target: 'es2022',
    lib: { entry: resolve(source, 'index.ts'), formats: ['es'] },
    rollupOptions: { external: (id) => !id.startsWith('.') && !isAbsolute(id) && !/^[a-z]:[\\/]/i.test(id) },
  },
});
await mkdir(resolve(root, 'test-results/binding-limit-ref'), { recursive: true });
await writeFile(resolve(root, 'test-results/binding-limit-ref/environment.js'), bundle[0].output[0].code);

const context = await openBrowser({ startPath: '/examples/package-benchmarks/binding-limit.html', port: 5223 }),
  { page, hardware } = context,
  pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
const report = {
  benchmark: 'binding-limit-gpu',
  baseline: ref,
  recordedAt: new Date().toISOString(),
  hardware: hardware.webgpu,
  browser: hardware.browserName + ' ' + hardware.browserVersion,
  resolution: [1280, 720],
  powerOnline: { before: powerBefore },
};
const origin = new URL(page.url()).origin;
const open = async (query) => {
  await page.goto(`${origin}/examples/package-benchmarks/binding-limit.html${query}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
};
const shot = async (name, query) => {
  await open(query);
  const result = await page.evaluate(() => window.check.render());
  return {
    result,
    image: await decodePNG(await page.locator('canvas').screenshot({ path: `test-results/binding-limit-${name}.png` })),
  };
};
const stats = (a, b, inside = () => true) => {
  let sum = 0,
    max = 0,
    n = 0,
    over2 = 0,
    over8 = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (!inside(x, y)) continue;
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.abs(a.data[i + c] - b.data[i + c]);
        sum += v;
        d = Math.max(d, v);
      }
      max = Math.max(max, d);
      n++;
      if (d > 2) over2++;
      if (d > 8) over8++;
    }
  return {
    pixels: n,
    meanAbsDiff: +(sum / n / 3).toFixed(4),
    maxDiff: max,
    fractionOver2: +(over2 / n).toFixed(5),
    fractionOver8: +(over8 / n).toFixed(5),
  };
};
try {
  const failing = await shot('ref-default-limits', '?env=ref&limits=default');
  report.referenceAtDefaultLimits = failing.result;
  console.log('ref at default limits', JSON.stringify(failing.result));
  assert.equal(failing.result.limits.sampledTextures, 16);
  assert.match(
    [failing.result.thrown, ...failing.result.errors].join(' | '),
    /physical material \+ .*environment:lighting.*needs 17 sampled textures per shader stage; this device allows 16/,
    'named-combination error',
  );
  pageErrors.length = 0;

  const reference = await shot('reference', '?env=ref');
  report.reference = reference.result;
  console.log('reference', JSON.stringify(reference.result));
  assert.ok(reference.result.limits.sampledTextures > 16, 'reference needs an adapter above 16 sampled textures');
  assert.deepEqual([reference.result.error, reference.result.thrown, reference.result.errors], [null, null, []]);
  const spheres = await page.evaluate(() => window.check.spheres());

  const candidate = await shot('candidate', '');
  report.candidate = candidate.result;
  console.log('candidate', JSON.stringify(candidate.result));
  assert.deepEqual(
    candidate.result.limits,
    { sampledTextures: 16, samplers: 16 },
    'candidate runs at WebGPU default limits',
  );
  assert.deepEqual([candidate.result.error, candidate.result.thrown, candidate.result.errors], [null, null, []]);
  const nonBlank = reference.image.data.some((v, i) => i % 4 < 3 && Math.abs(v - reference.image.data[i % 4]) > 30);
  assert.ok(nonBlank, 'reference drew something');

  const karis = await shot('karis', '?brdf=karis');
  assert.deepEqual([karis.result.error, karis.result.thrown, karis.result.errors], [null, null, []]);

  const regions = (image) => {
    const out = { frame: stats(reference.image, image), spheres: [] };
    for (const s of spheres) {
      const r2 = (x, y) => ((x + 0.5 - s.centre[0]) ** 2 + (y + 0.5 - s.centre[1]) ** 2) / s.radiusPx ** 2;
      out.spheres.push({
        roughness: +s.roughness.toFixed(3),
        metal: s.metal,
        coat: s.coat,
        centre: stats(reference.image, image, (x, y) => r2(x, y) < 0.64),
        rim: stats(reference.image, image, (x, y) => r2(x, y) >= 0.64 && r2(x, y) < 0.96),
      });
    }
    const worst = (key) => out.spheres.reduce((w, s) => (s[key].meanAbsDiff > w[key].meanAbsDiff ? s : w));
    out.worstCentre = worst('centre');
    out.worstRim = worst('rim');
    delete out.spheres;
    return out;
  };
  report.candidateVsReference = regions(candidate.image);
  console.log('buffer LUT vs reference', JSON.stringify(report.candidateVsReference));
  report.karisVsReference = regions(karis.image);
  console.log('Karis fit vs reference', JSON.stringify(report.karisVsReference));
  const c = report.candidateVsReference.frame;
  assert.ok(c.maxDiff <= 2 && c.meanAbsDiff < 0.05, 'storage-buffer LUT matches the texture LUT within 2/255');
  assert.deepEqual(pageErrors, []);
} finally {
  await context.close();
}
report.powerOnline.after = ac();
assert.equal(report.powerOnline.after, 'True', 'still on AC power');
await writeFile(resolve(import.meta.dirname, 'results/binding-limit-gpu.json'), JSON.stringify(report, null, 2) + '\n');
console.log('binding limit GPU check passed');
