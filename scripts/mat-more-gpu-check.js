// Real-GPU check of @margoengine/materials' toon shading (constructed, clustered, loaded, skinned, morphed),
// per-material envMap (CubeTexture faces, a cube render target, an Environment, mip sampling by roughness), float, 3D and
// array data textures in a WgslMaterial, a standalone KTX2 texture, Display P3 textures and the shadow catcher's
// directional and area light shadows. Each case compares against an analytic value or a feature-off render.
// Run: node scripts/gpu-lock.mjs run --owner=mat-more -- node scripts/mat-more-gpu-check.js
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from './browser.js';
import { acquire } from './gpu-lock.mjs';
import { P3_TO_SRGB } from '../packages/math/dist/color.js';

const release = await acquire({ owner: 'mat-more-gpu-check' });
let browser;
const checks = [],
  failures = [];
/** Records `name`: `actual` within `tolerance` of `expected` in every channel. */
function near(name, actual, expected, tolerance) {
  const error = Math.max(...expected.map((e, i) => Math.abs(actual[i] - e)));
  checks.push({ name, actual: actual.map((v) => +v.toFixed(5)), expected, error: +error.toFixed(5), tolerance });
  if (!(error <= tolerance))
    failures.push(`${name}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)} (error ${error})`);
}
function truth(name, value, detail) {
  checks.push({ name, ok: !!value, detail });
  if (!value) failures.push(`${name}: ${JSON.stringify(detail)}`);
}
const scale = (v, k) => v.map((x) => x * k);
try {
  await mkdir('test-results/mat-more', { recursive: true });
  browser = await openBrowser({ startPath: '/tests/mat-more.html', port: 5305 });
  const page = browser.page,
    pageErrors = [],
    results = {};
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => window.matMoreFixture, null, { timeout: 60000 });
  assert.equal(browser.hardware.webgpu?.fallback, false, 'Physical WebGPU adapter required');
  for (const name of ['toon', 'toonClustered', 'toonLoaded', 'envMap', 'dataTextures', 'ktx2', 'p3', 'catcher']) {
    const { result, errors } = await page.evaluate((n) => window.matMoreFixture.run(n), name);
    results[name] = result;
    truth(name + ': no WebGPU validation or engine errors', errors.length === 0, errors);
  }
  const c = [0.8, 0.4, 0.2],
    t = results.toon;
  // Toon, sun with intensity pi: colour x ramp. steps 3: n.l = 1 -> band 2 (1), n.l = 0.2 -> band 1 (0.5), n.l = -1 -> 0.
  near('toon steps: facing the sun is the top band', t.facing.mean, c, 0.004);
  near('toon steps: n.l 0.2 is the middle band (0.5)', t.side.mean, scale(c, 0.5), 0.004);
  near('toon steps: facing away is the bottom band (0)', t.behind.mean, [0, 0, 0], 0.001);
  near('toon gradientMap: u = 1 reads the last texel (1.0)', t.gradientFacing.mean, c, 0.004);
  near('toon gradientMap: u = 0.6 reads texel 2 of 4 (153/255)', t.gradientSide.mean, scale(c, 153 / 255), 0.004);
  near('toon hemisphere ambient equals Lambert', t.ambientToon.mean, t.ambientLambert.mean, 0.002);
  truth(
    'toon bands are flat (spread < 0.003)',
    [t.facing, t.side, t.gradientSide].every((b) => b.spread < 0.003),
    [t.facing.spread, t.side.spread, t.gradientSide.spread],
  );
  const k = results.toonClustered,
    ratio = k.banded.mean.map((v, i) => v / k.open.mean[i]);
  truth('toon clustered point light lights the mesh', k.open.mean[0] > 0.01, k.open.mean);
  near('toon clustered point light: steps 3 over unbanded is the middle band (0.5)', ratio, [0.5, 0.5, 0.5], 0.01);
  const l = results.toonLoaded;
  near(
    'toonModel: a loaded glTF quad matches the constructed ToonMaterial quad',
    l.toon.mean,
    l.constructed.mean,
    0.002,
  );
  near('toonModel: facing the sun is the top band', l.toon.mean, c, 0.004);
  truth('toonModel changes the loaded standard shading', Math.abs(l.standard.mean[0] - l.toon.mean[0]) > 0.01, [
    l.standard.mean,
    l.toon.mean,
  ]);
  near(
    'toonModel + Skin: the bone turned -75 deg (n.l 0.26) puts it in the middle band',
    l.skinned.mean,
    scale(c, 0.5),
    0.006,
  );
  truth(
    'toonModel + Skin: disposing restores the standard shading',
    Math.abs(l.skinnedStandard.mean[0] - l.skinned.mean[0]) > 0.01,
    [l.skinnedStandard.mean, l.skinned.mean],
  );
  near('toonModel + morph target normals (n.l 0.26) is the middle band', l.morphed.mean, scale(c, 0.5), 0.006);
  near('toonModel dispose restores every pixel', [l.restoredMaxDifference], [0], 0);
  const e = results.envMap;
  near('envMap unlit mix: a quad facing +Z reflects the +Z face (blue)', e.front.mean, [0, 0, 1], 0.002);
  near('envMap unlit mix: a normal tilted to +X reflects the +X face (red)', e.tilted.mean, [1, 0, 0], 0.002);
  near('envMap from a cube render target {texture, view}', e.target.mean, [0, 0, 1], 0.002);
  truth(
    'envMap roughness 0 mirrors the red half',
    e.sharpLeft.mean[0] > 0.9 && e.sharpLeft.mean[1] < 0.03,
    e.sharpLeft.mean,
  );
  truth(
    'envMap roughness 0 mirrors the green half',
    e.sharpRight.mean[1] > 0.9 && e.sharpRight.mean[0] < 0.03,
    e.sharpRight.mean,
  );
  truth(
    'envMap roughness 1 reads the 1x1 mip (red = green on both sides)',
    [e.roughLeft, e.roughRight].every((b) => Math.abs(b.mean[0] - b.mean[1]) < 0.01 && b.mean[0] > 0.15),
    [e.roughLeft.mean, e.roughRight.mean],
  );
  near('envMap uniform white CubeTexture: specular + diffuse = 1', e.uniformCube.mean, [1, 1, 1], 0.01);
  near(
    'envMap uniform white Environment (SH irradiance): specular + diffuse = 1',
    e.uniformEnvironment.mean,
    [1, 1, 1],
    0.015,
  );
  near('envMap cleared draws as a material that never had one', [e.offMaxDifference], [0], 0);
  const d = results.dataTextures;
  near(
    'rgba16float data sampled by a WgslMaterial keeps > 1 and negative values',
    d.float16.mean,
    [2.5, -0.5, 0.25],
    0.002,
  );
  near(
    'r32float 3D texel (1,0,1) by textureLoad and 2D array layer 1',
    d.volumeAndArray.mean,
    [d.expected.before, 0.2, 0.8],
    0.002,
  );
  near('a 3D region update shows next frame', d.volumeUpdated.mean, [d.expected.volume, 0.2, 0.8], 0.002);
  const x = results.ktx2;
  truth('KTX2 Dot_C.ktx2 decoded 128x128 with 8 mips', x.size.join() === '128,128,8', x.size);
  near('KTX2 RGBA8 transcode on a map equals the same texels as raw data', [x.rgba8VsReference.max], [0], 0);
  near(`KTX2 ${x.target} transcode on a map matches RGBA8 (mean error)`, [x.compressedVsReference.mean], [0], 0.01);
  truth('KTX2 image has contrast (not a flat fallback)', x.contrast > 0.1, x.contrast);
  const p = results.p3,
    red = [P3_TO_SRGB[0], P3_TO_SRGB[3], P3_TO_SRGB[6]];
  near('P3 red converts to linear sRGB with negative green and blue (math P3_TO_SRGB)', p.p3Red.mean, red, 0.003);
  near('sRGB red is unchanged', p.srgbRed.mean, [1, 0, 0], 0.001);
  near('a P3 neutral grey equals the sRGB grey', p.p3Grey.mean, p.srgbGrey.mean, 0.003);
  const s = results.catcher;
  for (const kind of ['directional', 'area']) {
    truth(
      `catcher: ${kind} castShadow darkens the shadow (1 - alpha < 0.2)`,
      s[kind + 'Shadow'].shadow.mean[0] < 0.2,
      s[kind + 'Shadow'].shadow.mean,
    );
    near(`catcher: ${kind} castShadow leaves lit ground clear`, s[kind + 'Shadow'].lit.mean, [1, 1, 1], 0.02);
    near(`catcher: ${kind} without castShadow stays clear`, s[kind + 'Open'].shadow.mean, [1, 1, 1], 0.002);
  }
  truth('no page errors', pageErrors.length === 0, pageErrors);
  await writeFile(
    'test-results/mat-more/gpu.json',
    JSON.stringify({ hardware: browser.hardware, checks, failures, results }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        hardware: browser.hardware.webgpu,
        passed: checks.length - failures.length,
        checks: checks.length,
        failures,
        report: 'test-results/mat-more/gpu.json',
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], 'materials GPU checks failed');
} finally {
  await browser?.page.evaluate(() => window.matMoreFixture?.dispose()).catch(() => {});
  await browser?.close();
  release();
}
