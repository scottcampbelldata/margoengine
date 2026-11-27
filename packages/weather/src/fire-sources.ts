// Where the light of the scene's fires comes from, as a few sources (KB-SKY-PALLFALLOFF1): their burning segments,
// clustered by weighted k-means (S. P. Lloyd, "Least squares quantization in PCM", IEEE Trans. Inf. Theory 28(2),
// 129-137, 1982, https://doi.org/10.1109/TIT.1982.1056489), seeded at the strongest segment and then, one at a time,
// at the segment of the largest power times squared distance to the seeds (the D^2 weighting of D. Arthur and
// S. Vassilvitskii, "k-means++: the advantages of careful seeding", SODA 2007,
// https://dl.acm.org/doi/10.5555/1283383.1283494, taken at its maximum in place of a draw, as the farthest-point
// traversal of T. F. Gonzalez, Theoretical Computer Science 38, 293-306, 1985,
// https://doi.org/10.1016/0304-3975(85)90224-5), so the same fires always give the same sources.

/** The most sources, the spots a sky takes. */
const SOURCES = 8;
/** A segment this close to a source, metres, never seeds another: half the lit height of the smoke layer over it. */
const SEPARATION = 500;

/** A burning segment, or a cluster of them: the point on the ground its light comes from and its power, watts. */
export interface FirePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly power: number;
}
/** One source: the power-weighted centre of its segments, their RMS distance from it on the ground and their power. */
export interface FireCluster extends FirePoint {
  readonly spread: number;
}

/** Clusters burning segments into at most eight sources, none for no segments. Every power must be above 0. */
export function clusterFires(points: readonly FirePoint[]): FireCluster[] {
  if (!points.length) return [];
  let strongest = points[0]!;
  for (const p of points) if (p.power > strongest.power) strongest = p;
  const seeds: [number, number][] = [[strongest.x, strongest.z]],
    away = points.map((p) => (p.x - strongest.x) ** 2 + (p.z - strongest.z) ** 2);
  while (seeds.length < SOURCES) {
    let next = -1,
      best = 0;
    for (let i = 0; i < points.length; i++) {
      const score = away[i]! > SEPARATION ** 2 ? away[i]! * points[i]!.power : 0;
      if (score > best) {
        best = score;
        next = i;
      }
    }
    if (next < 0) break;
    const { x, z } = points[next]!;
    seeds.push([x, z]);
    for (let i = 0; i < points.length; i++) away[i] = Math.min(away[i]!, (points[i]!.x - x) ** 2 + (points[i]!.z - z) ** 2);
  }
  const owner = new Int8Array(points.length).fill(-1),
    // Per source: power, and power times x, y, z.
    sums = new Float64Array(4 * seeds.length);
  for (let pass = 0, moved = true; moved && pass < 32; pass++) {
    moved = false;
    sums.fill(0);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      let near = 0,
        d = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const e = (p.x - seeds[k]![0]) ** 2 + (p.z - seeds[k]![1]) ** 2;
        if (e < d) {
          d = e;
          near = k;
        }
      }
      if (owner[i] !== near) {
        owner[i] = near;
        moved = true;
      }
      sums[4 * near]! += p.power;
      sums[4 * near + 1]! += p.power * p.x;
      sums[4 * near + 2]! += p.power * p.y;
      sums[4 * near + 3]! += p.power * p.z;
    }
    for (let k = 0; k < seeds.length; k++) {
      const power = sums[4 * k]!;
      if (power > 0) seeds[k] = [sums[4 * k + 1]! / power, sums[4 * k + 3]! / power];
    }
  }
  const square = new Float64Array(seeds.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!,
      [x, z] = seeds[owner[i]!]!;
    square[owner[i]!]! += p.power * ((p.x - x) ** 2 + (p.z - z) ** 2);
  }
  return seeds.flatMap(([x, z], k) => {
    const power = sums[4 * k]!;
    return power > 0 ? [{ x, y: sums[4 * k + 2]! / power, z, spread: Math.sqrt(square[k]! / power), power }] : [];
  });
}
