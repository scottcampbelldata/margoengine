import { EngineKernel, Camera, PbrMaterial, box } from '/packages/core/dist/index.js';
import { engineRuntime } from '/packages/core/dist/extension.js';
import { PlaneTileMap } from '/packages/tilemap/dist/plane.js';
import { createTileLayer } from '/packages/tilemap/dist/index.js';
const W = 64,
  H = 64,
  canvas = document.createElement('canvas');
document.body.append(canvas);
const instance = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [W, H] }),
  engine = engineRuntime(instance);
engine.scene.background = '#000000';
const camera = instance.camera;
camera.position = [0, 0, 4];
camera.target = [0, 0, 0];
camera.fov = 90;
const errors = [];
engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
const texture = (n, holes = false) => ({
  width: 16,
  height: 16,
  data: Uint8Array.from({ length: 16 * 16 * 4 }, (_, i) =>
    i % 4 === 3 ? (holes && Math.floor(i / 4) % 5 === 0 ? 0 : 255) : (n + Math.floor(i / 4) * 7 + (i % 4) * 23) % 240,
  ),
});
const image = texture(30, true),
  other = texture(100);
const map = {
  width: 1,
  height: 1,
  tileWidth: 16,
  tileHeight: 16,
  tilesets: [{ name: 'a', firstGid: 1, tileWidth: 16, tileHeight: 16, columns: 1, tileCount: 1 }],
  layers: [createTileLayer('tile', 1, 1, Uint32Array.of(1))],
};
// Keep projected boundaries off sample centres. Every pixel is still compared exactly, with no omitted edge pixels.
const ORIGIN_X = -Math.fround(0.9705),
  ORIGIN_Y = Math.fround(0.9711),
  TILT = Math.fround(0.05);
const transform = (z = 0, tilt = 0) => [1 / 8, 0, tilt, 0, 0, -1 / 8, 0, 0, 0, 0, 1, 0, ORIGIN_X, ORIGIN_Y, z, 1];
const draw = (views) => {
  canvas.width = W;
  instance.render({ delta: 0, ...(views ? { views } : {}) });
  const copy = document.createElement('canvas');
  copy.width = W;
  copy.height = H;
  const ctx = copy.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
};
// Independent analytic ray-plane intersection. The camera looks straight down -Z with a 90-degree vertical FOV.
// Map basis X=(1/8,0,tilt), Y=(0,-1/8,0), origin=(ORIGIN_X,ORIGIN_Y,z).
const sample = (px, py, z, tilt, eye, tex, viewport = [0, 0, W, H]) => {
  const [vx, vy, vw, vh] = viewport,
    dx = (((2 * (px - vx + 0.5)) / vw - 1) * vw) / vh,
    dy = 1 - (2 * (py - vy + 0.5)) / vh;
  const slope = tilt * 8,
    t = (eye - z + slope * ORIGIN_X) / (1 + slope * dx),
    wx = t * dx,
    wy = t * dy;
  const u = (wx - ORIGIN_X) * 8,
    v = (ORIGIN_Y - wy) * 8;
  if (t < camera.near || t > camera.far || u < 0 || v < 0 || u >= 16 || v >= 16) return null;
  const at = (Math.floor(v) * 16 + Math.floor(u)) * 4;
  return tex.data[at + 3] ? [...tex.data.subarray(at, at + 3)] : null;
};
const compare = (actual, expected) => {
  let wrong = 0,
    covered = 0,
    first;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const want = expected(x, y) ?? [0, 0, 0],
        at = (y * W + x) * 4,
        got = [...actual.subarray(at, at + 3)];
      if (want.some((v) => v)) covered++;
      if (got.some((v, i) => v !== want[i])) {
        wrong++;
        first ??= { x, y, want, got };
      }
    }
  return { wrong, covered, first };
};
window.check = {
  async run() {
    engine.gpu.pushErrorScope('validation');
    const results = [];
    const plane = PlaneTileMap.attach(instance, { map, atlases: { a: image }, transform: transform(0, TILT) });
    for (const eye of [4, 7]) {
      camera.position = [0, 0, eye];
      results.push({ name: 'perspective-' + eye, ...compare(draw(), (x, y) => sample(x, y, 0, TILT, eye, image)) });
    }
    camera.position = [0, 0, 4];
    plane.transform.set(transform(0, 0));
    const cube = instance
      .createMesh()
      .setGeometry(box(0.6, 0.6, 0.3))
      .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }))
      .setPosition([0, 0, 1]);
    plane.setMap({ ...map, layers: [] });
    const baseline = draw();
    plane.setMap(map);
    let blocked = 0;
    results.push({
      name: 'core-depth',
      ...compare(draw(), (x, y) => {
        const at = (y * W + x) * 4;
        const color = [...baseline.subarray(at, at + 3)];
        if (color.some((v) => v)) {
          blocked++;
          return color;
        }
        return sample(x, y, 0, 0, 4, image);
      }),
      blocked,
    });
    cube.dispose();
    plane.dispose();
    const near = PlaneTileMap.attach(instance, { map, atlases: { a: image }, transform: transform(1), order: 5 });
    const far = PlaneTileMap.attach(instance, { map, atlases: { a: other }, transform: transform(0), order: 10 });
    results.push({
      name: 'cutout-depth',
      ...compare(draw(), (x, y) => sample(x, y, 1, 0, 4, image) ?? sample(x, y, 0, 0, 4, other)),
    });
    near.dispose();
    far.dispose();
    const viewsPlane = PlaneTileMap.attach(instance, { map, atlases: { a: image }, transform: transform() });
    const c1 = new Camera({ position: [0, 0, 4], target: [0, 0, 0], fov: 90 }),
      c2 = new Camera({ position: [0, 0, 7], target: [0, 0, 0], fov: 90 });
    const views = [
      { camera: c1, viewport: [0, 0, 32, 64], pixels: true },
      { camera: c2, viewport: [32, 0, 32, 64], pixels: true },
    ];
    results.push({
      name: 'views',
      ...compare(draw(views), (x, y) =>
        sample(x, y, 0, 0, x < 32 ? 4 : 7, image, x < 32 ? [0, 0, 32, 64] : [32, 0, 32, 64]),
      ),
    });
    viewsPlane.dispose();
    await engine.gpu.queue.onSubmittedWorkDone();
    return { results, validation: (await engine.gpu.popErrorScope())?.message ?? null, errors };
  },
};
window.ready = true;
