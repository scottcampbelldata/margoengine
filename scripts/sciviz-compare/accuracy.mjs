// Closed-form accuracy references (docs/whitepaper/sciviz-vs-rivals.md, "Accuracy against closed-form answers") run
// through VTK.js public filters as a black box where it is installed (engine-bench), next to Margo's own output.
// No rival source is read or copied: inputs go in through documented setters, outputs are read as polydata.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export const RADIUS = 0.7;
export const RESOLUTIONS = [33, 65];
const ABC = [Math.sqrt(3), Math.sqrt(2), 1];
export const abc = (x, y, z) => [
  ABC[0] * Math.sin(z) + ABC[2] * Math.cos(y),
  ABC[1] * Math.sin(x) + ABC[0] * Math.cos(z),
  ABC[2] * Math.sin(y) + ABC[1] * Math.cos(x),
];

/** Float64 RK4 of the analytic ABC field, the streamline reference. */
export function abcReference(seed, time, steps) {
  let p = [...seed];
  const h = time / steps,
    add = (a, b, s) => a.map((x, i) => x + s * b[i]);
  for (let i = 0; i < steps; i++) {
    const k1 = abc(...p),
      k2 = abc(...add(p, k1, h / 2)),
      k3 = abc(...add(p, k2, h / 2)),
      k4 = abc(...add(p, k3, h));
    p = p.map((x, j) => x + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
  }
  return p;
}

/** Area and enclosed volume (divergence theorem against the origin) of a triangle list from a vertex getter. */
export function meshMeasures(triangles, vertex) {
  let area = 0,
    volume = 0;
  for (let t = 0; t < triangles; t++) {
    const a = vertex(t, 0),
      b = vertex(t, 1),
      c = vertex(t, 2);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return { triangles, area, volume: Math.abs(volume) };
}

/** Triangles of a VTK-style cell array (count, ids...), fanned when a cell has more than three points. */
export function cellTriangles(cells) {
  const out = [];
  for (let c = 0; c < cells.length; c += cells[c] + 1)
    for (let t = 1; t + 1 < cells[c]; t++) out.push(cells[c + 1], cells[c + 1 + t], cells[c + 2 + t]);
  return out;
}

const sphereField = (n) => {
  const values = new Float32Array(n ** 3),
    at = (i) => -1 + (2 * i) / (n - 1);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) values[i + n * (j + n * k)] = RADIUS - Math.hypot(at(i), at(j), at(k));
  return values;
};
const circleField = (n) => {
  const values = new Float32Array(n * n),
    x = (i) => -1 + (2 * i) / (n - 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) values[i + n * j] = x(i) ** 2 + x(j) ** 2;
  return values;
};
const abcField = (n) => {
  const values = new Float32Array(3 * n ** 3),
    at = (i) => (2 * Math.PI * i) / (n - 1);
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) values.set(abc(at(i), at(j), at(k)), 3 * (i + n * (j + n * k)));
  return values;
};

/** Runs the three extractable references through VTK.js loaded from `modules` (engine-bench node_modules). */
export async function vtkAccuracy(modules) {
  const root = join(modules, '@kitware', 'vtk.js');
  const load = async (path) => (await import(pathToFileURL(join(root, `${path}.js`)).href)).default;
  const [ImageData, DataArray, PolyData, MarchingCubes, MarchingSquares, Streamline] = await Promise.all(
    [
      'Common/DataModel/ImageData',
      'Common/Core/DataArray',
      'Common/DataModel/PolyData',
      'Filters/General/ImageMarchingCubes',
      'Filters/General/ImageMarchingSquares',
      'Filters/General/ImageStreamline',
    ].map(load),
  );
  const image = (dims, spacing, origin, values, components, vectors = false) => {
    const data = ImageData.newInstance();
    data.setDimensions(...dims);
    data.setSpacing(...spacing);
    data.setOrigin(...origin);
    const array = DataArray.newInstance({ name: 'field', values, numberOfComponents: components });
    if (vectors) data.getPointData().setVectors(array);
    else data.getPointData().setScalars(array);
    return data;
  };
  const sphere = (n) => {
    const h = 2 / (n - 1),
      filter = MarchingCubes.newInstance({ contourValue: 0, computeNormals: false, mergePoints: false });
    filter.setInputData(image([n, n, n], [h, h, h], [-1, -1, -1], sphereField(n), 1));
    const out = filter.getOutputData(),
      p = out.getPoints().getData(),
      ids = cellTriangles(out.getPolys().getData());
    return meshMeasures(ids.length / 3, (t, c) => [...p.subarray(3 * ids[3 * t + c], 3 * ids[3 * t + c] + 3)]);
  };
  const stream = (n, seed, time, step) => {
    const h = (2 * Math.PI) / (n - 1),
      seeds = PolyData.newInstance(),
      filter = Streamline.newInstance();
    seeds.getPoints().setData(Float32Array.from(seed), 3);
    filter.setInputData(image([n, n, n], [h, h, h], [0, 0, 0], abcField(n), 3, true), 0);
    filter.setInputData(seeds, 1);
    filter.setIntegrationStep(step);
    filter.setMaximumNumberOfSteps(Math.round(time / step));
    const p = filter.getOutputData().getPoints().getData();
    return { points: p.length / 3, end: [...p.subarray(p.length - 3)] };
  };
  const isoline = (n) => {
    const h = 2 / (n - 1),
      filter = MarchingSquares.newInstance({ contourValues: [0.25], slicingMode: 2, slice: 0, mergePoints: true });
    filter.setInputData(image([n, n, 1], [h, h, 1], [-1, -1, 0], circleField(n), 1));
    const out = filter.getOutputData(),
      p = out.getPoints().getData(),
      cells = out.getLines().getData();
    let worst = 0,
      lines = 0;
    for (let i = 0; i < p.length; i += 3) worst = Math.max(worst, Math.abs(Math.hypot(p[i], p[i + 1]) - 0.5));
    for (let c = 0; c < cells.length; c += cells[c] + 1) lines++;
    return { points: p.length / 3, lineCells: lines, worst };
  };
  const seed = [Math.PI, Math.PI, Math.PI],
    exact = abcReference(seed, 1, 20_000);
  const area = 4 * Math.PI * RADIUS ** 2,
    volume = (4 / 3) * Math.PI * RADIUS ** 3;
  return {
    isosurface: RESOLUTIONS.map((n) => {
      const m = sphere(n);
      return { n, ...m, areaError: Math.abs(m.area - area) / area, volumeError: Math.abs(m.volume - volume) / volume };
    }),
    streamline: RESOLUTIONS.map((n) => {
      const s = stream(n, seed, 1, 0.005);
      return { n, ...s, endDistance: Math.hypot(...s.end.map((x, i) => x - exact[i])) };
    }),
    isoline: RESOLUTIONS.map((n) => ({ n, ...isoline(n) })),
    beerLambert: 'not measurable: VTK.js exposes no pre-integrated opacity table through its public API',
  };
}
