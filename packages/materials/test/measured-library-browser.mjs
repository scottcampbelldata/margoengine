// Real-GPU check of the measured materials library: every preset of `materials` (@margoengine/materials/presets) on a
// sphere lit by the procedural studio environment as its `envMap` (@margoengine/environment/studio), one frame each, drawn into one
// labelled contact sheet per backend (test-results/measured-library/<webgpu|webgl2>.png). It checks that each sphere
// renders with no GPU error, that a coloured preset keeps its strongest channel on screen (gold and copper red, grass
// green, patina green), that brighter albedo renders brighter, and, once both backends have run, that the WebGL2
// layer's sphere means match WebGPU's within 2 percent of full scale.
// Run from the repository root after building packages:
//   node scripts/run-with-timeout.mjs -- node packages/materials/test/measured-library-browser.mjs
//   node scripts/run-with-timeout.mjs -- node packages/materials/test/measured-library-browser.mjs --compat
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const compat = compatRun(),
  leg = compat ? 'webgl2' : 'webgpu',
  out = 'test-results/measured-library',
  browser = await openBrowser({ port: 'free' }),
  { page } = browser,
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
try {
  await page.waitForFunction(() => window.modern);
  const result = await page.evaluate(async () => {
    const { Engine } = await import('/packages/core/dist/index.js');
    const { PbrMaterial, createMesh } = await import('/packages/materials/dist/index.js');
    const { Environment, EnvironmentLighting, EnvironmentBackground } = await import(
      '/packages/environment/dist/index.js'
    );
    const { studio } = await import('/packages/environment/dist/studio.js');
    const presets = await import('/packages/materials/dist/presets.js');
    const { waitForPipelines } = await import('/scripts/support/gpu-ready.js');
    // A UV sphere of radius 1, 48 x 32.
    const P = [],
      N = [],
      U = [],
      I = [];
    for (let y = 0; y <= 32; y++)
      for (let x = 0; x <= 48; x++) {
        const t = (y / 32) * Math.PI,
          p = (x / 48) * 2 * Math.PI,
          n = [Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p)];
        P.push(...n);
        N.push(...n);
        U.push(x / 48, y / 32);
      }
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 48; x++) {
        const a = y * 49 + x,
          b = a + 49;
        I.push(a, a + 1, b, a + 1, b + 1, b);
      }
    const S = 128,
      canvas = document.body.appendChild(document.createElement('canvas'));
    const engine = await Engine.create(canvas, { exactSize: [S, S], camera: { position: [0, 0, 3.4], target: [0, 0, 0] } });
    const gpuErrors = [];
    engine.gpu.addEventListener('uncapturederror', (ev) => gpuErrors.push(ev.error.message));
    const environment = await Environment.attach(engine, studio());
    EnvironmentLighting.attach(engine, environment);
    EnvironmentBackground.attach(engine, environment, { blur: 0.6 });
    const sphere = { positions: P, normals: N, uvs: U, indices: I };
    const names = Object.keys(presets.materials),
      cols = 10,
      rows = Math.ceil(names.length / cols),
      sheet = document.createElement('canvas');
    sheet.width = cols * S;
    sheet.height = rows * (S + 14);
    const g = sheet.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, sheet.width, sheet.height);
    g.font = '11px sans-serif';
    const frame = async () => {
      engine.render();
      await engine.gpu.queue.onSubmittedWorkDone();
    };
    const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const spheres = {};
    for (let i = 0; i < names.length; i++) {
      const name = names[i],
        info = presets.materialInfo(name);
      const mesh = createMesh(engine, sphere, new PbrMaterial({ ...presets.materials[name], envMap: environment }));
      if (i === 0) await waitForPipelines(frame);
      await frame();
      const x = (i % cols) * S,
        y = Math.floor(i / cols) * (S + 14);
      // Draw and copy in one task, before the canvas texture is handed back.
      engine.render();
      g.drawImage(canvas, x, y, S, S);
      // Mean linear colour of a 24 x 24 patch at the sphere's centre.
      const d = g.getImageData(x + S / 2 - 12, y + S / 2 - 12, 24, 24).data,
        mean = [0, 0, 0];
      for (let p = 0; p < d.length; p += 4) for (let c = 0; c < 3; c++) mean[c] += linear(d[p + c]) / (d.length / 4);
      spheres[name] = { mean, kind: info.kind, provenance: info.provenance, color: [...presets.materials[name].color] };
      g.fillStyle = { measured: '#9e9', derived: '#ee9', art: '#e99' }[info.provenance];
      g.fillText(name, x + 3, y + S + 11);
      mesh.dispose();
    }
    const png = sheet.toDataURL('image/png');
    engine.dispose();
    canvas.remove();
    return { spheres, gpuErrors, png, backend: engine.backend ?? null };
  });
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/${leg}.png`, Buffer.from(result.png.split(',')[1], 'base64'));
  await writeFile(`${out}/${leg}.json`, JSON.stringify(result.spheres, null, 1));
  assert.deepEqual(result.gpuErrors, []);
  const s = result.spheres;
  for (const [name, r] of Object.entries(s)) {
    assert.ok(r.mean.every(Number.isFinite), name);
    const [cr, cg, cb] = r.color,
      top = Math.max(cr, cg, cb),
      low = Math.min(cr, cg, cb);
    // A strongly coloured preset (strongest channel over 1.6 times the weakest) keeps its strongest channel.
    if (top > 1.6 * low && top > 0.05) {
      const want = r.color.indexOf(top),
        got = r.mean.indexOf(Math.max(...r.mean));
      assert.equal(got, want, `${name}: preset ${r.color} renders ${r.mean.map((v) => v.toFixed(3))}`);
    }
  }
  const lum = (m) => 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  for (const [dark, light] of [
    ['asphalt', 'concrete'],
    ['darkSoil', 'drySoil'],
    ['basalt', 'limestone'],
    ['concrete', 'snow'],
  ])
    assert.ok(lum(s[dark].mean) < lum(s[light].mean), `${dark} renders darker than ${light}`);
  const other = `${out}/${compat ? 'webgpu' : 'webgl2'}.json`;
  if (existsSync(other)) {
    const o = JSON.parse(await readFile(other, 'utf8'));
    let worst = 0,
      at = '';
    for (const [name, r] of Object.entries(s))
      for (let c = 0; c < 3; c++) {
        const dlt = Math.abs(r.mean[c] - o[name].mean[c]);
        if (dlt > worst) [worst, at] = [dlt, name];
      }
    console.log(`WebGPU against WebGL2: worst sphere mean difference ${worst.toFixed(4)} (${at})`);
    assert.ok(worst < 0.02, `backends differ by ${worst} at ${at}`);
  }
  assert.deepEqual(errors, []);
  console.log(`measured library on ${leg}: ${Object.keys(s).length} spheres, sheet ${out}/${leg}.png`);
} finally {
  await browser.close();
}
