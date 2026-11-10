import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import {
  Skeleton2D,
  SkeletalLayer,
  SkinnedMesh,
  gridMesh,
  poseSkeleton,
  solveTwoBoneIK,
} from '/packages/sprites/dist/skeletal.js';
const canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [64, 32] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const data = new Uint8Array(12 * 4 * 4);
for (let y = 0; y < 4; y++)
  for (let x = 0; x < 12; x++)
    data.set(x < 4 ? [255, 0, 0, 255] : x < 8 ? [0, 0, 255, 255] : [0, 255, 0, 255], (y * 12 + x) * 4);
const s = new Skeleton2D([
  { name: 'root', x: 20, y: 12, length: 5 },
  { name: 'tip', parent: 'root', x: 5, length: 3 },
]);
const mesh = (x) =>
  new SkinnedMesh({
    skeleton: s,
    ...gridMesh([x, 0, 4, 4], 1, 1, { x: 24, y: 16 }),
    joints: new Array(16).fill(0),
    weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  });
const red = mesh(0),
  blue = mesh(4),
  green = mesh(8);
s.addSlot({ name: 'a', bone: 'root', attachments: { red, blue }, attachment: 'red' });
s.addSlot({ name: 'b', bone: 'root', attachments: { green }, attachment: 'green' });
const layer = SkeletalLayer.attach(instance, { atlas: { width: 12, height: 4, data } });
layer.addSkeleton(s);
const frame = (x = 26, y = 18) => {
  instance.render({ delta: 0 });
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
};
window.check = async () => {
  engine.gpu.pushErrorScope('validation');
  const pixels = [];
  pixels.push(frame());
  const clip = {
    duration: 2,
    bones: {},
    slots: {
      a: [
        { time: 0.5, attachment: 'blue' },
        { time: 1, attachment: null },
      ],
    },
    drawOrder: [{ time: 0.5, slots: ['b', 'a'] }],
  };
  for (const time of [0.75, 1.5, 0]) {
    poseSkeleton(s, clip, time, false);
    pixels.push(frame());
  }
  poseSkeleton(s, clip, 0.75, false);
  const ik = solveTwoBoneIK(s, 'root', 'tip', [24, 16], { tolerance: 1e-8 });
  const positions = blue.deform();
  let cx = 0,
    cy = 0;
  for (let i = 0; i < 4; i++) {
    cx += positions[2 * i] / 4;
    cy += positions[2 * i + 1] / 4;
  }
  pixels.push(frame(Math.floor(cx), Math.floor(cy)));
  const validation = await engine.gpu.popErrorScope();
  layer.dispose();
  instance.dispose();
  return { pixels, ik, validation: validation?.message ?? null, errors };
};
window.ready = true;
