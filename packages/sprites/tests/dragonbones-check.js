import { EngineKernel } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { loadDragonBonesJSON, parseDragonBonesJSON } from '/packages/sprites/dist/dragonbones.js';
import { SkeletalLayer } from '/packages/sprites/dist/skeletal.js';
const W = 64,
  H = 32,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { exactSize: [W, H] }),
  engine = engineRuntime(instance),
  device = engine.gpu,
  errors = [];
engine.scene.background = '#000000';
device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const capture = () => {
  instance.render({ delta: 0 });
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, W, H).data;
};
const pixel = (data, x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 3)];
// Four one-texel regions: red, green, blue, white.
const atlas = {
  SubTexture: ['red', 'green', 'blue', 'white'].map((name, x) => ({ name, x, y: 0, width: 1, height: 1 })),
  width: 4,
  height: 1,
};
const image = (name, x, y, size) => ({ name, transform: { x, y, scX: size, scY: size } });
const proof = {
  name: 'proof',
  version: '5.5',
  frameRate: 10,
  armature: [
    {
      name: 'main',
      bone: [
        { name: 'root', transform: { x: 8, y: 8 } },
        { name: 'arm', parent: 'root', transform: { x: 12 } },
        { name: 'tip', parent: 'root', transform: { x: 34, y: 8 } },
      ],
      slot: [
        { name: 'r', parent: 'root' },
        { name: 'g', parent: 'arm' },
        { name: 'n', parent: 'root' },
        { name: 'w', parent: 'root' },
      ],
      skin: [
        {
          slot: [
            { name: 'r', display: [image('red', 0, 0, 8)] },
            { name: 'g', display: [image('green', 0, 0, 6)] },
            { name: 'n', display: [{ type: 'armature', name: 'inner', transform: { x: 48, y: 0 } }] },
            {
              name: 'w',
              display: [
                {
                  type: 'mesh',
                  name: 'white',
                  // A 6 x 6 square in armature space: the left edge on root, the right edge on tip.
                  vertices: [34, 10, 40, 10, 40, 16, 34, 16],
                  uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                  triangles: [0, 1, 2, 2, 3, 0],
                  weights: [1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 1],
                  slotPose: [1, 0, 0, 1, 0, 0],
                  bonePose: [0, 1, 0, 0, 1, 8, 8, 2, 1, 0, 0, 1, 42, 16],
                },
              ],
            },
          ],
        },
      ],
      animation: [
        {
          name: 'move',
          duration: 10,
          playTimes: 1,
          bone: [{ name: 'arm', translateFrame: [{ duration: 10, tweenEasing: 0 }, { y: 12 }] }],
          ffd: [
            {
              name: 'white',
              slot: 'w',
              frame: [{ duration: 10, tweenEasing: 0 }, { vertices: [0, 8, 0, 8, 0, 8, 0, 8] }],
            },
          ],
        },
      ],
    },
    {
      name: 'inner',
      bone: [{ name: 'root' }],
      slot: [{ name: 'b', parent: 'root' }],
      skin: [{ slot: [{ name: 'b', display: [image('blue', 0, 0, 6)] }] }],
      animation: [{ name: 'idle', duration: 0 }],
    },
  ],
};
window.check = async () => {
  device.pushErrorScope('validation');
  const mismatches = [];
  let probes = 0;
  const expect = (data, x, y, rgb, label) => {
    probes++;
    const p = pixel(data, x, y);
    if (p.some((v, i) => Math.abs(v - rgb[i]) > 1)) mismatches.push(`${label} at ${x},${y}: ${p} != ${rgb}`);
  };
  const rig = parseDragonBonesJSON(proof, { atlas }).createArmature('main'),
    texels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]),
    layer = SkeletalLayer.attach(instance, { atlas: { width: 4, height: 1, data: texels } });
  layer.addSkeleton(rig);
  const red = [255, 0, 0],
    green = [0, 255, 0],
    blue = [0, 0, 255],
    white = [255, 255, 255],
    black = [0, 0, 0];
  let frame = capture();
  expect(frame, 8, 8, red, 'image centred on its bone');
  expect(frame, 4, 8, red, 'image left edge');
  expect(frame, 2, 8, black, 'outside the image');
  expect(frame, 20, 8, green, 'child bone image');
  expect(frame, 56, 8, blue, 'nested armature image');
  expect(frame, 37, 13, white, 'weighted mesh at its bind pose');
  rig.pose('move', 1);
  frame = capture();
  expect(frame, 20, 8, black, 'moved image left its setup place');
  expect(frame, 20, 20, green, 'moved image at its key');
  expect(frame, 37, 21, white, 'free-form deformation moved the mesh');
  expect(frame, 37, 11, black, 'mesh left its bind place');
  layer.dispose();
  // A real exported file posed on its own atlas rectangles (solid texels, so coverage is the drawn area).
  const dragon = await loadDragonBonesJSON('/packages/sprites/tests/fixtures/dragonbones/Dragon_ske.json', {
      atlas: '/packages/sprites/tests/fixtures/dragonbones/Dragon_tex.json',
    }),
    page = dragon.atlas,
    real = dragon.createArmature(),
    points = real.drawOrder.flatMap((s) => [...real.getAttachment(s.name).mesh.deform()]),
    xs = points.filter((_, i) => i % 2 === 0),
    ys = points.filter((_, i) => i % 2 === 1),
    zoom = Math.min((W - 4) / (Math.max(...xs) - Math.min(...xs)), (H - 4) / (Math.max(...ys) - Math.min(...ys)));
  const big = SkeletalLayer.attach(instance, {
    atlas: { width: page.width, height: page.height, data: new Uint8Array(page.width * page.height * 4).fill(255) },
    camera: { x: Math.min(...xs) - 2 / zoom, y: Math.min(...ys) - 2 / zoom, zoom },
  });
  big.addSkeleton(real);
  real.pose('walk', 0);
  const before = capture();
  real.pose('walk', 0.4);
  const after = capture();
  real.pose('walk', 0);
  const seek = capture();
  let dragonCoverage = 0,
    dragonChanged = 0,
    seekDifferences = 0;
  for (let i = 0; i < before.length; i += 4) {
    if (before[i]) dragonCoverage++;
    if (before[i] !== after[i]) dragonChanged++;
    if (before.slice(i, i + 4).some((v, k) => v !== seek[i + k])) seekDifferences++;
  }
  big.dispose();
  const validation = await device.popErrorScope();
  instance.dispose();
  return {
    probes,
    mismatches,
    dragonCoverage,
    dragonChanged,
    seekDifferences,
    validation: validation?.message ?? null,
    errors,
  };
};
window.ready = true;
