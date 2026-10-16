import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Environment, halfToFloat } from '../dist/index.js';
import { LightProbes } from '../dist/probes.js';

const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const octDecode = (u, v) => {
  const n = [u * 2 - 1, 1 - Math.abs(u * 2 - 1) - Math.abs(v * 2 - 1), v * 2 - 1];
  const t = Math.max(-n[1], 0);
  n[0] += n[0] >= 0 ? -t : t;
  n[2] += n[2] >= 0 ? -t : t;
  const length = Math.hypot(...n);
  return n.map((x) => x / length);
};
const rgb = (data, index) => [
  halfToFloat(data[index * 2] & 65535),
  halfToFloat(data[index * 2] >>> 16),
  halfToFloat(data[index * 2 + 1] & 65535),
];
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const coded = (d, factor = 1) => [1 + 0.7 * d[0] * factor, 0.8 + 0.6 * d[1] * factor, 1.2 - 0.9 * d[2] * factor];
// Independent one-dimensional spherical quadrature of D_GGX(N,H) * NdotL.
// A linear directional environment convolves to base + coefficient * N.
function directionalCoefficient(roughness) {
  let numerator = 0,
    denominator = 0;
  for (let i = 0; i < 65536; i++) {
    const mu = (i + 0.5) / 65536,
      a2 = roughness ** 4;
    const q = ((1 + mu) / 2) * (a2 - 1) + 1,
      weight = (a2 / (q * q)) * mu;
    numerator += weight * mu;
    denominator += weight;
  }
  return numerator / denominator;
}

window.runProbeSampleTests = async () => {
  const engine = await Engine.create(document.querySelector('#scene'), { backend: 'webgpu' });
  const device = engineRuntime(engine).gpu,
    errors = [],
    checks = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const info = device.adapterInfo;
  try {
    for (const kind of ['constant', 'directional', 'room']) {
      const runtime = engineRuntime(engine);
      runtime.lighting.direction[3] = 0;
      runtime.lighting.radiance[3] = kind === 'room' ? 1 : 0;
      let environment;
      const walls = [];
      if (kind === 'room') {
        const colors = [
          [0.8, 0.1, 0.1],
          [0.1, 0.7, 0.1],
          [0.9, 0.9, 0.9],
          [0.5, 0.5, 0.5],
          [0.1, 0.2, 0.8],
          [0.8, 0.7, 0.1],
        ];
        for (let f = 0; f < 6; f++) {
          const axis = f >> 1,
            p = [0, 0, 0],
            size = [4.4, 4.4, 4.4];
          p[axis] = (f & 1 ? -1 : 1) * 2.1;
          size[axis] = 0.2;
          walls.push(
            engine
              .createMesh()
              .setGeometry(box(...size))
              .setPosition(p)
              .setMaterial(new PbrMaterial({ color: colors[f], roughness: 1, metalness: 0 })),
          );
        }
      } else {
        const width = 256,
          height = 128,
          data = new Float32Array(width * height * 4);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const theta = (Math.PI * (y + 0.5)) / height,
              phi = 2 * Math.PI * ((x + 0.5) / width - 0.5);
            const d = [Math.sin(theta) * Math.sin(phi), Math.cos(theta), -Math.sin(theta) * Math.cos(phi)];
            data.set([...(kind === 'constant' ? [4, 1.25, 0.125] : coded(d)), 1], (y * width + x) * 4);
          }
        environment = await Environment.attach(
          engine,
          { width, height, data },
          {
            size: 128,
            specularSize: 128,
            samples: 64,
            brdfSize: 16,
            brdfSamples: 64,
          },
        );
      }
      const createProbes = () =>
        LightProbes.attach(engine, {
          environment,
          volume: { min: [-2, -2, -2], max: [2, 2, 2], counts: [1, 1, 1], resolution: 8 },
          reflections: [{ position: [0, 0, 0], min: [-2, -2, -2], max: [2, 2, 2] }],
          resolution: 128,
        });
      let probes = createProbes();
      device.pushErrorScope('validation');
      let start = performance.now();
      await probes.bake();
      const fullMs = performance.now() - start,
        full = probes.texels.slice();
      probes.dispose();
      probes = createProbes();
      start = performance.now();
      await probes.bake({ samples: 256 });
      const sampledMs = performance.now() - start,
        sampled = probes.texels.slice();
      let warmedSampledMs = null;
      if (kind !== 'room') {
        start = performance.now();
        await probes.bake({ samples: 256 });
        warmedSampledMs = performance.now() - start;
        assert(
          sampled.every((value, i) => value === probes.texels[i]),
          `${kind}: cached pipeline changed the bake`,
        );
      }
      const validation = await device.popErrorScope();
      assert(!validation, validation?.message);
      assert(!errors.length, errors.join('; '));
      const base = probes.reflectionOffset(0);
      assert(
        full.slice(0, base * 2).every((v, i) => v === sampled[i]),
        `${kind}: volume SH changed`,
      );
      assert(
        full.slice(base * 2, (base + 128 ** 2) * 2).every((v, i) => v === sampled[base * 2 + i]),
        `${kind}: sharp level0 changed`,
      );
      const levels = [];
      for (let level = 0, offset = base; level < 6; offset += (128 >> level) ** 2, level++) {
        const size = 128 >> level,
          roughness = level / 5,
          delta = [],
          analytic = [],
          seam = [];
        const coefficient = level ? directionalCoefficient(roughness) : 1;
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++) {
            const index = offset + y * size + x,
              value = rgb(sampled, index),
              reference = rgb(full, index);
            delta.push(Math.max(...value.map((v, ch) => Math.abs(v - reference[ch]))));
            if (kind === 'room') continue;
            const d = octDecode((x + 0.5) / size, (y + 0.5) / size);
            const expected = kind === 'constant' ? [4, 1.25, 0.125] : coded(d, coefficient);
            const error = Math.max(...value.map((v, ch) => Math.abs(v - expected[ch])));
            analytic.push(error);
            const sortedAxes = d.map(Math.abs).sort((a, b) => b - a);
            if (sortedAxes[0] - sortedAxes[1] < 3 / size) seam.push(error);
          }
        const row = {
          level,
          size,
          deltaP95: percentile(delta, 0.95),
          deltaMax: Math.max(...delta),
          analyticP95: analytic.length ? percentile(analytic, 0.95) : null,
          analyticMax: analytic.length ? Math.max(...analytic) : null,
          seamMax: seam.length ? Math.max(...seam) : null,
        };
        levels.push(row);
        if (kind === 'constant')
          assert(row.analyticMax < 0.004, `constant HDR energy level${level}: ${row.analyticMax}`);
        if (kind === 'directional') {
          assert(
            row.analyticP95 < 0.012 && row.analyticMax < 0.03,
            `directional integral level${level}: ${JSON.stringify(row)}`,
          );
          assert(row.seamMax === null || row.seamMax < 0.03, `cube seam level${level}: ${row.seamMax}`);
        }
        if (kind === 'room' && level)
          assert(row.deltaP95 < 0.03 && row.deltaMax < 0.06, `room vs full GGX level${level}: ${JSON.stringify(row)}`);
      }
      checks.push({ kind, fullMs, sampledMs, warmedSampledMs, levels, validationErrors: errors.slice() });
      probes.dispose();
      if (environment) engine.removePlugin(environment.name);
      walls.forEach((wall) => wall.dispose());
    }
    return {
      samples: 256,
      resolution: 128,
      hardware: info
        ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }
        : null,
      checks,
    };
  } finally {
    engine.dispose();
  }
};
