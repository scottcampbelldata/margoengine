// Node benchmark: Raycaster against gltf-pro models. A CAD-like assembly of 1,000 distinct ~1k-triangle parts (1M triangles)
// and one 1M-triangle primitive: per-primitive BVH build cost and ray cost through `intersectObjects`.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GLTFAsset, PBRModel } from '../../gltf-pro/dist/index.js';
import { Raycaster, getPrimitiveBVH } from '../dist/index.js';
import { rng } from '../tests/reference.js';

const root = fileURLToPath(new URL('..', import.meta.url)),
  random = rng(7);
/** gltf-pro prepared geometry over a (u, v) grid: 20 floats per vertex, position + normal from `surface`. */
function grid(columns, rows, surface) {
  const vertices = new Float32Array((columns + 1) * (rows + 1) * 20),
    indices = new Uint32Array(columns * rows * 6),
    p = [0, 0, 0],
    n = [0, 0, 0];
  for (let j = 0, o = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++, o += 20) {
      surface(i / columns, j / rows, p, n);
      const l = Math.hypot(...n);
      vertices.set(
        [p[0], p[1], p[2], 1, n[0] / l, n[1] / l, n[2] / l, 0, 0, 0, 0, 0, i / columns, j / rows, 0, 0, 1, 1, 1, 1],
        o,
      );
    }
  for (let j = 0, k = 0; j < rows; j++)
    for (let i = 0; i < columns; i++, k += 6) {
      const a = j * (columns + 1) + i,
        b = a + columns + 1;
      indices.set([a, a + 1, b, a + 1, b + 1, b], k);
    }
  return { vertices, indices };
}
const part = () => {
  const r = 0.2 + random() * 0.2,
    h = 0.3 + random() * 0.5,
    lobes = 3 + Math.floor(random() * 5);
  return grid(24, 20, (u, v, p, n) => {
    const a = u * Math.PI * 2,
      radius = r * (1 + 0.1 * Math.cos(a * lobes));
    p[0] = Math.cos(a) * radius;
    p[1] = (v - 0.5) * h;
    p[2] = Math.sin(a) * radius;
    n[0] = Math.cos(a);
    n[1] = 0;
    n[2] = Math.sin(a);
  });
};
const terrain = (size) =>
  grid(size, size, (u, v, p, n) => {
    p[0] = u * 2 - 1;
    p[2] = v * 2 - 1;
    p[1] = 0.1 * Math.sin(u * 26) * Math.cos(v * 22);
    n[0] = 0;
    n[1] = 1;
    n[2] = 0;
  });
const time = (run) => {
  const start = performance.now();
  const value = run();
  return [performance.now() - start, value];
};

const engine = new Engine(
  { width: 1280, height: 720, clientWidth: 1280, clientHeight: 720 },
  await TransformStore.create(4096),
  { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
);
const parts = Array.from({ length: 1000 }, part),
  report = { node: process.version, models: [] };
const assemblyDoc = {
  asset: { version: '2.0' },
  meshes: parts.map(() => ({ primitives: [{}] })),
  nodes: parts.map((_, i) => ({
    mesh: i,
    translation: [(i % 10) - 4.5, Math.floor(i / 100) - 4.5, (Math.floor(i / 10) % 10) - 4.5],
    rotation: [Math.sin(i), 0, 0, Math.cos(i)].map((v, _, q) => v / Math.hypot(...q)),
  })),
};
const [assemblyMs, assembly] = time(
  () =>
    new PBRModel(
      engine,
      new GLTFAsset(assemblyDoc, []),
      [],
      parts.map((p) => [p]),
    ),
);
const big = terrain(707),
  [bigMs, terrainModel] = time(
    () =>
      new PBRModel(
        engine,
        new GLTFAsset(
          {
            asset: { version: '2.0' },
            meshes: [{ primitives: [{}] }],
            nodes: [{ mesh: 0, translation: [20, 0, 0], scale: [5, 5, 5] }],
          },
          [],
        ),
        [],
        [[big]],
      ),
  );
for (const [name, model, loadMs, target, spread] of [
  ['assembly: 1,000 parts', assembly, assemblyMs, [0, 0, 0], 5],
  ['one 1M-triangle primitive', terrainModel, bigMs, [20, 0, 0], 5],
]) {
  const triangles = model.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
    rays = Array.from({ length: 20000 }, () => {
      const origin = [target[0] + (random() * 2 - 1) * 12, target[1] + 8 + random() * 4, target[2] + 12],
        aim = [
          target[0] + (random() * 2 - 1) * spread,
          target[1] + (random() * 2 - 1) * spread,
          target[2] + (random() * 2 - 1) * spread,
        ];
      return [origin, aim.map((v, k) => v - origin[k])];
    });
  const raycaster = new Raycaster(),
    objects = [model];
  const [buildMs] = time(() => {
    for (const p of model.primitives) getPrimitiveBVH(p);
  });
  for (let i = 0; i < 500; i++) raycaster.set(...rays[i]).intersectObjects(engine, objects); // JIT warm up
  raycaster.firstHitOnly = true;
  let hits = 0;
  const [firstMs] = time(() => {
    for (const ray of rays) hits += raycaster.set(...ray).intersectObjects(engine, objects, { refresh: false }).length;
  });
  raycaster.firstHitOnly = false;
  let all = 0;
  const [allMs] = time(() => {
    for (const ray of rays) all += raycaster.set(...ray).intersectObjects(engine, objects, { refresh: false }).length;
  });
  const bvhBytes = model.primitives.reduce((n, p) => {
    const b = getPrimitiveBVH(p);
    return n + b.nodes.byteLength + b.index.byteLength + b.triangles.byteLength;
  }, 0);
  const entry = {
    model: name,
    primitives: model.primitives.length,
    triangles,
    modelConstructMs: +loadMs.toFixed(1),
    bvhBuildTotalMs: +buildMs.toFixed(1),
    bvhBuildPerPrimitiveMs: +(buildMs / model.primitives.length).toFixed(3),
    bvhMegabytes: +(bvhBytes / 2 ** 20).toFixed(1),
    firstHitMicroseconds: +((firstMs / rays.length) * 1000).toFixed(2),
    allHitsMicroseconds: +((allMs / rays.length) * 1000).toFixed(2),
    hitRate: +(hits / rays.length).toFixed(3),
    hitsPerRay: +(all / rays.length).toFixed(2),
  };
  report.models.push(entry);
  console.log(entry);
}
await mkdir(resolve(root, 'test-results'), { recursive: true });
await writeFile(resolve(root, 'test-results/bench-models.json'), JSON.stringify(report, null, 2));
