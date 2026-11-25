// The visible lid margin on Character Creator's eye occlusion shell. The shell's top rows tuck under the lid skin, so a
// shadow drawn from the shell's own top edge (eyeOcclusionAlpha's t = 0) starts where no camera sees it: Wilbur's
// shells open at v 0.03 to 0.09 across the middle of the eye and 0.16 to 0.5 at the corners (seen from the front), so
// the darkest part of the top shadow lay under the skin. A real eye is darkest right under the lid margin (a CC0
// photograph of a frontal eye: the sclera's first twentieth under the margin at 0.15 of its middle, asset library
// references/eyes/LABEL.md), where the lid and lashes hide most of the sky (ambient occlusion, Zhukov, Iones and Kronin, "An Ambient Light Illumination Model", EGWR 1998;
// Jimenez, von der Pahlen et al., "Next-Generation Character Rendering", GDC 2013, eye section). So the shadow is
// anchored to the margin: each shell vertex is tested for whether the head's skin hides it seen from the front (a ray
// against the skin's triangles, Moller and Trumbore, "Fast, Minimum Storage Ray-Triangle Intersection", JGT 1997), the
// margin is found on each shell edge between a hidden and a visible vertex by bisection, and the shell's v is remapped
// per u so the margin is v 0: v' = (v - v0(u)) / (1 - v0(u)). Hidden rows go below 0 and read the texture's clamped top
// row, the full lid shadow, under the skin where it does no harm.
// Only an edge that runs down the shell from a hidden end above to a seen end below (more v than u along it) crosses the
// top margin. At the corners the shell tucks under the canthus skin whole, so an edge across u from a hidden corner
// column to a seen one crosses the side of the opening at any height: taking those as the top margin put the corners
// 0.16 to 0.49 of the shell down on Wilbur. Columns with no top crossing take the margin's least-squares parabola over
// the columns that have one, the arc an adult upper lid follows to its corners (Putterman 2012; as `@margoengine/humans`
// `eyeLidMargin` fits it on the ball).

import { parabolaFit } from '../../shared/parabola-fit.js';

/** A triangle mesh in one space: xyz per vertex and a triangle list. */
export interface MarginMesh {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
}
/** The shell as {@link anchorLidShadow} reads it: its mesh and uv per vertex (glTF's, v 0 at the top lid). */
export interface MarginShell extends MarginMesh {
  uvs: ArrayLike<number>;
}
/** What {@link anchorLidShadow} found: the shell's new uvs and the margin, v0 at `bins` u steps from `u0` to `u1`. */
export interface LidMargin {
  uvs: Float32Array;
  u0: number;
  u1: number;
  margin: Float64Array;
  /** Shell vertices the skin hides from the front. */
  hidden: number;
}

const BINS = 24,
  STEPS = 20;
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const point = (p: ArrayLike<number>, i: number) => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
const triangles = (m: MarginMesh): number => ((m.indices ? m.indices.length : m.positions.length / 3) / 3) | 0;
const corner = (m: MarginMesh, t: number, k: number) => (m.indices ? m.indices[3 * t + k] : 3 * t + k);

/**
 * Remaps the shell's uvs so its top shadow starts at the lid margin the skin leaves visible from `front` (a direction
 * out of the face). `skin` is the head's skin in the shell's space. Returns undefined when the skin hides no part of
 * the shell's top half or all of it, leaving the shell as it was.
 */
export function anchorLidShadow(shell: MarginShell, skin: MarginMesh, front: readonly number[]): LidMargin | undefined {
  const n = shell.positions.length / 3,
    length = Math.hypot(front[0], front[1], front[2]);
  if (!(n >= 3) || !(length > 0) || shell.uvs.length < 2 * n) return undefined;
  const d = front.map((c) => c / length);
  // The skin near the shell: within one shell size of its bounds.
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], shell.positions[3 * i + k]);
      hi[k] = Math.max(hi[k], shell.positions[3 * i + k]);
    }
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
    eps = size * 1e-5,
    near: number[][][] = [];
  for (let t = 0, count = triangles(skin); t < count; t++) {
    const tri = [0, 1, 2].map((k) => point(skin.positions, corner(skin, t, k)));
    if (tri.some((p) => p.every((c, k) => c >= lo[k] - size && c <= hi[k] + size))) near.push(tri);
  }
  const hiddenAt = (p: number[]): boolean => {
    for (const [a, b, c] of near) {
      const e1 = sub(b, a),
        e2 = sub(c, a),
        q = cross(d, e2),
        det = dot(e1, q);
      if (Math.abs(det) < 1e-20) continue;
      const s = sub(p, a),
        u = dot(s, q) / det;
      if (u < 0 || u > 1) continue;
      const r = cross(s, e1),
        v = dot(d, r) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, r) / det > eps) return true;
    }
    return false;
  };
  const hidden = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) count += hidden[i] = +hiddenAt(point(shell.positions, i));
  if (!count || count === n) return undefined;
  // The margin on each edge from a hidden to a visible vertex, by bisection along the edge; top half only.
  let u0 = Infinity,
    u1 = -Infinity;
  for (let i = 0; i < n; i++) (u0 = Math.min(u0, shell.uvs[2 * i])), (u1 = Math.max(u1, shell.uvs[2 * i]));
  const span = u1 - u0 || 1,
    margin = new Float64Array(BINS).fill(NaN),
    seen = new Set<string>();
  for (let t = 0, tris = triangles(shell); t < tris; t++)
    for (let k = 0; k < 3; k++) {
      let a = corner(shell, t, k),
        b = corner(shell, t, (k + 1) % 3);
      if (hidden[a] === hidden[b]) continue;
      if (hidden[b]) [a, b] = [b, a];
      if (!(shell.uvs[2 * b + 1] - shell.uvs[2 * a + 1] > Math.abs(shell.uvs[2 * b] - shell.uvs[2 * a]))) continue;
      const key = `${a}/${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pa = point(shell.positions, a),
        pb = point(shell.positions, b);
      let h = 0,
        s = 1;
      for (let step = 0; step < STEPS; step++) {
        const m = (h + s) / 2;
        if (hiddenAt(pa.map((c, j) => c + (pb[j] - c) * m))) h = m;
        else s = m;
      }
      const f = (h + s) / 2,
        v = shell.uvs[2 * a + 1] + (shell.uvs[2 * b + 1] - shell.uvs[2 * a + 1]) * f;
      if (!(v < 0.5)) continue;
      const u = shell.uvs[2 * a] + (shell.uvs[2 * b] - shell.uvs[2 * a]) * f,
        bin = Math.min(BINS - 1, Math.max(0, Math.floor(((u - u0) / span) * BINS)));
      // The lowest top crossing in a column: below it the shell is seen.
      if (!(margin[bin] >= v)) margin[bin] = v;
    }
  const known = [...margin.keys()].filter((i) => margin[i] === margin[i]);
  if (!known.length) return undefined;
  // Columns with no crossing take the parabola fitted to the columns that have one by least squares, or the nearest
  // value when fewer than three have one.
  const c = parabolaFit(
    known,
    known.map((i) => margin[i]),
  );
  for (let i = 0; i < BINS; i++) {
    if (margin[i] === margin[i]) continue;
    const nearest = known.reduce((best, j) => (Math.abs(j - i) < Math.abs(best - i) ? j : best), known[0]);
    margin[i] = c ? c[0] + c[1] * i + c[2] * i * i : margin[nearest];
  }
  const at = (u: number): number => {
    const x = Math.min(BINS - 1, Math.max(0, ((u - u0) / span) * BINS - 0.5)),
      i = Math.min(BINS - 2, Math.floor(x));
    return BINS < 2 ? margin[0] : margin[i] + (margin[i + 1] - margin[i]) * (x - i);
  };
  const uvs = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const u = shell.uvs[2 * i],
      v0 = Math.min(0.49, Math.max(0, at(u)));
    uvs[2 * i] = u;
    uvs[2 * i + 1] = (shell.uvs[2 * i + 1] - v0) / (1 - v0);
  }
  return { uvs, u0, u1, margin, hidden: count };
}
