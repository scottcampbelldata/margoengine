// Real-GPU checks for @margoengine/environment/density-volume: VolumetricFog's integrated froxel volume with a sparse
// density grid as its medium (Gaussian splats, a VDB-style leaf and a constant tile, and no global fog) equals a CPU
// mirror of the froxel pass (the grid's own trilinear `sample`), its 3x3 tent and the per-column integration, slice by
// slice; the grid's albedo colours its fog; a grid rewritten between frames shows the new density on the next frame; an
// empty grid leaves the volume clear. Run on WebGPU and (--compat) on the WebGL2 layer.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VolumetricFog } from '../dist/volumetric.js';
import { DensityVolume } from '../dist/density-volume.js';
import { assert, hardware, invert, readTexture } from './gpu-read.js';

const grid = [32, 32, 64],
  range = 30,
  ambient = [0.8, 0.8, 0.8];

// fogMedium: scattering (rgb) and extinction (a) the grid adds at p.
function medium(volume, p) {
  const s = volume.sample(p);
  return [s * volume.color[0], s * volume.color[1], s * volume.color[2], s];
}
const half = (x) => {
  const f = new Float32Array(1);
  f[0] = x;
  return f[0];
};
// The integrated volume the shaders make for `volumes`: per froxel centre (no jitter: temporal 0) the medium times the
// ambient light, then the 3x3 tent across columns and the analytic per-slice integration of each column.
function mirror(matrix, volumes) {
  const inverse = invert(matrix, new Float64Array(16)),
    w = Math.hypot(matrix[3] - matrix[2], matrix[7] - matrix[6], matrix[11] - matrix[10]),
    plane = [0, 1, 2, 3].map((i) => (matrix[i * 4 + 3] - matrix[i * 4 + 2]) / w),
    unproject = (x, y, z) => {
      const v = [x, y, z, 1],
        o = [0, 1, 2, 3].map((r) => v.reduce((t, c, k) => t + inverse[k * 4 + r] * c, 0));
      return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
    },
    slice = (s) => range * (s / grid[2]) ** 2,
    ray = (x, y) => {
      const ndc = [(x / grid[0]) * 2 - 1, 1 - (y / grid[1]) * 2],
        n = unproject(ndc[0], ndc[1], 1),
        d = unproject(ndc[0], ndc[1], 0.5).map((v, i) => v - n[i]);
      return { n, d, along: d[0] * plane[0] + d[1] * plane[1] + d[2] * plane[2] };
    };
  const [gx, gy, gz] = grid,
    scatter = new Float64Array(gx * gy * gz * 4);
  for (let y = 0; y < gy; y++)
    for (let x = 0; x < gx; x++) {
      const { n, d, along } = ray(x + 0.5, y + 0.5);
      for (let z = 0; z < gz; z++) {
        const t = slice(z + 0.5) / along,
          m = medium(
            volumes,
            n.map((v, i) => v + d[i] * t),
          ),
          o = ((z * gy + y) * gx + x) * 4;
        for (let k = 0; k < 3; k++) scatter[o + k] = half(m[k] * ambient[k]);
        scatter[o + 3] = half(m[3]);
      }
    }
  const at = (x, y, z, k) =>
    scatter[((z * gy + Math.min(gy - 1, Math.max(0, y))) * gx + Math.min(gx - 1, Math.max(0, x))) * 4 + k];
  const out = new Float64Array(gx * gy * gz * 4);
  for (let y = 0; y < gy; y++)
    for (let x = 0; x < gx; x++) {
      const { d, along } = ray(x + 0.5, y + 0.5),
        stretch = Math.hypot(...d) / along;
      const light = [0, 0, 0];
      let optical = 0;
      for (let z = 0; z < gz; z++) {
        const s = [0, 1, 2, 3].map((k) => {
          let sum = 0;
          for (const [dx, dy, wt] of [
            [0, 0, 4],
            [-1, 0, 2],
            [1, 0, 2],
            [0, -1, 2],
            [0, 1, 2],
            [-1, -1, 1],
            [1, -1, 1],
            [-1, 1, 1],
            [1, 1, 1],
          ])
            sum += wt * at(x + dx, y + dy, z, k);
          return sum / 16;
        });
        const step = (slice(z + 1) - slice(z)) * stretch,
          through = Math.exp(-s[3] * step);
        for (let k = 0; k < 3; k++)
          light[k] += Math.exp(-optical) * (s[3] > 0.00001 ? (s[k] - s[k] * through) / s[3] : s[k] * step);
        optical += s[3] * step;
        out.set([...light, optical], ((z * gy + y) * gx + x) * 4);
      }
    }
  return out;
}

window.runTests = async () => {
  const report = { checks: [] };
  const canvas = document.querySelector('#scene');
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 1, 6], target: [0, 1, 0], fov: 60, near: 0.1, far: 100 },
  });
  const runtime = engineRuntime(engine),
    device = runtime.gpu,
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  runtime.lighting.direction.set([0, 1, 0, 0]);
  runtime.lighting.radiance.set([0, 0, 0, 0]);
  // No geometry: a zero (far, reversed-Z) depth target lets the fog cover every pixel to its range.
  const depth = device.createTexture({
    size: [canvas.width, canvas.height],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // A 0.25 m grid offset by half a voxel: three Gaussians of mist, a VDB leaf of a linear ramp (every other voxel
  // active) and a constant 8^3 tile far back.
  const volumes = new DensityVolume({
    voxelSize: 0.25,
    origin: [0.125, 0.125, 0.125],
    density: 0.6,
    color: [1, 0.5, 0.25],
  });
  const writeMist = (dx) => {
    volumes.clear();
    volumes.splat([-1.5 + dx, 1, -1, 1.8 + dx, 1.2, -2, 0 + dx, 0.5, -10], {
      radius: [0.6, 0.9, 2],
      weight: [1, 0.7, 0.4],
    });
  };
  writeMist(0);
  const leaf = new DensityVolume({ voxelSize: 0.25, origin: [0.125, 0.125, 0.125] });
  const values = new Float32Array(512).map((_, i) => (i >> 6) / 7),
    mask = new Uint8Array(64).fill(0x55);
  const fromVDB = DensityVolume.fromVDB({
    components: 1,
    gridClass: 'fog volume',
    matrix: leaf.matrix,
    leaves: [{ origin: [-24, 0, -24], mask, values }],
    tiles: [{ origin: [8, -8, -72], size: 8, value: 0.9, active: true }],
  });
  assert(fromVDB.brickCount === 2, `fromVDB holds ${fromVDB.brickCount} bricks, not 2`);
  for (let x = -24; x < -16; x++)
    for (let y = 0; y < 8; y++) for (let z = -24; z < -16; z++) volumes.add(x, y, z, fromVDB.voxel(x, y, z));
  for (let x = 8; x < 16; x++)
    for (let y = -8; y < 0; y++) for (let z = -72; z < -64; z++) volumes.add(x, y, z, fromVDB.voxel(x, y, z));
  const fog = VolumetricFog.attach(engine, {
    density: 0,
    ambient,
    anisotropy: 0,
    temporal: 0,
    grid,
    range,
    volumes,
    depth: () => depth,
  });
  const compare = async (label) => {
    engine.render();
    const got = await readTexture(device, fog.texture),
      want = mirror(engine.camera.matrix, volumes);
    let worst = 0;
    for (let i = 0; i < want.length; i++)
      worst = Math.max(worst, Math.abs(got.data[i] - want[i]) / (0.002 + 0.01 * Math.abs(want[i])));
    assert(worst <= 1, `${label}: the integrated volume differs from the CPU mirror (${worst} of the bound)`);
    return { got, want, worst };
  };

  // 1. Splats, a leaf and a tile: every froxel's integrated light and optical depth equal the CPU mirror.
  const first = await compare('density grid');
  report.mirrorError = first.worst;
  const last = (data, x, y) => {
    const o = (((grid[2] - 1) * grid[1] + y) * grid[0] + x) * 4;
    return [...data.subarray(o, o + 4)];
  };
  let clear = 0,
    foggy = 0;
  for (let y = 0; y < grid[1]; y++)
    for (let x = 0; x < grid[0]; x++) {
      const v = last(first.got.data, x, y);
      if (v[3] === 0) clear++;
      else foggy++;
    }
  assert(clear > 20 && foggy > 50, `columns: ${clear} clear, ${foggy} foggy`);
  report.columns = { clear, foggy };
  report.checks.push('splats, a VDB leaf and a tile: every froxel equals the CPU mirror (light and optical depth)');

  // 2. The grid's albedo colours its fog: the column through the near Gaussian is orange.
  const column = (p, data = first.got.data) => {
    const m = engine.camera.matrix,
      w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
      x = ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) / 2,
      y = (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) / 2;
    return last(data, Math.floor(x * grid[0]), Math.floor(y * grid[1]));
  };
  const orange = column([1.8, 1.2, -2]);
  report.mistColumn = orange;
  assert(orange[3] > 0.1, `the mist column is clear: ${orange}`);
  assert(orange[0] > 1.8 * orange[1] && orange[1] > 1.8 * orange[2], `mist column is not orange: ${orange}`);
  report.checks.push("the grid's fog takes its albedo");

  // 3. Rewritten between frames: the mist moved 6 m left shows there on the next frame (mirror again).
  writeMist(-6);
  const moved = await compare('moved mist');
  const after = column([1.8, 1.2, -2], moved.got.data);
  assert(after[3] < 0.5 * orange[3], `the mist's old place stays foggy: ${orange[3]} then ${after[3]}`);
  report.movedMirrorError = moved.worst;
  report.checks.push('a rewritten grid shows its new density on the next frame');

  // 4. Emptied: every column is clear.
  volumes.clear();
  engine.render();
  const empty = await readTexture(device, fog.texture);
  assert(
    empty.data.every((v) => v === 0),
    'with an empty grid and no global fog the volume is empty',
  );
  report.checks.push('with an empty grid the fog volume is empty');

  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware({ info: device.adapterInfo });
  fog.dispose();
  volumes.dispose();
  depth.destroy();
  engine.dispose();
  return report;
};
