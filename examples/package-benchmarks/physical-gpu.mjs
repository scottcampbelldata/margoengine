// Real-GPU check of physical materials on meshes built in code (HANDOFF 5l.g). Correctness only (no timing). After
// npm run build:packages, on AC power, under the GPU lock:
//   node scripts/gpu-lock.mjs run --owner=<id> -- node examples/package-benchmarks/physical-gpu.mjs [--only=side,brdf,refraction,lit]
// 1. Side by side: a materials sphere and the equivalent glTF sphere (gltf-pro) for glass (refracting a checkerboard),
//    clearcoat car paint and sheen fabric, MSAA 4x: linear HDR capture and the displayed 8-bit frame.
// 2. BRDF terms: car paint and fabric under one directional light without ambient against the CPU reference
//    (packages/materials/test/physical-reference.js, composed as gltf-pro's physical shader composes them), per pixel.
// 3. Refraction: the light the glass adds over a checkerboard (frame with checkerboard minus frame without) against the
//    CPU model of the same terms (refracted exit point, scene mip chain, Beer-Lambert volume, 1 - Fresnel), 1x and 4x;
//    the same pixels without refraction as a control.
// 4. Lit: each preset, both kinds, refracting, with shadows, IBL, fog and clustered lights + LocalShadows: renders with 0
//    validation errors or throws gltf-pro's named texture-limit error (a glTF physical material has 13 textures of its own).
// Every frame is checked for 0 WebGPU validation errors. Writes results/physical-gpu.json and test-results/physical-*.png.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBrowser} from '../../scripts/browser.js';
import {decodePNG} from '../../tests/support/png.js';
import {invertMatrix} from '../../packages/math/dist/mat4.js';
import * as ref from '../../packages/materials/test/physical-reference.js';

const ac = () => execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Select-Object -First 1).PowerOnline'], {encoding: 'utf8'}).trim();
const powerBefore = ac(); assert.equal(powerBefore, 'True', 'run on AC power only');
const context = await openBrowser({startPath: '/examples/package-benchmarks/physical.html', port: 5237}), {page, hardware} = context, pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message)); page.on('console', m => {if (m.type() === 'error') pageErrors.push(m.text());});
const report = {benchmark: 'physical-gpu', recordedAt: new Date().toISOString(), hardware: hardware.webgpu, browser: hardware.browserName + ' ' + hardware.browserVersion, powerOnline: {before: powerBefore}, validationErrors: 0};
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(','), want = name => !only || only.includes(name);
const SIZE = 256, LIGHT = {direction: ref.normalize([0.4, 0.7, 0.6]), intensity: 3};
const frames = async (allowThrow = false) => {const r = await page.evaluate(() => window.check.frames(3)); assert.deepEqual(r.errors, [], 'WebGPU validation errors'); if (!allowThrow) assert.equal(r.thrown, undefined); return r;};
const build = async o => {await page.evaluate(o => window.check.build(o), {width: SIZE, height: SIZE, samples: 4, ...o}); await frames();};
const show = async o => {await page.evaluate(o => window.check.show(o), o); await frames();};
const hdr = () => page.evaluate(() => window.check.readHDR());
const shot = path => page.locator('canvas').screenshot({path}).then(decodePNG);
const clear = () => page.evaluate(() => window.check.clear());
const stats = errors => {const s = [...errors].sort((a, b) => a - b); return {pixels: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(5), p95: +s[Math.floor(s.length * 0.95)].toFixed(5), max: +s[s.length - 1].toFixed(5)};};

// Per pixel: the ray from the camera through the pixel centre and its hit on the unit sphere at the origin.
function hits(camera, width, height, minFacing = 0.3) {
  const inverse = invertMatrix(camera.matrix, new Float64Array(16)), out = [];
  const unproject = (x, y, z) => {const m = inverse, w = m[3] * x + m[7] * y + m[11] * z + m[15]; return [0, 1, 2].map(r => (m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]) / w);};
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const x = (px + 0.5) / width * 2 - 1, y = 1 - (py + 0.5) / height * 2, o = camera.position, d = ref.normalize(ref.add(unproject(x, y, 0.5), ref.scale(o, -1)));
    const b = ref.dot(o, d), disc = b * b - (ref.dot(o, o) - 1); if (disc <= 0) continue;
    const p = ref.add(o, ref.scale(d, -b - Math.sqrt(disc))), n = ref.normalize(p), v = ref.scale(d, -1);
    if (ref.dot(n, v) >= minFacing) out.push({index: py * width + px, p, n, v});
  }
  return out;
}
const project = (camera, p) => {const m = camera.matrix, c = [0, 1, 3].map(r => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]); return [c[0] / c[2] * 0.5 + 0.5, 0.5 - c[1] / c[2] * 0.5];};

// The scene copy as the GPU builds it: level 0 the image, each further level bilinear at its texel centres (2x2 averages).
function bilinear(level, u, v) {
  const {w, h, data} = level, x = u * w - 0.5, y = v * h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (i, j, k) => data[(Math.min(Math.max(j, 0), h - 1) * w + Math.min(Math.max(i, 0), w - 1)) * 4 + k];
  return [0, 1, 2].map(k => (at(x0, y0, k) * (1 - fx) + at(x0 + 1, y0, k) * fx) * (1 - fy) + (at(x0, y0 + 1, k) * (1 - fx) + at(x0 + 1, y0 + 1, k) * fx) * fy);
}
function mips(w, h, data) {
  const chain = [{w, h, data}];
  while (chain.length < Math.floor(Math.log2(Math.max(w, h))) + 1) {
    const prev = chain[chain.length - 1], nw = Math.max(prev.w >> 1, 1), nh = Math.max(prev.h >> 1, 1), next = new Float64Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) next.set(bilinear(prev, (x + 0.5) / nw, (y + 0.5) / nh), (y * nw + x) * 4);
    chain.push({w: nw, h: nh, data: next});
  }
  return chain;
}
const trilinear = (chain, u, v, lod) => {const l = Math.min(Math.max(lod, 0), chain.length - 1), l0 = Math.floor(l), t = l - l0, a = bilinear(chain[l0], u, v); if (!t) return a; const b = bilinear(chain[Math.min(l0 + 1, chain.length - 1)], u, v); return a.map((x, k) => x * (1 - t) + b[k] * t);};

// gltf-pro's physical fragment for one directional light and no ambient, from the reference terms.
function physicalDirect(o, n, v) {
  const l = LIGHT.direction, light = LIGHT.intensity, base = o.color, metal = o.metalness ?? 0, h = ref.normalize(ref.add(v, l));
  const nl = Math.max(ref.dot(n, l), 0), nv = Math.min(Math.max(ref.dot(n, v), 1e-4), 1), nh = Math.max(ref.dot(n, h), 0), vh = Math.max(ref.dot(v, h), 0);
  const specular = (r, F) => {const a = Math.min(Math.max(r, 0.045), 1) ** 2; return ref.ggxD(a, nh) * ref.smithG1(a, nv) * ref.smithG1(a, nl) * F / Math.max(4 * nl * nv, 1e-4);};
  const f0 = ref.dielectricF0(o.ior ?? 1.5, o.specularColor ?? [1, 1, 1], o.specularIntensity ?? 1).map((f, i) => f * (1 - metal) + base[i] * metal);
  let color = base.map((b, i) => {const F = ref.schlick(f0[i], vh); return ((1 - F) * (1 - metal) * (1 - (o.transmission ?? 0)) * b / Math.PI + specular(o.roughness ?? 1, F)) * nl * light;});
  const sheenColor = o.sheenColor ?? [0, 0, 0], sw = Math.max(o.sheenRoughness ?? 0, 0.07), sheen = ref.charlieD(sw * sw, nh) * ref.sheenV(nl, nv) * nl;
  color = color.map((c, i) => c * (1 - 0.157 * Math.max(...sheenColor)) + sheenColor[i] * sheen * light);
  const coat = specular(o.clearcoatRoughness ?? 0, 1) * nl * light;
  return ref.clearcoatMix(color, [coat, coat, coat], o.clearcoat ?? 0, ref.dot(n, v));
}

try {
  await page.waitForFunction(() => window.ready, null, {timeout: 60000});
  const presets = await page.evaluate(() => window.check.presets);
  // 1. Side by side.
  if (want('side')) {
    report.sideBySide = {};
    for (const preset of ['glass', 'carpaint', 'fabric']) {
      const frame = {};
      for (const kind of ['materials', 'gltf']) {
        await build({kind, preset, refraction: preset === 'glass', ambient: 0.15});
        frame[kind] = {hdr: await hdr(), png: await shot(`test-results/physical-${preset}-${kind}.png`)}; await clear();
      }
      const a = frame.materials, b = frame.gltf, hdrDiff = a.hdr.data.map((x, i) => i % 4 === 3 ? 0 : Math.abs(x - b.hdr.data[i])), ldrDiff = [];
      for (let i = 0; i < a.png.data.length; i += 4) for (let k = 0; k < 3; k++) ldrDiff.push(Math.abs(a.png.data[i + k] - b.png.data[i + k]));
      const row = {hdrMaxAbs: +hdrDiff.reduce((m, x) => Math.max(m, x), 0).toFixed(5), hdrMeanAbs: +(hdrDiff.reduce((s, x) => s + x, 0) / (hdrDiff.length * 0.75)).toFixed(6),
        ldrMaxChannel: ldrDiff.reduce((m, x) => Math.max(m, x), 0), ldrPixelsOver1: ldrDiff.filter(x => x > 1).length};
      report.sideBySide[preset] = row; console.log('side', preset, JSON.stringify(row));
      assert.ok(row.ldrMaxChannel <= 1 && row.hdrMeanAbs <= 1e-4, `${preset}: materials and glTF spheres differ by more than 1/255`);
    }
  }
  // 2. Clearcoat and sheen layers against the CPU reference (HDR, no ambient, sphere only).
  if (want('brdf')) {
    report.brdf = {};
    for (const preset of ['carpaint', 'fabric']) {
      await build({kind: 'materials', preset, checker: false, ambient: 0});
      const image = await hdr(), camera = await page.evaluate(() => window.check.camera()); await clear();
      const relative = [], absolute = [];
      for (const {index, n, v} of hits(camera, image.width, image.height)) {
        const want = physicalDirect(presets[preset].options, n, v);
        if (ref.dot(n, LIGHT.direction) < 0.1) continue;
        for (let k = 0; k < 3; k++) {const got = image.data[index * 4 + k], e = Math.abs(got - want[k]); absolute.push(e); relative.push(e / Math.max(want[k], 0.05));}
      }
      const row = {absolute: stats(absolute), relative: stats(relative)};
      report.brdf[preset] = row; console.log('brdf', preset, JSON.stringify(row));
      assert.ok(row.relative.p95 <= 0.01 && row.relative.mean <= 0.003, `${preset}: GPU layers differ from the CPU reference`);
    }
  }
  // 3. Refraction of the checkerboard.
  if (want('refraction')) {
    report.refraction = {};
    const o = presets.glass.options, f0 = ref.dielectricF0(o.ior), transmittance = ref.volumeTransmittance(o.attenuationColor, o.attenuationDistance, o.thickness);
    for (const samples of [1, 4]) {
      await build({kind: 'materials', preset: 'glass', refraction: true, samples, ambient: 0.15});
      const images = {};
      for (const [name, s, c] of [['behind', false, true], ['empty', false, false], ['glass', true, true], ['glassOnly', true, false]]) {await show({sphere: s, checker: c}); images[name] = await hdr();}
      await show({sphere: true, checker: true}); await shot(`test-results/physical-refraction-${samples}x.png`);
      const camera = await page.evaluate(() => window.check.camera()); await clear();
      const {width: w, height: h} = images.behind, behind = images.behind.data.map((x, i) => x - images.empty.data[i]), chain = mips(w, h, behind);
      const lod = ref.transmissionLod(w, Math.max(o.roughness, 0.045), o.ior), errors = [], control = [];
      for (const {index, p, n, v} of hits(camera, w, h)) {
        const [u, t] = project(camera, ref.exitPoint(p, v, n, o.ior, o.thickness)), [su, st] = [((index % w) + 0.5) / w, (Math.floor(index / w) + 0.5) / h];
        const expected = ref.transmitted({n, v, base: o.color, f0, behind: trilinear(chain, u, t, lod), transmittance});
        const straight = ref.transmitted({n, v, base: o.color, f0, behind: trilinear(chain, su, st, lod), transmittance});
        for (let k = 0; k < 3; k++) {const got = images.glass.data[index * 4 + k] - images.glassOnly.data[index * 4 + k]; errors.push(Math.abs(got - expected[k])); control.push(Math.abs(got - straight[k]));}
      }
      const row = {samples, lod: +lod.toFixed(3), refracted: stats(errors), withoutRefraction: stats(control)};
      report.refraction[samples + 'x'] = row; console.log('refraction', JSON.stringify(row));
      assert.ok(row.refracted.mean <= 0.002 && row.refracted.p95 <= 0.005, 'refraction differs from the CPU model');
      assert.ok(row.withoutRefraction.mean > 50 * row.refracted.mean, 'the control (no refraction) must be clearly worse');
    }
  }
  // 4. With every lighting package.
  if (want('lit')) {
    report.lit = {};
    for (const preset of ['glass', 'carpaint', 'fabric']) for (const kind of ['materials', 'gltf']) {
      await page.evaluate(o => window.check.build(o), {width: SIZE, height: SIZE, samples: 4, kind, preset, refraction: true, lit: true, ambient: 0.15});
      const r = await frames(true); if (!r.thrown) await shot(`test-results/physical-lit-${preset}-${kind}.png`); await clear();
      report.lit[`${preset}/${kind}`] = r.thrown ?? 'rendered'; console.log('lit', preset, kind, r.thrown ?? 'rendered');
      if (r.thrown) assert.match(r.thrown, /needs 1[7-9] sampled textures per shader stage; this device allows 16/);
      if (kind === 'materials') assert.equal(r.thrown, undefined, 'materials physical meshes fit with every lighting package');
    }
  }
} finally {
  report.powerOnline.after = ac(); report.pageErrors = pageErrors;
  await writeFile(resolve('examples/package-benchmarks/results/physical-gpu.json'), JSON.stringify(report, null, 2) + '\n');
  await context.close();
}
assert.deepEqual(pageErrors, []); assert.equal(report.powerOnline.after, 'True', 'lost AC power during the run');
console.log('physical-gpu: ok');
