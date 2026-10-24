import { failure, inspectBody, isMain, model, outputRoot, runCases, workerMain } from './common.mjs';

export function cases() {
  return [0.0001, 0.001, 0.01].flatMap((radiusMm) =>
    [50000, 200000].map((maxFaceVertices) => ({
      suite: 'F-mesh-audit',
      id: `torus-${radiusMm}mm-cap${maxFaceVertices}`,
      radiusMm,
      maxFaceVertices,
    })),
  );
}

export function executeCase(c) {
  try {
    const R = 0.005,
      r = c.radiusMm / 1000;
    const body = model.revolve(
      'stress-revolve',
      {
        name: 'arc-torus',
        normal: [0, -1, 0],
        start: [R + r, 0, 0],
        segments: [
          { kind: 'arc', to: [R - r, 0, 0], center: [R, 0, 0] },
          { kind: 'arc', to: [R + r, 0, 0], center: [R, 0, 0] },
        ],
      },
      { origin: [0, 0, 0], direction: [0, 0, 1] },
    );
    const baseline = inspectBody(body, { expectedVolume: 2 * Math.PI ** 2 * R * r ** 2, label: c.id });
    const mass = model.massProperties(body),
      deflection = Math.sqrt(mass.area) * 1e-4;
    const perFace = [];
    let meshVolume = 0,
      open = 0,
      maxSampledGap = 0;
    for (const mesh of model.meshBodies([body], { deflection, angle: 0.15, maxFaceVertices: c.maxFaceVertices })
      .meshes) {
      const p = mesh.positions,
        t = mesh.indices,
        ids = new Map(),
        directed = new Map();
      const point = (i) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
      const weld = (i) => {
        const key = point(i).join(',');
        if (!ids.has(key)) ids.set(key, ids.size);
        return ids.get(key);
      };
      for (const face of mesh.faces) {
        const used = new Set(t.slice(face.first, face.first + face.count));
        perFace.push({
          id: face.id,
          triangles: face.count / 3,
          vertices: used.size,
          atCap: used.size >= c.maxFaceVertices,
          nearCap: used.size >= c.maxFaceVertices * 0.95,
        });
      }
      const origin = point(0);
      for (let k = 0; k < t.length; k += 3) {
        const q = [t[k], t[k + 1], t[k + 2]].map(point);
        const [a, b, d] = q.map((v) => v.map((n, j) => n - origin[j]));
        meshVolume +=
          (a[0] * (b[1] * d[2] - b[2] * d[1]) +
            a[1] * (b[2] * d[0] - b[0] * d[2]) +
            a[2] * (b[0] * d[1] - b[1] * d[0])) /
          6;
        const samples = [
          [0.5, 0.5, 0],
          [0, 0.5, 0.5],
          [0.5, 0, 0.5],
          [1 / 3, 1 / 3, 1 / 3],
        ];
        for (const weights of samples) {
          const at = [0, 1, 2].map((j) => q.reduce((s, v, i) => s + weights[i] * v[j], 0));
          const gap = Math.abs(Math.hypot(Math.hypot(at[0], at[1]) - R, at[2]) - r);
          maxSampledGap = Math.max(maxSampledGap, gap);
        }
        const w = [t[k], t[k + 1], t[k + 2]].map(weld);
        for (const [x, y] of [
          [w[0], w[1]],
          [w[1], w[2]],
          [w[2], w[0]],
        ]) {
          if (x !== y) directed.set(`${x},${y}`, (directed.get(`${x},${y}`) ?? 0) + 1);
        }
      }
      for (const [key, count] of directed) {
        const [x, y] = key.split(',');
        if (count !== 1 || directed.get(`${y},${x}`) !== 1) open++;
      }
    }
    const bound = 2 * mass.area * deflection;
    const withinVolumeBound = Math.abs(meshVolume - mass.volume) <= bound;
    return {
      ...c,
      status: open ? 'invalid' : withinVolumeBound ? 'passed' : 'wrong',
      baseline,
      mass,
      deflection,
      maxSampledGap,
      sampledGapOverDeflection: maxSampledGap / deflection,
      meshVolume,
      relativeVolumeError: meshVolume / mass.volume - 1,
      bound,
      withinVolumeBound,
      open,
      perFace,
    };
  } catch (error) {
    return { ...c, ...failure(error) };
  }
}

if (!workerMain(executeCase) && isMain(import.meta.url)) {
  await runCases(cases(), import.meta.url, {
    output: `${outputRoot}/blend-mesh-audit.jsonl`,
    workers: 1,
    timeoutMs: 60000,
  });
}
