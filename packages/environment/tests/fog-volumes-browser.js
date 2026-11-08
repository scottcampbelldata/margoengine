// Real-GPU checks for @margoengine/environment/fog-volumes: VolumetricFog's integrated froxel volume with a box, a
// sphere and a noisy box of local fog (and no global fog) equals a CPU mirror of the froxel pass, its 3x3 tent and the
// per-column integration, slice by slice; moving a volume moves its fog the next frame; colours follow each volume's
// albedo; columns that miss every volume stay clear.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { VolumetricFog } from '../dist/volumetric.js';
import { FogVolumes } from '../dist/fog-volumes.js';
import { assert, hardware, invert, readTexture } from './gpu-read.js';

const grid = [32, 32, 64],
  range = 30,
  ambient = [0.8, 0.8, 0.8];

// The shader's value noise (volumetric.ts: PCG hash per lattice corner, cubic fade), in u32 arithmetic.
const pcg = (v) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0,
    w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
};
const corner = (x, y, z) => (pcg((x >>> 0) + pcg((y >>> 0) + pcg(z >>> 0))) >>> 8) * 5.9604645e-8;
function noise(p) {
  const b = p.map(Math.floor),
    t = p.map((v, i) => v - b[i]),
    w = t.map((v) => v * v * (3 - 2 * v)),
    c = (i, j, k) => corner(b[0] + i, b[1] + j, b[2] + k),
    mix = (a, b2, f) => a + (b2 - a) * f,
    lower = mix(mix(c(0, 0, 0), c(1, 0, 0), w[0]), mix(c(0, 1, 0), c(1, 1, 0), w[0]), w[1]),
    upper = mix(mix(c(0, 0, 1), c(1, 0, 1), w[0]), mix(c(0, 1, 1), c(1, 1, 1), w[0]), w[1]);
  return mix(lower, upper, w[2]);
}
const smooth = (e, x) => {
  const t = Math.min(1, Math.max(0, x / e));
  return t * t * (3 - 2 * t);
};
// fogMedium: scattering (rgb) and extinction (a) the volumes add at p (no wind: the fog's offset stays 0).
function medium(volumes, p) {
  const m = [0, 0, 0, 0];
  for (const f of volumes) {
    let s;
    if (f.shape === 'sphere') s = Math.hypot(...p.map((v, i) => v - f.center[i])) - f.radius;
    else s = Math.max(...p.map((v, i) => Math.abs(v - (f.min[i] + f.max[i]) / 2) - (f.max[i] - f.min[i]) / 2));
    if (s >= 0) continue;
    let sigma = (f.density ?? 0.1) * ((f.edge ?? 0) > 0 ? smooth(f.edge, -s) : 1);
    if (f.noise) {
      const x = p.map((v) => v / (f.noiseScale ?? 2));
      sigma *= Math.max(
        0,
        1 + f.noise * (1.3333 * noise(x) + 0.6667 * noise(x.map((v, i) => v * 2.11 + [23.7, -11.3, 5.9][i])) - 1),
      );
    }
    const color = f.color ?? [1, 1, 1];
    for (let k = 0; k < 3; k++) m[k] += sigma * color[k];
    m[3] += sigma;
  }
  return m;
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
  const list = [
    { shape: 'box', min: [-3, -1, -4], max: [-0.5, 3, 1], density: 0.4, color: [1, 0.5, 0.25], edge: 0.5 },
    { shape: 'sphere', center: [1.8, 1.2, -2], radius: 1.5, density: 0.8, color: [0.2, 0.6, 1], edge: 0.4 },
    { shape: 'box', min: [-4, -2, -14], max: [4, 0, -8], density: 0.3, noise: 1, noiseScale: 1.5, edge: 0.3 },
  ];
  const volumes = new FogVolumes(list);
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
      want = mirror(engine.camera.matrix, volumes.volumes);
    let worst = 0;
    for (let i = 0; i < want.length; i++)
      worst = Math.max(worst, Math.abs(got.data[i] - want[i]) / (0.002 + 0.01 * Math.abs(want[i])));
    assert(worst <= 1, `${label}: the integrated volume differs from the CPU mirror (${worst} of the bound)`);
    return { got, want, worst };
  };

  // 1. Box, sphere and noisy box: every froxel's integrated light and optical depth equal the CPU mirror.
  const first = await compare('three volumes');
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
  assert(clear > 50 && foggy > 200, `columns: ${clear} clear, ${foggy} foggy`);
  report.columns = { clear, foggy };
  report.checks.push('box, sphere and noisy box: every froxel equals the CPU mirror (light and optical depth)');

  // 2. Colours follow each volume's albedo: a column through the box alone is orange, through the sphere alone blue.
  const column = (p, data = first.got.data) => {
    const m = engine.camera.matrix,
      w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
      x = ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w + 1) / 2,
      y = (1 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w) / 2;
    return last(data, Math.floor(x * grid[0]), Math.floor(y * grid[1]));
  };
  const orange = column([-1.75, 1, -1.5]),
    blue = column([1.8, 1.2, -2]);
  report.boxColumn = orange;
  report.sphereColumn = blue;
  assert(orange[0] > 1.8 * orange[1] && orange[1] > 1.8 * orange[2], `box column is not orange: ${orange}`);
  assert(blue[2] > 1.5 * blue[1] && blue[1] > 2 * blue[0], `sphere column is not blue: ${blue}`);
  report.checks.push("each volume's fog takes its own albedo");

  // 3. Volumes are read every frame: the sphere moved 2.5 m right shows there on the next frame (mirror again).
  list[1].center = [4.3, 1.2, -2];
  const moved = await compare('moved sphere');
  const after = column([1.8, 1.2, -2], moved.got.data);
  assert(after[3] < 0.2 * blue[3], `the sphere's old place stays foggy: ${blue[3]} then ${after[3]}`);
  report.movedMirrorError = moved.worst;
  report.checks.push('a moved volume moves its fog on the next frame');

  // 4. No volumes left: every column is clear.
  volumes.volumes = [];
  engine.render();
  const empty = await readTexture(device, fog.texture);
  assert(
    empty.data.every((v) => v === 0),
    'with no volumes and no global fog the volume is empty',
  );
  report.checks.push('with no volumes the fog volume is empty');

  await device.queue.onSubmittedWorkDone();
  assert(errors.length === 0, `GPU errors: ${errors.join('; ')}`);
  report.hardware = hardware({ info: device.adapterInfo });
  fog.dispose();
  volumes.dispose();
  depth.destroy();
  engine.dispose();
  return report;
};
