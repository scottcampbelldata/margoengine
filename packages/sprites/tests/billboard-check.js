// The page of billboard-check.mjs: billboards drawn in a 3D scene under exactSize, measured on the read-back canvas.
import { EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { BillboardLayer } from '/packages/sprites/dist/billboard.js';

const SIZE = 64;
// 4 x 4 atlas in quadrants: red, green, blue, and a transparent one.
const data = new Uint8Array(4 * 4 * 4);
for (let y = 0; y < 4; y++)
  for (let x = 0; x < 4; x++)
    data.set(
      x < 2 && y < 2 ? [255, 0, 0, 255] : y < 2 ? [0, 255, 0, 255] : x < 2 ? [0, 0, 255, 255] : [0, 0, 0, 0],
      (y * 4 + x) * 4,
    );
const atlas = { width: 4, height: 4, data };
const RED = [0, 0, 2, 2],
  GREEN = [2, 0, 2, 2],
  BLUE = [0, 2, 2, 2],
  CLEAR = [2, 2, 2, 2];

const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:256px;height:256px;image-rendering:pixelated';
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [SIZE, SIZE] }),
  engine = engineRuntime(instance),
  errors = [];
engine.scene.background = '#000000';
engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
const camera = engine.camera;
camera.fov = 90;
const look = (position) => {
  camera.position = position;
  camera.target = [0, 0, 0];
};

const frame = () => {
  canvas.width = SIZE;
  instance.render({ delta: 1 / 60 });
  const copy = document.createElement('canvas');
  copy.width = copy.height = SIZE;
  const context = copy.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  return context.getImageData(0, 0, SIZE, SIZE).data;
};
/** Bounding box and count of pixels where `match(r, g, b)` holds. */
const extent = (image, match) => {
  let minX = SIZE,
    minY = SIZE,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (!match(image[i], image[i + 1], image[i + 2])) continue;
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { count, minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};
const red = (r, g, b) => r > 200 && g < 50 && b < 50,
  green = (r, g, b) => g > 100 && r < 50 && b < 50,
  blue = (r, g, b) => b > 200 && r < 50 && g < 50,
  lit = (r, g, b) => r + g + b > 0;
const using = (options, run) => {
  const layer = BillboardLayer.attach(instance, { atlas, ...options });
  try {
    return run(layer);
  } finally {
    layer.dispose();
  }
};

window.check = {
  size: () => [canvas.width, canvas.height],
  async run() {
    const out = {};
    engine.gpu.pushErrorScope('validation');
    // fov 90 at distance 5: the view is 10 units tall, 6.4 px per unit at the origin.
    out.facing = using({}, (layer) => {
      layer.add({ width: 2, height: 2, rect: RED });
      const seen = {};
      for (const [name, eye] of Object.entries({ front: [0, 0, 5], side: [5, 0, 0], above: [3, 4, 0] })) {
        look(eye);
        seen[name] = extent(frame(), red);
      }
      look([0, 0, 10]);
      seen.far = extent(frame(), red);
      return seen;
    });
    out.pixels = using({ sizeAttenuation: false }, (layer) => {
      layer.add({ width: 8, height: 8, rect: GREEN });
      look([0, 0, 5]);
      const near = extent(frame(), green);
      look([0, 0, 10]);
      return { near, far: extent(frame(), green) };
    });
    out.pivot = using({}, (layer) => {
      layer.add({ width: 2, height: 2, pivotY: 1, rect: RED });
      look([0, 0, 5]);
      return extent(frame(), red);
    });
    out.turn = using({}, (layer) => {
      layer.add({ width: 4, height: 2, rotation: Math.PI / 2, rect: BLUE });
      look([0, 0, 5]);
      return extent(frame(), blue);
    });
    out.cutout = using({}, (layer) => {
      // Near red added first, a larger far green after: depth writes keep red on top.
      layer.add({ z: 1, width: 2, height: 2, rect: RED });
      layer.add({ z: -1, width: 6, height: 6, rect: GREEN });
      layer.add({ x: 3, width: 2, height: 2, rect: CLEAR });
      look([0, 0, 5]);
      const image = frame(),
        r = extent(image, red),
        g = extent(image, green);
      return { red: r, green: g, clearDrew: extent(image, lit).count - r.count - g.count };
    });
    out.blend = using({ transparent: true }, (layer) => {
      // Added near first: back-to-front sorting still draws the far one first, so the half-transparent near one tints it.
      layer.add({ z: 1, width: 2, height: 2, rect: RED, alpha: 0.5 });
      layer.add({ z: -1, width: 2, height: 2, rect: GREEN });
      look([0, 0, 5]);
      const image = frame(),
        i = (32 * SIZE + 32) * 4;
      return [image[i], image[i + 1], image[i + 2]];
    });
    out.lockY = {};
    for (const lockY of [false, true])
      out.lockY[lockY] = using({ lockY }, (layer) => {
        layer.add({ width: 2, height: 2, rect: RED });
        look([0, 5, 5]);
        return extent(frame(), red);
      });
    const mesh = instance
      .createMesh()
      .setGeometry(box(3, 3, 0.5))
      .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
    out.scene = {};
    for (const transparent of [false, true])
      out.scene[transparent] = using({ transparent }, (layer) => {
        look([0, 0, 5]);
        const board = layer.add({ z: -2, width: 2, height: 2, rect: GREEN });
        const behind = extent(frame(), green).count;
        board.z = 2;
        return { behind, inFront: extent(frame(), green).count };
      });
    mesh.dispose();
    out.validation = (await engine.gpu.popErrorScope())?.message ?? null;
    // An engine without exactSize draws multisampled: the pipelines build for its sample count.
    const other = document.createElement('canvas');
    other.width = other.height = 32;
    document.body.append(other);
    const msaa = await EngineKernel.create(other, { backend: 'webgpu' }),
      runtime = engineRuntime(msaa);
    runtime.gpu.pushErrorScope('validation');
    for (const transparent of [false, true]) {
      const layer = BillboardLayer.attach(msaa, { atlas, transparent });
      layer.add({ width: 2, height: 2 });
      msaa.render({ delta: 1 / 60 });
      layer.dispose();
    }
    out.msaa = { validation: (await runtime.gpu.popErrorScope())?.message ?? null };
    msaa.dispose();
    out.errors = errors;
    return out;
  },
};
window.ready = true;
