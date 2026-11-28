// `npm run test:shot` part 4 (WebGPU): every clean-frame look check (roadmap T1 to T8) that reads a mask runs on the
// masks of a real shot (KB-LOOK-SHADOWMASK1). The test scene with `?aov=look` gives `penumbra`, `subject`, `lit` and
// `shadow` from SceneTargets' sun light values (@margoengine/post/mrt over @margoengine/shadows) beside geometry and
// depth; the shot lists them in `aovs` and asks for the moving evidence, so penumbra (T1), silhouette and
// silhouetteShape (T5), bounce and shadowTint (T6), shimmerMoving (T4) and motionBlur (T8) all run, none missing.
// The masks must hold real pixels: shaded ground under the boxes, lit ground around them, a soft edge between, and
// the gltf subject; and the frame must be darker where the shadow mask is. Needs `npm run build:packages` first.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePNG } from '@margoengine/headless/compare';
import { parseShot } from '../shot-file.mjs';
import { shoot } from '../render.mjs';
import { lookShot } from '../look.mjs';

const root = resolve(import.meta.dirname, '../../..');
process.chdir(root);
const MASKS = ['penumbra', 'subject', 'lit', 'shadow'];
const source = {
  format: 'margo-cutscene',
  version: 1,
  duration: 1,
  tracks: [
    {
      type: 'camera',
      id: 'orbit',
      keys: [
        { time: 0, position: [0, 8, 12], target: [0, 0.5, 0], fov: 50 },
        { time: 1, position: [6, 7, 10], target: [0, 0.5, 0], fov: 50 },
      ],
    },
  ],
  shot: {
    format: 'margo-shot',
    version: 1,
    id: 'look-masks',
    seed: 7,
    // Large enough for T1's grain estimate (PENUMBRA_MIN_PIXELS, 2,055 interior pixels): at 480 x 270 the soft edge held
    // 233, and its area grows with the square of the frame's size.
    size: [1920, 1080],
    supersample: 1,
    fps: 30,
    seconds: 0.5,
    warmup: 4,
    probes: { open: 0.2 },
    lookFamily: 'animatedFeature',
    moving: { depthScale: 20 },
    aovs: ['geometry', 'depth', ...MASKS],
    page: {
      path: 'tools/shot/test/scene.html',
      query: { aov: 'look' },
      css: '#viewport{position:fixed;inset:0;width:100%!important;height:100%!important}',
      engine: 'shotScene.engine',
      canvas: '#viewport',
      aovs: 'shotScene.aovs',
    },
  },
};
const file = parseShot(source);
const out = join(root, 'test-results', 'shots', 'look-masks-check');
rmSync(out, { recursive: true, force: true });
const manifest = await shoot(file, { out, runs: 1, log: () => {} });
const probe = manifest.probes.open;
for (const name of MASKS) assert.ok(probe.aovs?.[name], `the probe has the ${name} mask`);
const frame = await decodePNG(readFileSync(join(out, probe.file))),
  masks = Object.fromEntries(
    await Promise.all(MASKS.map(async (name) => [name, await decodePNG(readFileSync(join(out, probe.aovs[name])))])),
  );
const luma = (i) => 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2];
const inside = (name) => {
  let n = 0,
    y = 0;
  const data = masks[name].data;
  for (let i = 0; i < data.length; i += 4)
    if (data[i] >= 128) {
      n++;
      y += luma(i);
    }
  return { n, luma: y / n };
};
const seen = Object.fromEntries(MASKS.map((name) => [name, inside(name)]));
assert.ok(seen.lit.n > 80000, `lit ground fills the floor (${seen.lit.n} px)`);
assert.ok(seen.shadow.n > 4800, `the boxes put shaded ground down (${seen.shadow.n} px)`);
assert.ok(seen.penumbra.n > 480, `with a soft edge (${seen.penumbra.n} px)`);
assert.ok(seen.subject.n > 3200, `the gltf subject is in view (${seen.subject.n} px)`);
assert.ok(
  seen.shadow.luma < 0.7 * seen.lit.luma,
  `the frame is darker in the shadow mask (${seen.shadow.luma} against ${seen.lit.luma})`,
);
const report = await lookShot(out, manifest),
  rows = Object.fromEntries(report.json.probes[0].results.map((row) => [row.check, row]));
for (const name of [
  'penumbra',
  'silhouette',
  'silhouetteShape',
  'bounce',
  'shadowTint',
  'shimmerMoving',
  'motionBlur',
]) {
  assert.ok(rows[name], `${name} runs on the shot's own evidence`);
  assert.equal(rows[name].missing, undefined, `${name} has its input`);
  assert.ok(Number.isFinite(rows[name].value), `${name} measures a value (${rows[name].value})`);
}
console.log(
  `ok look masks: lit ${seen.lit.n}, shadow ${seen.shadow.n}, penumbra ${seen.penumbra.n}, subject ${seen.subject.n} px; ` +
    ['penumbra', 'silhouette', 'silhouetteShape', 'bounce', 'shadowTint']
      .map((name) => `${name} ${rows[name].value}`)
      .join(', '),
);

// KB-SHOT-SHUTTERMASK1: a frame of sub-frames over the shutter is their mean, so its masks must be too. The same shot
// with 4 sub-frames over a full shutter: the camera moves within the frame, so the box shadows' edges sweep pixels that
// were lit for part of the shutter, and those read between 0 and 255 in the lit and shadow masks. The masks of the
// last sub-frame alone (before the fix) are as hard as one sub-frame's.
const share = (png) => {
  let between = 0;
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i] > 0 && png.data[i] < 255) between++;
  return between;
};
const blurred = parseShot({
  ...source,
  shot: { ...source.shot, id: 'look-masks-shutter', subframes: 4, shutter: 360 },
});
const outBlur = join(root, 'test-results', 'shots', 'look-masks-shutter-check');
rmSync(outBlur, { recursive: true, force: true });
const blurManifest = await shoot(blurred, { out: outBlur, runs: 1, log: () => {} }),
  blurProbe = blurManifest.probes.open;
for (const name of ['lit', 'shadow']) {
  const hard = share(masks[name]),
    soft = share(await decodePNG(readFileSync(join(outBlur, blurProbe.aovs[name]))));
  assert.ok(
    soft >= 1600 && soft >= 3 * hard,
    `the ${name} mask follows the shutter: ${soft} pixels between 0 and 255 with 4 sub-frames, ${hard} with one`,
  );
  console.log(`ok ${name} mask over the shutter: ${soft} partial pixels (one sub-frame: ${hard})`);
}
