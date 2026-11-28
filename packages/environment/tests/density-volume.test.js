// DensityVolume (`@margoengine/environment/density-volume`): validation, sparse 8^3 bricks with z fastest (the OpenVDB
// leaf order), Gaussian splats, the trilinear sample the shader mirrors, VDB grids with leaves and tiles, the GPU layout
// (page table, voxel store, info) and VolumetricFog's composition on the recording mock GPU. Real-GPU checks against a
// CPU mirror: tests/density-volume-browser.js (npm run test:density-volume:browser, WebGPU and the WebGL2 layer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';
import { CloudDensityVolume, DensityVolume, DENSITY_BRICK, SeaSprayDensityVolume } from '../dist/density-volume.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
function rig(options = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    removePlugin() {},
  };
  const target = new SceneTarget(
    gpu.device,
    gpu.device.createTexture({ size, format: 'rgba16float', usage }),
    gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
    1,
  );
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    view.begin(i);
    target.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    run(view.c);
  };
  return { fog, frame, record: (work) => gpu.record(work) };
}
const injectCode = (log) => log.find((e) => e[0] === 'module' && /fn inject/.test(e[2].code))[2].code;

test('accepted cloud water places extinction at cell centres and clears the previous frame', () => {
  const grid = { cells: [3, 2, 3], cellSize: 8, origin: [-12, 10, 32] };
  const data = new Float32Array(18);
  const first = 2 + 3 * (1 + 2 * 1);
  data[first] = 0.0005;
  const source = { grid, cloudWater: () => data };
  const effectiveRadius = 12e-6;
  const airDensity = 1.12;
  using volume = new CloudDensityVolume(source, { effectiveRadius, airDensity });
  const dropMass = (4 / 3) * Math.PI * effectiveRadius ** 3 * 1000;
  const dropCrossSection = 2 * Math.PI * effectiveRadius ** 2;
  const ext = (data[first] * airDensity * dropCrossSection) / dropMass;
  assert.equal(volume.voxel(2, 1, 1), data[first]);
  assert(Math.abs(volume.sample([8, 22, 44]) - ext) < 1e-15);
  assert(Math.abs(volume.sample([4, 22, 44]) - ext / 2) < 1e-15);
  assert.equal(volume.sample([8, 14, 44]), 0);
  data.fill(0);
  data[0] = 0.0002;
  volume.update();
  assert.equal(volume.voxel(2, 1, 1), 0);
  assert.equal(volume.voxel(0, 0, 0), data[0]);
  data[first] = -0.0005;
  assert.throws(() => volume.update(), { code: 'state', message: /one finite nonnegative Float32 ratio/ });
  assert.equal(volume.voxel(0, 0, 0), data[0], 'an invalid update keeps the last good frame');
  data[first] = 3e38;
  assert.throws(() => volume.update(), { code: 'state', message: /representable extinction/ });
  assert.equal(volume.voxel(0, 0, 0), data[0], 'overflow keeps the last good frame');
  data.fill(0);
  volume.update();
  assert.equal(volume.brickCount, 0);
  grid.cellSize = 9;
  assert.throws(() => volume.update(), { code: 'state', message: /new grid/ });
  volume.dispose();
  assert.throws(() => volume.update(), { code: 'disposed' });
});

test('cloud density rejects invalid optics, shapes and values with a correction', () => {
  const grid = { cells: [1, 1, 1], cellSize: 8, origin: [0, 0, 0] };
  const source = { grid, cloudWater: () => new Float32Array(1) };
  assert.throws(() => new CloudDensityVolume(source, { effectiveRadius: 0 }), {
    code: 'state',
    message: /positive air density/,
  });
  assert.throws(() => new CloudDensityVolume(source, { airDensity: Number.POSITIVE_INFINITY }), {
    code: 'state',
    message: /positive air density/,
  });
  assert.throws(() => new CloudDensityVolume({ ...source, grid: { ...grid, cells: [1, 0, 1] } }), {
    code: 'state',
    message: /positive cell counts/,
  });
  assert.throws(() => new CloudDensityVolume({ ...source, cloudWater: () => new Float32Array(2) }), {
    code: 'state',
    message: /one finite nonnegative Float32 ratio/,
  });
  assert.throws(() => new CloudDensityVolume({ ...source, grid: { ...grid, origin: [1e40, 0, 0] } }), {
    code: 'state',
    message: /local render origin/,
  });
});

test('sea spray extinction integrates parcel cross-section and rebases its signed source cell', () => {
  const spray = {
    kind: 'sea-spray',
    position: [0, 0, 0],
    mass: 0.000015,
    diameter: 50e-6,
    materialDensity: 1490,
  };
  let parcels = [spray, { ...spray, kind: 'mineral-dust', mass: 10 }];
  const source = { cell: [-2700, 0, 1600], readParticles: () => parcels };
  const h = 0.125;
  using volume = new SeaSprayDensityVolume(source, { voxelSize: h, cellSize: 16 });
  const sigma = 2 * h;
  const dropRadius = spray.diameter / 2;
  const num = spray.mass / (((4 * Math.PI) / 3) * dropRadius ** 3 * spray.materialDensity);
  const area = num * 2 * Math.PI * dropRadius * dropRadius;
  // Independently integrate 4π r² exp(-r²/(2σ²)) by Simpson's rule over the spherical kernel.
  const radial = (r) => 4 * Math.PI * r * r * Math.exp(-0.5 * (r / sigma) ** 2);
  const steps = 600;
  const step = (3 * sigma) / steps;
  let sum = radial(0) + radial(3 * sigma);
  for (let i = 1; i < steps; i++) sum += (i % 2 ? 4 : 2) * radial(i * step);
  const normalized = area / ((sum * step) / 3);
  assert.equal(volume.sample([0, 0, 0]), Math.fround(normalized));
  const radiusOfCell = (Math.sqrt(3) * h) / 2;
  const kernel = (r) => (r > 3 * sigma ? 0 : normalized * Math.exp(-0.5 * (r / sigma) ** 2));
  let apparent = 0;
  let low = 0;
  let high = 0;
  for (let x = -7; x <= 7; x++) {
    for (let y = -7; y <= 7; y++) {
      for (let z = -7; z <= 7; z++) {
        const r = h * Math.hypot(x, y, z);
        low += kernel(r + radiusOfCell);
        high += kernel(Math.max(0, r - radiusOfCell));
        apparent += volume.voxel(x, y, z);
      }
    }
  }
  assert(low * h ** 3 < apparent * h ** 3 && apparent * h ** 3 < high * h ** 3);
  assert(low * h ** 3 < area && area < high * h ** 3);
  volume.update([-2699, -1, 1602]);
  assert.equal(volume.sample([-16, 16, -32]), Math.fround(normalized));
  assert.equal(volume.sample([0, 0, 0]), 0);
  parcels = [{ ...spray, mass: 3e38 }];
  assert.throws(() => volume.update(), { code: 'state', message: /Float32 range/ });
  assert.equal(volume.sample([-16, 16, -32]), Math.fround(normalized), 'an invalid frame keeps previous extinction');
  parcels = [{ ...spray, materialDensity: undefined }];
  assert.throws(() => volume.update(), { code: 'state', message: /positive diameter and density/ });
  assert.equal(volume.sample([-16, 16, -32]), Math.fround(normalized), 'missing density keeps previous extinction');
  parcels = [];
  volume.update();
  assert.equal(volume.brickCount, 0);
  volume.dispose();
  assert.throws(() => volume.update(), { code: 'disposed' });
});

test('validation of options, indices, values and splats', () => {
  assert.equal(DENSITY_BRICK, 8);
  for (const bad of [
    { voxelSize: 0 },
    { voxelSize: Number.NaN },
    { density: -1 },
    { color: [1, 2, 0] },
    { color: [1, 1] },
    { origin: [0, 0] },
    { maxBricks: 0 },
    { maxBricks: 1.5 },
    { matrix: new Float64Array(16) },
    { matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  ])
    assert.throws(() => new DensityVolume(bad), RangeError, JSON.stringify(bad));
  const v = new DensityVolume();
  assert.throws(() => v.set(0.5, 0, 0, 1), RangeError);
  assert.throws(() => v.set(1 << 19, 0, 0, 1), RangeError);
  assert.throws(() => v.set(0, 0, 0, Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => v.splat([0, 0]), RangeError);
  assert.throws(() => v.splat([0, 0, 0], { radius: -1 }), RangeError);
  assert.throws(() => v.splat([0, 0, 0, 1, 1, 1], { weight: [1] }), RangeError);
  assert.throws(() => v.splat([1e9, 0, 0]), RangeError, 'past the index range');
  const small = new DensityVolume({ maxBricks: 2 });
  small.set(0, 0, 0, 1);
  small.set(8, 0, 0, 1);
  assert.throws(() => small.set(16, 0, 0, 1), /full: 2 bricks/);
  const wide = new DensityVolume({ maxPages: 8 });
  wide.set(0, 0, 0, 1);
  wide.set(80, 0, 0, 1);
  assert.throws(() => wide.pack(), /over maxPages 8/);
});

test('bricks: 8^3 voxels, z fastest, negative indices floor; zero writes make no brick', () => {
  const v = new DensityVolume();
  v.set(-1, 0, 0, 0);
  assert.equal(v.brickCount, 0, 'a zero write into nothing stores nothing');
  v.set(-1, 2, 3, 5);
  v.add(-1, 2, 3, 1);
  v.set(7, 7, 7, 2);
  assert.equal(v.brickCount, 2);
  assert.equal(v.voxel(-1, 2, 3), 6);
  assert.equal(v.voxel(7, 7, 7), 2);
  assert.equal(v.voxel(8, 7, 7), 0);
  const { pages, voxels, info } = v.pack(),
    ints = new Int32Array(info.buffer);
  assert.deepEqual([...ints.subarray(12, 15)], [-1, 0, 0], 'page table starts at brick (-1, 0, 0)');
  assert.deepEqual([...ints.subarray(16, 20)], [2, 1, 1, 1], 'two bricks along x, grid not empty');
  assert.deepEqual([...pages], [0, 1]);
  // Voxel (-1, 2, 3) is (7, 2, 3) in brick -1: (7 * 8 + 2) * 8 + 3.
  assert.equal(voxels[(7 * 8 + 2) * 8 + 3], 6);
  assert.equal(voxels[512 + 511], 2);
  v.clear();
  assert.equal(v.brickCount, 0);
  assert.equal(new Int32Array(v.pack().info.buffer)[19], 0, 'empty grid flagged');
});

test('sample: trilinear over voxel centres, times density; the matrix places the grid', () => {
  const v = new DensityVolume({ voxelSize: 2, origin: [10, 0, 0], density: 0.5 });
  v.set(0, 0, 0, 1);
  v.set(1, 0, 0, 3);
  assert.equal(v.sample([10, 0, 0]), 0.5);
  assert.equal(v.sample([12, 0, 0]), 1.5);
  assert.equal(v.sample([11, 0, 0]), 0.5 * 2);
  assert.equal(v.sample([11, 1, 0]), 0.5 * 1, 'half way to an empty row');
  assert.equal(v.sample([-50, 0, 0]), 0);
  const info = v.pack().info;
  assert.deepEqual([...info.subarray(0, 4)], [0.5, 0, 0, -5], 'world to index, row x');
  assert.deepEqual([...info.subarray(20, 24)], [1, 1, 1, 0.5]);
});

test('splat: Gaussian of the given peak and radius, cut at three radii, isotropic in world space', () => {
  const v = new DensityVolume({ voxelSize: 0.25 });
  v.splat([0, 0, 0], { radius: 0.5, weight: 2 });
  assert.equal(v.voxel(0, 0, 0), 2);
  assert.ok(Math.abs(v.voxel(2, 0, 0) - 2 * Math.exp(-0.5)) < 1e-6, 'one radius out');
  assert.ok(Math.abs(v.voxel(0, 0, -6) - Math.fround(2 * Math.exp(-4.5))) < 1e-6, 'three radii out');
  assert.equal(v.voxel(0, 0, 7), 0, 'past three radii');
  // A stretched matrix (x voxels 1 m, others 0.25 m): still a sphere in world space.
  const s = new DensityVolume({ matrix: [1, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 1] });
  s.splat([0, 0, 0], { radius: 0.5 });
  assert.ok(Math.abs(s.voxel(1, 0, 0) - s.voxel(0, 4, 0)) < 1e-6);
  // Splats add up and are deterministic.
  const a = new DensityVolume(),
    b = new DensityVolume();
  for (const g of [a, b]) g.splat([0, 1, 2, 0.3, 1.1, 2.2], { radius: [1, 2], weight: [0.5, 0.25] });
  assert.deepEqual(a.pack().voxels, b.pack().voxels);
});

test('fromVDB: active leaf voxels and active tiles at the grid matrix; level sets and vectors refused', () => {
  const values = new Float32Array(512).fill(7),
    mask = new Uint8Array(64);
  mask[0] = 0b10; // voxel 1 of the leaf (z 1) active only
  const grid = {
    name: 'density',
    components: 1,
    gridClass: 'fog volume',
    matrix: [0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 1, 2, 3, 1],
    leaves: [{ origin: [8, 0, -8], mask, values }],
    tiles: [
      { origin: [0, 16, 0], size: 16, value: 0.5, active: true },
      { origin: [0, 64, 0], size: 8, value: 3, active: false },
    ],
  };
  const v = DensityVolume.fromVDB(grid, { density: 2 });
  assert.equal(v.brickCount, 1 + 8);
  assert.equal(v.voxel(8, 0, -7), 7);
  assert.equal(v.voxel(8, 0, -8), 0, 'inactive voxel reads 0');
  assert.equal(v.voxel(15, 31, 15), 0.5, 'inside the 16^3 tile');
  assert.equal(v.voxel(0, 64, 0), 0, 'inactive tile dropped');
  assert.equal(v.sample([1 + 0.8, 2, 3 - 0.7]), 14);
  const { pages, voxels } = v.pack();
  assert.equal(pages.filter((p) => p >= 0x80000000 && p !== 0xffffffff).length, 8, 'tiles stay one value each');
  assert.equal(voxels.length, 512 + 8);
  // Writing into a tile turns it into a full brick.
  v.set(1, 17, 1, 9);
  assert.equal(v.voxel(0, 16, 0), 0.5);
  assert.equal(v.voxel(1, 17, 1), 9);
  assert.throws(() => DensityVolume.fromVDB({ ...grid, gridClass: 'level set' }), /level set/);
  assert.throws(() => DensityVolume.fromVDB({ ...grid, components: 3 }), RangeError);
});

test('VolumetricFog reads the grid as its medium; uploads only what changed', () => {
  const v = new DensityVolume({ color: [1, 0.5, 0.25] });
  v.splat([0, 2, -5], { radius: 1 });
  const { frame, record } = rig({ density: 0, volumes: v });
  const log = record(() => {
    frame(0);
    frame(1);
  });
  const code = injectCode(log);
  assert.match(code, /var<storage,read> densityVoxels:array<f32>/);
  assert.match(code, /let local=fogMedium\(p\);/);
  const hex = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex'),
    writes = (entries, data) => entries.filter((e) => e[0] === 'writeBuffer' && e[3] === hex(data)).length;
  let packed = v.pack();
  assert.equal(writes(log, packed.pages), 1, 'the page table uploads once while the grid does not change');
  assert.equal(writes(log, packed.voxels), 1, 'the voxels upload once while the grid does not change');
  assert.equal(writes(log, packed.info), 2, 'info (matrix, box, look) uploads every frame');
  v.splat([0, 2, -9], { radius: 1 });
  const again = record(() => frame(2));
  packed = v.pack();
  assert.equal(writes(again, packed.voxels), 1, 'a change uploads again');
  v.dispose();
  assert.throws(() => frame(3), RangeError);
  using _scoped = new DensityVolume();
});
