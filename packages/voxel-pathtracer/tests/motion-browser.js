// Independent analytic Y-rotation/slab oracle against actual public renderImage transport and its swept BVH.
export async function motionCheck({ model, look, ortho, rays, withTracer, errors }) {
  const W = 80,
    H = 80,
    times = 2048,
    size = [10, 1, 1];
  const rotate = (angle, scale, t) => {
    const c = Math.cos(angle),
      s = Math.sin(angle);
    return [c * scale[0], 0, -s * scale[0], 0, 0, scale[1], 0, 0, s * scale[2], 0, c * scale[2], 0, ...t, 1];
  };
  const blend = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
  const configurations = [
    { name: 'quarter-turn', angle: Math.PI / 2, s0: [1, 1, 1], s1: [1, 1, 1], t0: [0, 0, 0], t1: [0, 0, 0] },
    { name: 'half-turn', angle: Math.PI, s0: [1, 1, 1], s1: [1, 1, 1], t0: [0, 0, 0], t1: [0, 0, 0] },
    {
      name: 'reflected-scaled-moving',
      angle: Math.PI,
      s0: [-1, 1, 1],
      s1: [-1.25, 2, 0.75],
      t0: [-1, 0, 1],
      t1: [2, 0, -1],
    },
  ];
  const out = [];
  look([0, 40, 0], [0, 0, 0], { project: ortho(32), up: [0, 0, -1] });
  try {
    for (const config of configurations) {
      const previous = rotate(0, config.s0, config.t0),
        current = rotate(config.angle, config.s1, config.t1);
      const source = {
        revision: 1,
        models: [model('rod', size, () => 1)],
        instances: [
          { id: 'rod', modelId: 'rod', previousMatrix: previous, matrix: current, motionInterpolation: 'trs' },
        ],
        materials: [{ id: 1, color: [1, 1, 1], type: 'emit', emission: 1 }],
        environment: { skyIntensity: 0 },
      };
      const image = await withTracer(source, { shutter: 1, denoise: false }, (tracer) =>
        tracer.renderImage({ width: W, height: H, samples: 1024, denoise: false, jitter: false, seed: 71 }),
      );
      const ray = rays(W, H),
        expected = new Float64Array(W * H);
      const states = Array.from({ length: times }, (_, i) => {
        const t = (i + 0.5) / times,
          angle = config.angle * t;
        return {
          c: Math.cos(angle),
          s: Math.sin(angle),
          scale: blend(config.s0, config.s1, t),
          translation: blend(config.t0, config.t1, t),
        };
      });
      // Slab intersection in analytically transformed local coordinates. No engine interpolation/decomposition code.
      const covered = (r, state) => {
        const x = r.o[0] - state.translation[0],
          y = r.o[1] - state.translation[1],
          z = r.o[2] - state.translation[2];
        const o = [
          (state.c * x - state.s * z) / state.scale[0],
          y / state.scale[1],
          (state.s * x + state.c * z) / state.scale[2],
        ];
        const d = [
          (state.c * r.d[0] - state.s * r.d[2]) / state.scale[0],
          r.d[1] / state.scale[1],
          (state.s * r.d[0] + state.c * r.d[2]) / state.scale[2],
        ];
        let near = 0,
          far = Infinity;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-12) {
            if (o[a] < 0 || o[a] > size[a]) return false;
          } else {
            const first = -o[a] / d[a],
              last = (size[a] - o[a]) / d[a];
            near = Math.max(near, Math.min(first, last));
            far = Math.min(far, Math.max(first, last));
          }
        }
        return near < far;
      };
      const endpointBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const matrix of [previous, current])
        for (let corner = 0; corner < 8; corner++) {
          const p = size.map((v, a) => (corner & (1 << a) ? v : 0));
          for (let a = 0; a < 3; a++) {
            const v = matrix[a] * p[0] + matrix[4 + a] * p[1] + matrix[8 + a] * p[2] + matrix[12 + a];
            endpointBox[a] = Math.min(endpointBox[a], v);
            endpointBox[a + 3] = Math.max(endpointBox[a + 3], v);
          }
        }
      let squared = 0,
        maximum = 0,
        actualEnergy = 0,
        expectedEnergy = 0,
        arcActual = 0,
        arcExpected = 0,
        arcPixels = 0,
        nonfinite = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const r = ray(x + 0.5, y + 0.5),
            i = y * W + x;
          let count = 0;
          for (const state of states) if (covered(r, state)) count++;
          expected[i] = count / times;
          const actual = image.color[i * 3],
            delta = Math.abs(actual - expected[i]);
          squared += delta * delta;
          maximum = Math.max(maximum, delta);
          actualEnergy += actual;
          expectedEnergy += expected[i];
          for (let c = 0; c < 3; c++) if (!Number.isFinite(image.color[i * 3 + c])) nonfinite++;
          const outside =
            r.o[0] < endpointBox[0] - 0.001 ||
            r.o[0] > endpointBox[3] + 0.001 ||
            r.o[2] < endpointBox[2] - 0.001 ||
            r.o[2] > endpointBox[5] + 0.001;
          if (outside && expected[i] > 0.02) {
            arcPixels++;
            arcActual += actual;
            arcExpected += expected[i];
          }
        }
      out.push({
        name: config.name,
        rms: Math.sqrt(squared / (W * H)),
        maximum,
        actualEnergy,
        expectedEnergy,
        energyRatio: actualEnergy / expectedEnergy,
        arcPixels,
        arcRatio: arcExpected ? arcActual / arcExpected : null,
        nonfinite,
        timeIntegrationBins: times,
        renderSamples: 1024,
      });
    }
  } finally {
    look([20, 14, 24], [4, 3, 4]);
  }
  return { cases: out, errors: errors.splice(0) };
}
