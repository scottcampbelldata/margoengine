// The water a body carries (SEA-12): added masses of standard shapes and of any closed mesh by its equivalent ellipsoid.
// - An ellipsoid of semi-axes a, b, c moving along axis i carries C_A = alpha_i / (2 - alpha_i) of its displaced mass, alpha_i
//   = abc int_0^inf du / ((a_i^2 + u) sqrt((a^2 + u)(b^2 + u)(c^2 + u))) (H. Lamb, "Hydrodynamics", as DNV-RP-C205 2010, table
//   D-2, restates it, read): a sphere 1/2; a spheroid of a / b = 2 0.210 along and 0.704 across; the alphas sum to 2.
// - Other shapes from DNV-RP-C205 tables D-1 and D-2 (read): a cube 0.68 rho a^3, a disc 2/pi of its sphere, a cylinder 1 per
//   length across.
// - A mesh: its volume and second moments of volume by signed tetrahedra, their principal axes, and the ellipsoid with the
//   same moments, semi-axes sqrt(5 I_i / V) (a solid ellipsoid has int x^2 dV = V a^2 / 5).

const PI = 3.141592653589793;

/** The alphas of Lamb's ellipsoid integrals for semi-axes [a, b, c]: they sum to 2. */
export function ellipsoidAlphas(axes: readonly [number, number, number]): [number, number, number] {
  const [a, b, c] = axes;
  if (!(a > 0 && b > 0 && c > 0 && Number.isFinite(a + b + c)))
    throw new RangeError(`An ellipsoid's semi-axes are finite and above 0 (got ${axes.join(', ')}); pass three.`);
  // u = s x / (1 - x) over x in [0, 1), Simpson's rule; the integrand falls as u^(-5/2).
  const s = (a * a + b * b + c * c) / 3,
    n = 4000,
    out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k <= n; k++) {
    const x = k / n;
    if (x >= 1) continue;
    const u = (s * x) / (1 - x),
      du = s / ((1 - x) * (1 - x)),
      root = Math.sqrt((a * a + u) * (b * b + u) * (c * c + u)),
      weight = (k === 0 || k === n ? 1 : k % 2 ? 4 : 2) / (3 * n);
    out[0] += (weight * du) / ((a * a + u) * root);
    out[1] += (weight * du) / ((b * b + u) * root);
    out[2] += (weight * du) / ((c * c + u) * root);
  }
  const abc = a * b * c;
  return [out[0] * abc, out[1] * abc, out[2] * abc];
}

/** An ellipsoid's added-mass coefficients C_A along its three axes (of its displaced mass rho 4/3 pi abc). */
export function ellipsoidAddedMass(axes: readonly [number, number, number]): [number, number, number] {
  const alphas = ellipsoidAlphas(axes);
  return alphas.map((alpha) => alpha / (2 - alpha)) as [number, number, number];
}

/** A closed mesh's ellipsoid of equal second moments: its centre, its semi-axes and their directions (rows), its volume. */
export interface EquivalentEllipsoid {
  centre: [number, number, number];
  axes: [number, number, number];
  directions: [[number, number, number], [number, number, number], [number, number, number]];
  volume: number;
}

/**
 * The ellipsoid with the volume and second moments of a closed mesh (vertices x, y, z; triangles wound outward): its centroid,
 * principal directions and semi-axes sqrt(5 I_i / V).
 */
export function equivalentEllipsoid(mesh: {
  readonly vertices: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
}): EquivalentEllipsoid {
  const { vertices: p, indices: t } = mesh ?? ({} as { vertices: number[]; indices: number[] });
  if (!p || !t || t.length < 12 || t.length % 3 !== 0)
    throw new RangeError('A mesh is {vertices, indices}, closed, of at least four triangles wound outward; pass one.');
  let volume = 0;
  const first = [0, 0, 0],
    second = [0, 0, 0, 0, 0, 0]; // xx, yy, zz, xy, xz, yz about the origin
  for (let k = 0; k < t.length; k += 3) {
    const i = 3 * t[k]!,
      j = 3 * t[k + 1]!,
      l = 3 * t[k + 2]!,
      a = [p[i]!, p[i + 1]!, p[i + 2]!],
      b = [p[j]!, p[j + 1]!, p[j + 2]!],
      c = [p[l]!, p[l + 1]!, p[l + 2]!],
      // The tetrahedron (origin, a, b, c): signed volume and the exact integrals of x and x y over it.
      v =
        (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
          a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
          a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) /
        6;
    volume += v;
    for (let q = 0; q < 3; q++) first[q]! += (v * (a[q]! + b[q]! + c[q]!)) / 4;
    const pair = (m: number, n: number) =>
      (v / 20) *
      (2 * (a[m]! * a[n]! + b[m]! * b[n]! + c[m]! * c[n]!) +
        a[m]! * b[n]! +
        a[n]! * b[m]! +
        a[m]! * c[n]! +
        a[n]! * c[m]! +
        b[m]! * c[n]! +
        b[n]! * c[m]!);
    second[0]! += pair(0, 0);
    second[1]! += pair(1, 1);
    second[2]! += pair(2, 2);
    second[3]! += pair(0, 1);
    second[4]! += pair(0, 2);
    second[5]! += pair(1, 2);
  }
  if (!(volume > 0))
    throw new RangeError(`This mesh encloses no volume (${volume} m^3); close it and wind its triangles outward.`);
  const centre: [number, number, number] = [first[0]! / volume, first[1]! / volume, first[2]! / volume],
    // About the centroid.
    m = [
      [
        second[0]! - volume * centre[0] * centre[0],
        second[3]! - volume * centre[0] * centre[1],
        second[4]! - volume * centre[0] * centre[2],
      ],
      [0, second[1]! - volume * centre[1] * centre[1], second[5]! - volume * centre[1] * centre[2]],
      [0, 0, second[2]! - volume * centre[2] * centre[2]],
    ];
  m[1]![0] = m[0]![1]!;
  m[2]![0] = m[0]![2]!;
  m[2]![1] = m[1]![2]!;
  const [values, vectors] = jacobi(m as number[][]);
  return {
    centre,
    axes: values.map((value) => Math.sqrt(Math.max(1e-300, (5 * value) / volume))) as [number, number, number],
    directions: vectors,
    volume,
  };
}

/** The eigenvalues and eigenvectors (rows) of a symmetric 3 by 3 matrix by Jacobi rotations. */
function jacobi(
  input: number[][],
): [[number, number, number], [[number, number, number], [number, number, number], [number, number, number]]] {
  const a = input.map((row) => [...row]),
    v = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) off += a[p]![q]! * a[p]![q]!;
    if (off < 1e-30) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p]![q]!) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!),
          t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!,
            akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!,
            aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vpk = v[p]![k]!,
            vqk = v[q]![k]!;
          v[p]![k] = c * vpk - s * vqk;
          v[q]![k] = s * vpk + c * vqk;
        }
      }
  }
  return [
    [a[0]![0]!, a[1]![1]!, a[2]![2]!],
    [v[0] as [number, number, number], v[1] as [number, number, number], v[2] as [number, number, number]],
  ];
}

/** A cube of side a carries 0.68 rho a^3 moving face-on (DNV-RP-C205 table D-2). */
export const CUBE_ADDED_MASS = 0.68;
/** A swimmer gliding prone carries about a quarter of its mass across its length (Caspersen et al. 2010; Kjendlie et al. 2009). */
export const DIVER_ADDED_MASS = 0.25;
/** A sphere's added mass coefficient, 1/2 of its displaced mass. */
export const SPHERE_ADDED_MASS = 0.5;
void PI;
