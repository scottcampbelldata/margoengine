// Real-GPU proof in Node that graphics can be laid over other pictures (from the repository root after building):
//   node scripts/run-with-timeout.mjs -- node packages/headless/tests/transparent-gpu.mjs
// A transparent headless stage draws a box through Tonemap and a PostStack, with ui panels over it, and each chain is
// compared with the same scene drawn opaque on black. Before the fix Tonemap's curve took the premultiplied colour of
// partly covered pixels, so a silhouette was up to 25 of 255 brighter than its alpha allows.
// MARGO_NODE_GPU=<adapter name> picks an adapter.
import assert from 'node:assert/strict';
import { Camera, PbrMaterial, box } from '@margoengine/core';
import { readPixels } from '@margoengine/headless';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { Bloom, FXAA, PostStack, SMAA, SSAO } from '@margoengine/post';
import { Tonemap } from '@margoengine/tonemap';
import { Panel, Ui, UiRenderer } from '@margoengine/ui';
import { create, globals } from 'webgpu';

const gpu = create(process.env.MARGO_NODE_GPU ? [`adapter=${process.env.MARGO_NODE_GPU}`] : []);
const WIDTH = 128,
  HEIGHT = 96;
const camera = new Camera({ position: [0, 0, 3.2], target: [0, 0, 0] });

async function render(transparent, effects) {
  const errors = [];
  using stage = await createHeadlessStage({
    width: WIDTH,
    height: HEIGHT,
    gpu,
    globals,
    transparent,
    onError: (error) => errors.push(error),
  });
  const { engine } = stage;
  if (!transparent) engine.scene.background = '#000000';
  // Turned about the view axis, so its one visible face has slanted edges.
  const mesh = engine.createMesh().setGeometry(box(1.2, 1.2, 1.2));
  mesh.setMaterial(new PbrMaterial({ color: '#e0a050', roughness: 1 }));
  mesh.setQuaternion([0, 0, Math.sin(Math.PI / 10), Math.cos(Math.PI / 10)]);
  effects(engine);
  const ui = new Ui();
  ui.add(new Panel({ background: '#20c040', width: 24, height: 16, anchor: 'top-left' }));
  ui.add(new Panel({ background: '#2040c080', width: 24, height: 16, anchor: 'top-right' }));
  UiRenderer.attach(engine, ui);
  engine.render({ camera });
  const frame = await readPixels(engine);
  assert.deepEqual(errors, []);
  return frame.data;
}

const chains = {
  'no effects': () => {},
  Tonemap: (engine) => Tonemap.attach(engine),
  'PostStack of Tonemap and FXAA': (engine) => PostStack.attach(engine, [new Tonemap(), new FXAA()]),
  'PostStack of Tonemap and SMAA': (engine) => PostStack.attach(engine, [new Tonemap(), new SMAA()]),
  'PostStack of SSAO and Tonemap': (engine) => PostStack.attach(engine, [new SSAO(), new Tonemap()]),
  'Tonemap with grain, vignette and dither': (engine) =>
    Tonemap.attach(engine, { grain: 0.5, vignette: 0.4, dither: true }),
};

const pixel = (data, x, y) => [...data.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4)];
const underPanel = (x, y) => y < 17 && (x < 25 || x >= WIDTH - 25);

for (const [name, effects] of Object.entries(chains)) {
  const clear = await render(true, effects),
    solid = await render(false, effects);
  let empty = 0,
    full = 0,
    edge = 0,
    unchanged = 0,
    rim = 0;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      if (underPanel(x, y)) continue;
      const [r, g, b, a] = pixel(clear, x, y);
      if (a === 0) {
        empty++;
        assert.deepEqual([r, g, b], [0, 0, 0], `${name}: an empty pixel at ${x},${y} holds no colour`);
      } else if (a === 255) {
        full++;
        const other = pixel(solid, x, y);
        unchanged = Math.max(unchanged, ...[r, g, b].map((value, i) => Math.abs(value - other[i])));
      } else {
        // A partly covered pixel has the colour of the face beside it, at its coverage.
        let nearest = Infinity;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const other = pixel(clear, x + dx, y + dy);
            if (other[3] !== 255) continue;
            nearest = Math.min(
              nearest,
              Math.max(...[r, g, b].map((value, i) => (Math.abs(value - other[i]) * a) / 255)),
            );
          }
        if (nearest === Infinity) continue;
        edge++;
        rim = Math.max(rim, nearest);
      }
    }
  assert.ok(empty > 5000 && full > 1000 && edge > 40, `${name}: ${empty} empty, ${full} full, ${edge} edge pixels`);
  // Grain moves neighbouring pixels apart by design, so that chain proves the empty and covered pixels only.
  if (!name.includes('grain'))
    assert.ok(rim <= 3, `${name}: an edge pixel is ${rim.toFixed(1)} of 255 from the face colour`);
  // SMAA finds edges in alpha too, so it blends a few more silhouette pixels than over black.
  if (!name.includes('SMAA')) assert.ok(unchanged <= 1, `${name}: a covered pixel changed by ${unchanged}`);
  assert.deepEqual(pixel(clear, 4, 4).slice(3), [255], `${name}: the opaque panel is opaque`);
  assert.deepEqual(pixel(clear, 4, 4), pixel(solid, 4, 4), `${name}: the opaque panel keeps its colour`);
  const half = pixel(clear, WIDTH - 4, 4);
  assert.ok(
    [0x20, 0x40, 0xc0, 0x80].every((value, i) => Math.abs(half[i] - value) <= 2),
    `${name}: the half-clear panel reads as straight alpha, got ${half}`,
  );
  console.log(
    `ok ${name}: ${empty} empty, ${full} covered (changed by ${unchanged}), ${edge} edge pixels within ${rim.toFixed(1)}`,
  );
}

// A Bloom halo has light and no coverage: it keeps that light as straight alpha, so over black it is the opaque render.
{
  const glow = (engine) => PostStack.attach(engine, [new Bloom({ threshold: 0, strength: 0.5 }), new Tonemap()]);
  const covered = await render(true, chains.Tonemap),
    clear = await render(true, glow),
    solid = await render(false, glow);
  let halo = 0,
    worst = 0;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      if (underPanel(x, y) || pixel(covered, x, y)[3] !== 0) continue;
      const [r, g, b, a] = pixel(clear, x, y),
        other = pixel(solid, x, y);
      if (Math.max(...other.slice(0, 3)) > 8) halo++;
      worst = Math.max(worst, ...[r, g, b].map((value, i) => Math.abs((value * a) / 255 - other[i])));
    }
  assert.ok(halo > 500, `Bloom: ${halo} halo pixels`);
  assert.ok(worst <= 3, `Bloom: a halo pixel over black is ${worst.toFixed(1)} of 255 from the opaque render`);
  console.log(`ok PostStack of Bloom and Tonemap: ${halo} halo pixels within ${worst.toFixed(1)} of the opaque render`);
}
