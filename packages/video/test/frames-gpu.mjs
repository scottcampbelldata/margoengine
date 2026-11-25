// Real-GPU proof in Node that recorded frames show on a mesh (from the repository root after building):
//   node scripts/run-with-timeout.mjs -- node packages/video/test/frames-gpu.mjs
// A headless stage draws a quad that fills the picture, one texel to a pixel, with FrameVideo's texture as its map. Frame k of a
// test clip reads back within 1 level of its source bytes, a seek back gives the same bytes as the first visit, a
// quarter-size draw reads the mip chain's area average, and renderFrames steps the clip by film time.
// MARGO_NODE_GPU=<adapter name> picks an adapter.
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { readPixels } from '@margoengine/headless';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { renderFrames } from '@margoengine/headless/video';
import { UnlitMaterial, createMesh } from '@margoengine/materials';
import { FrameVideo } from '@margoengine/video/frames';
import { create, globals } from 'webgpu';

const gpu = create(process.env.MARGO_NODE_GPU ? [`adapter=${process.env.MARGO_NODE_GPU}`] : []);
const WIDTH = 64,
  HEIGHT = 48,
  DISTANCE = 4,
  FOV = 40;

/** Frame `k`: a ramp in each channel, different in every frame, with a red top-left block that fixes the orientation. */
function source(k) {
  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++)
      data.set(
        x < 8 && y < 8 ? [255, 0, 0, 255] : [(x * 4 + k * 9) % 256, (y * 5 + k * 17) % 256, (k * 40 + 3) % 256, 255],
        (y * WIDTH + x) * 4,
      );
  return data;
}

const half = DISTANCE * Math.tan((FOV * Math.PI) / 360),
  wide = (half * WIDTH) / HEIGHT;
const quad = {
  positions: [-wide, -half, 0, wide, -half, 0, wide, half, 0, -wide, half, 0],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
};
const camera = new Camera({ position: [0, 0, DISTANCE], target: [0, 0, 0], fov: FOV });

const errors = [];
using stage = await createHeadlessStage({
  width: WIDTH,
  height: HEIGHT,
  gpu,
  globals,
  onError: (error) => errors.push(error),
});
const { engine } = stage;
engine.scene.background = '#000000';
using clip = new FrameVideo({ width: WIDTH, height: HEIGHT, fps: 30, frames: 12, read: async (k) => source(k) });
const material = new UnlitMaterial({ map: clip.texture }),
  mesh = createMesh(engine, quad, material);

async function draw(time) {
  await clip.seek(time);
  engine.render({ camera, delta: 0 });
  return (await readPixels(engine)).data;
}
const worst = (actual, expected) => {
  let most = 0;
  for (let i = 0; i < expected.length; i++) most = Math.max(most, Math.abs(actual[i] - expected[i]));
  return most;
};

const first = Uint8Array.from(await draw(7 / 30));
assert.equal(clip.frame, 7);
assert.ok(worst(first, source(7)) <= 1, `frame 7 reads back within 1 level, worst ${worst(first, source(7))}`);
for (const k of [0, 11, 3]) {
  const pixels = await draw(k / 30);
  assert.ok(worst(pixels, source(k)) <= 1, `frame ${k} within 1 level, worst ${worst(pixels, source(k))}`);
}
assert.deepEqual(Uint8Array.from(await draw(7 / 30)), first, 'a seek back draws the same bytes');

// renderFrames steps the clip by the sequence's own time.
let count = 0;
for await (const frame of renderFrames(engine, { frames: 4, camera, update: ({ time }) => clip.seek(time) })) {
  assert.ok(worst(frame.data, source(frame.index)) <= 1, `sequence frame ${frame.index}`);
  count++;
}
assert.equal(count, 4);

// A quad a quarter as wide: each pixel covers 4 x 4 texels, so it reads mip level 2, the area average in linear light.
mesh.dispose();
using checker = new FrameVideo({
  width: WIDTH,
  height: HEIGHT,
  fps: 1,
  frames: 1,
  read: () => {
    const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(255);
    for (let y = 0; y < HEIGHT; y++)
      for (let x = 0; x < WIDTH; x++) if ((x + y) & 1) data.set([0, 0, 0], (y * WIDTH + x) * 4);
    return data;
  },
});
await checker.seek(0);
const screen = new UnlitMaterial({ map: checker.texture }),
  far = createMesh(engine, { ...quad, positions: quad.positions.map((v) => v / 4) }, screen);
engine.render({ camera, delta: 0 });
const small = (await readPixels(engine)).data,
  centre = [...small.subarray(((HEIGHT / 2) * WIDTH + WIDTH / 2) * 4).subarray(0, 3)];
// Half black and half white in linear light is 188 in sRGB (IEC 61966-2-1).
for (const channel of centre) assert.ok(Math.abs(channel - 188) <= 2, `mip average ${centre}`);

assert.deepEqual(errors, []);
far.dispose();
screen.dispose();
material.dispose();
console.log(`video frames in Node: 4 seeks and a 4-frame sequence within 1 level, mip average ${centre[0]} (188).`);
