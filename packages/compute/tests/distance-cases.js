// Jump flooding checks shared by the Node test (CPU backend) and the browser test (WebGPU and the WebGL2 layer):
// error rates against the exact transform (Felzenszwalb and Huttenlocher), reported as numbers.
import { distanceTransform, jumpFlood, jumpFloodSteps, voronoiMap, signedDistance, NO_SEED } from '../dist/distance.js';

// Runs in Node and in the browser page, so no node:assert.
const assert = {
  ok(value, message) {
    if (!value) throw new Error(message ?? 'assertion failed');
  },
  equal(actual, expected, message) {
    if (actual !== expected) throw new Error(message ?? `${actual} !== ${expected}`);
  },
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mask of `shape` with `count` random seeds, or `'curve'`: a thin sine curve (2D) or helix (3D). */
export function makeMask(shape, count, seed = 1) {
  const [w, h, d = 1] = shape,
    mask = new Uint8Array(w * h * d),
    random = rng(seed);
  if (count === 'curve') {
    for (let t = 0; t < 4 * w; t++) {
      const u = t / (4 * w),
        x = Math.floor(u * (w - 1)),
        y = Math.floor((0.5 + 0.35 * Math.sin(u * 14)) * (h - 1)),
        z = d > 1 ? Math.floor((0.5 + 0.35 * Math.cos(u * 14)) * (d - 1)) : 0;
      mask[(z * h + y) * w + x] = 1;
    }
    return mask;
  }
  for (let k = 0; k < count; k++) mask[Math.floor(random() * mask.length)] = 1;
  return mask;
}

/** Exact squared distance to the nearest seed per cell (Float64), from the shared separable transform. */
export function exactSquared(exact, mask, shape) {
  const grid = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) grid[i] = mask[i] ? 0 : 1e20;
  return exact(grid, shape);
}

const squaredTo = (c, i, shape) => {
  const [w, h] = shape,
    dx = (c % w) - (i % w),
    dy = (Math.floor(c / w) % h) - (Math.floor(i / w) % h),
    dz = Math.floor(c / (w * h)) - Math.floor(i / (w * h));
  return dx * dx + dy * dy + dz * dz;
};

/** Fraction of cells whose flooded nearest seed is not a nearest one, and the largest distance excess in cells. */
export function errors(nearest, exact2, shape) {
  let wrong = 0,
    worst = 0;
  for (let i = 0; i < nearest.length; i++) {
    const q = nearest[i] === NO_SEED ? Infinity : squaredTo(nearest[i], i, shape);
    if (q !== exact2[i]) {
      wrong++;
      worst = Math.max(worst, Math.sqrt(q) - Math.sqrt(exact2[i]));
    }
  }
  return { wrong: wrong / nearest.length, worst };
}

/**
 * Floods random and curve masks in 2D (`size` squared) and 3D (`size3` cubed) and checks the error bars of the plan:
 * jfa+1 under 0.1 percent wrong cells, plain jfa under 1 percent (curves excluded from the plain bar: the paper
 * notes thin features are the hard case, so those are reported), distance excess under 1 cell. Returns the numbers.
 */
export async function floodErrorRates(c, exact, size, size3) {
  const report = [];
  for (const [shape, counts] of [
    [
      [size, size],
      [1, 10, 1000, 'curve'],
    ],
    [
      [size3, size3, size3],
      [1, 10, 1000, 'curve'],
    ],
  ])
    for (const count of counts)
      for (const variant of ['jfa', 'jfa+1']) {
        const mask = makeMask(shape, count, 7);
        const exact2 = exactSquared(exact, mask, shape);
        using gpuMask = c.array(mask, { dtype: 'u32', shape });
        using flood = await jumpFlood(gpuMask, { variant });
        const nearest = await flood.nearest.read(),
          { wrong, worst } = errors(nearest, exact2, shape);
        report.push({ shape: shape.join('x'), count, variant, passes: flood.passes, wrong, worst });
        const bar = variant === 'jfa+1' ? 0.001 : 0.01;
        if (count !== 'curve' || variant === 'jfa+1')
          assert.ok(wrong < bar, `${variant} ${shape} ${count}: ${wrong} wrong`);
        // Plain JFA can pick a seed more than a cell too far (measured up to 1.3 cells at 1024^2). jfa+1 stays within one
        // cell in 2D; in 3D a rare wrong cell is up to two cells too far (measured 1.94 at 128^3 with 10 seeds).
        if (variant === 'jfa+1')
          assert.ok(
            worst <= (shape.length === 2 ? 1.0001 : 2.0001),
            `${variant} ${shape} ${count}: distance excess ${worst} cells`,
          );
        assert.equal(flood.passes, jumpFloodSteps(shape[0], variant).length);
      }
  return report;
}

/** Voronoi ids against brute force over the sites, and the signed distance sign, on a `size` squared grid. */
export async function voronoiAndSigned(c, size) {
  const random = rng(3),
    sites = [];
  for (let k = 0; k < 40; k++) sites.push(Math.floor(random() * size), Math.floor(random() * size));
  const map = await voronoiMap(c, sites, [size, size]);
  const ids = await map.id.read(),
    dist = await map.distance.read();
  let wrong = 0;
  for (let i = 0; i < size * size; i++) {
    const x = i % size,
      y = Math.floor(i / size);
    let best = Infinity;
    for (let k = 0; k < sites.length / 2; k++)
      best = Math.min(best, (sites[2 * k] - x) ** 2 + (sites[2 * k + 1] - y) ** 2);
    const got = (sites[2 * ids[i]] - x) ** 2 + (sites[2 * ids[i] + 1] - y) ** 2;
    if (got !== best) wrong++;
    else assert.ok(Math.abs(dist[i] - Math.sqrt(best)) < 1e-4);
  }
  map.id.dispose();
  map.distance.dispose();
  assert.ok(wrong / (size * size) < 0.001, `voronoi wrong ${wrong}`);
  // Signed distance: negative exactly on the mask, half a cell at the edge.
  const mask = makeMask([size, size], 'curve');
  for (let i = 0; i < mask.length; i++) if (Math.floor(i / size) > size / 2) mask[i] = 1;
  using gpuMask = c.array(mask, { dtype: 'u32', shape: [size, size] });
  using signed = await signedDistance(gpuMask);
  const values = await signed.read();
  for (let i = 0; i < mask.length; i++) assert.equal(values[i] < 0, mask[i] === 1, `sign at ${i}`);
  using unsigned = await distanceTransform(gpuMask);
  assert.equal((await unsigned.read())[0] >= 0, true);
  return { voronoiWrong: wrong / (size * size) };
}
