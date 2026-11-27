// Adaptive tearing of thin sheets (Pfaff, Narain, de Joya and O'Brien, "Adaptive Tearing and Cracking of Thin Sheets", ACM
// TOG 33(4), SIGGRAPH 2014): a cloth tears through its faces where they are stretched past the material's tear strain, across
// the direction of the greatest stretch, not only along the edges the mesh happens to have. Each step, the faces past the
// threshold are cut, most stretched first: the cut runs from one of the face's corners (a crack tip first, then a corner on the
// sheet's boundary, then any) across the face, perpendicular to its greatest principal stretch, to the opposite side, where a
// vertex is inserted and the face beyond is split too, so the mesh stays conforming (O'Brien and Hodgins, "Graphical Modeling
// and Animation of Brittle Fracture", SIGGRAPH 1999, the crack across the element along the principal direction; Pfaff et al.,
// the remeshing that keeps the faces conforming). A cut that would leave a sliver snaps to the nearer corner and runs along
// the face's side instead. The sides a crack has run along are kept; a vertex whose ring of faces those sides divide is
// duplicated, one copy for each part, its mass shared by area (the virtual nodes of Molino, Bao and Fedkiw 2004), so the crack
// opens behind its tip and the tip stays joined. A crack started inside the sheet opens once it has grown from one of its tips.
// The principal stretch is the face's, from its deformation gradient against the rest triangle its three edges' rest lengths
// give. Mass and momentum are kept by every cut: an inserted vertex takes its mass from the two it lies between, and its
// velocity is theirs interpolated.
import type { Vec3 } from './math.js';
import type { SoftBodies, SoftBody, SoftBodyDesc } from './soft.js';
import { carry, carrySkinLimits, type SoftDestination, type SoftSplit, skinLimitsDesc } from './soft-split.js';

const TORN = 1;
const PINNED = 1;
/** A cut nearer a corner than this share of the side snaps to the corner: no sliver faces. */
const SNAP = 0.2;

interface Edge {
  a: number;
  b: number;
  rest: number;
  rest0: number;
  bend: boolean;
  /** The edge of the old body whose settings it takes. */
  src: number;
  dead: boolean;
}

const key = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Cuts the faces of `body` stretched past its material's tear strain (at most `limit`, most stretched first) and rebuilds it.
 * Returns the split (one new body, or several where a cut parts it and the world splits), or null when no face is past.
 */
export function adaptiveTear(
  soft: SoftBodies,
  body: SoftBody,
  make: (positions: number[]) => SoftBodyDesc,
  limit: number,
): { split: SoftSplit; cuts: number } | null {
  const threshold = body.material.tearStrain;
  if (!(threshold > 0) || body.triangleList.length === 0) return null;
  const c = soft.columns(),
    fem = soft.cellColumns(),
    first = body.firstParticle,
    n0 = body.particles,
    pos: number[] = [],
    vel: number[] = [],
    mass: number[] = [],
    pinned: boolean[] = [],
    // What each particle of the new body is made of: old particles and their weights.
    from: [number, number][][] = [];
  for (let i = 0; i < n0; i++) {
    const row = first + i;
    pos.push(c.x[row]!, c.y[row]!, c.z[row]!);
    vel.push(c.vx[row]!, c.vy[row]!, c.vz[row]!);
    mass.push(body.masses[i]!);
    pinned.push((c.pflags[row]! & PINNED) !== 0);
    from.push([[i, 1]]);
  }
  const edges: Edge[] = [];
  for (let e = 0; e < body.edgeTotal; e++) {
    const row = body.firstEdge + e;
    if ((c.eflags[row]! & TORN) !== 0) continue;
    edges.push({
      a: c.ea[row]! - first,
      b: c.eb[row]! - first,
      rest: c.rest[row]!,
      rest0: fem.e_rest0?.[row] ?? c.rest[row]!,
      bend: e >= body.structural,
      src: e,
      dead: false,
    });
  }
  const sideEdge = (a: number, b: number): Edge | undefined =>
    edges.find((e) => !e.dead && !e.bend && ((e.a === a && e.b === b) || (e.a === b && e.b === a)));
  const triangles: number[][] = [];
  for (let t = 0; t < body.triangleList.length; t += 3)
    triangles.push([body.triangleList[t]!, body.triangleList[t + 1]!, body.triangleList[t + 2]!]);
  const crack = new Set(body.crackSides),
    at = (i: number): Vec3 => [pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!],
    restOf = (a: number, b: number): number => sideEdge(a, b)?.rest ?? dist(at(a), at(b));

  // The faces past the threshold, most stretched first.
  const failing: { tri: number[]; strain: number; along: Vec3 }[] = [];
  for (const tri of triangles) {
    const [a, b, d] = tri as [number, number, number],
      lab = sideEdge(a, b)?.rest,
      lad = sideEdge(a, d)?.rest,
      lbd = sideEdge(b, d)?.rest;
    if (!lab || !lad || !lbd) continue;
    const stretch = principalStretch(at(a), at(b), at(d), lab, lad, lbd);
    if (stretch && stretch.strain > threshold) failing.push({ tri, strain: stretch.strain, along: stretch.along });
  }
  if (failing.length === 0) return null;
  failing.sort((x, y) => y.strain - x.strain);

  const touched = new Set<number[]>();
  let cuts = 0;
  for (const { tri, along } of failing) {
    if (cuts >= limit) break;
    if (touched.has(tri) || !triangles.includes(tri)) continue;
    const [i0, i1, i2] = tri as [number, number, number],
      normal = unit(cross(sub(at(i1), at(i0)), sub(at(i2), at(i0))));
    if (!normal) continue;
    // The crack runs in the face's plane, across its greatest stretch.
    const direction = unit(cross(normal, along));
    if (!direction) continue;
    // Each corner's standing: a crack tip first, then a corner on the boundary, then any.
    const sides = sideCounts(triangles),
      tips = new Set([...crack].flatMap((k) => k.split(',').map(Number))),
      standing = (v: number): number =>
        tips.has(v) ? 2 : triangles.some((t) => t.includes(v) && boundaryAt(t, v, sides)) ? 1 : 0;
    let best: { v: number; a: number; b: number; u: number; rank: number } | null = null;
    for (const v of tri) {
      const [a, b] = tri.filter((x) => x !== v) as [number, number],
        ab = sub(at(b), at(a)),
        denominator = dot(cross(ab, direction), normal);
      if (Math.abs(denominator) < 1e-12) continue;
      const u = -dot(cross(sub(at(a), at(v)), direction), normal) / denominator;
      if (!(u >= 0 && u <= 1)) continue;
      const rank = standing(v) * 10 - Math.abs(u - 0.5);
      if (!best || rank > best.rank) best = { v, a, b, u, rank };
    }
    if (!best) continue;
    const { v, a, b, u } = best;
    let end: number;
    if (u < SNAP || u > 1 - SNAP) {
      // Along the face's side to the nearer corner.
      end = u < SNAP ? a : b;
      const side = sideEdge(v, end);
      if (side) side.dead = true;
    } else {
      // A vertex on the side opposite, splitting both faces that hold that side.
      end = from.length;
      const pa = at(a),
        pb = at(b);
      for (let k = 0; k < 3; k++) {
        pos.push(pa[k]! + u * (pb[k]! - pa[k]!));
        vel.push(vel[3 * a + k]! + u * (vel[3 * b + k]! - vel[3 * a + k]!));
      }
      const fromA = mass[a]! * ((1 - u) / 3),
        fromB = mass[b]! * (u / 3);
      mass[a] = mass[a]! - fromA;
      mass[b] = mass[b]! - fromB;
      mass.push(fromA + fromB);
      pinned.push(pinned[a]! && pinned[b]!);
      from.push([
        [a, 1 - u],
        [b, u],
      ]);
      const ab = sideEdge(a, b),
        lab = ab?.rest ?? dist(pa, pb),
        lab0 = ab?.rest0 ?? lab,
        src = ab?.src ?? -1;
      if (ab) ab.dead = true;
      edges.push(
        { a, b: end, rest: u * lab, rest0: u * lab0, bend: false, src, dead: false },
        { a: end, b, rest: (1 - u) * lab, rest0: (1 - u) * lab0, bend: false, src, dead: false },
      );
      for (const t of triangles.filter((t) => t.includes(a) && t.includes(b))) {
        const q = t.find((x) => x !== a && x !== b)!,
          k = t.indexOf(a),
          forward = t[(k + 1) % 3] === b,
          [first, second] = forward
            ? [
                [a, end, q],
                [end, b, q],
              ]
            : [
                [b, end, q],
                [end, a, q],
              ];
        triangles.splice(triangles.indexOf(t), 1, first!, second!);
        touched.add(first!).add(second!);
        if (q !== v) {
          // The face beyond is joined across its new side: Stewart's theorem gives its rest length.
          const qa = restOf(q, a),
            qb = restOf(q, b),
            rest = Math.sqrt(Math.max(0, (1 - u) * qa * qa + u * qb * qb - u * (1 - u) * lab * lab));
          edges.push({ a: q, b: end, rest, rest0: rest, bend: false, src, dead: false });
        }
      }
    }
    crack.add(key(v, end));
    // Whatever crosses the crack's new side no longer holds the sheet together there.
    const reach = 3 * Math.max(dist(at(i0), at(i1)), dist(at(i1), at(i2)), dist(at(i2), at(i0)));
    for (const e of edges)
      if (
        !e.dead &&
        e.a !== v &&
        e.b !== v &&
        e.a !== end &&
        e.b !== end &&
        dist(at(e.a), at(v)) < reach &&
        dist(at(e.b), at(v)) < reach &&
        segmentsCross(at(v), at(end), at(e.a), at(e.b), normal)
      )
        e.dead = true;
    touched.add(tri);
    cuts++;
  }
  if (cuts === 0) return null;

  // Unzip: a vertex whose ring of faces the crack's sides divide gets one copy for each part.
  const duplicated = new Set<number>(),
    tipsNow = new Set([...crack].flatMap((k) => k.split(',').map(Number)));
  for (const x of tipsNow) {
    const ring = triangles.filter((t) => t.includes(x));
    if (ring.length < 2) continue;
    const part = ring.map((_, k) => k),
      root = (k: number): number => {
        while (part[k] !== k) k = part[k] = part[part[k]!]!;
        return k;
      };
    for (let p = 0; p < ring.length; p++)
      for (let q = p + 1; q < ring.length; q++) {
        const shared = ring[p]!.filter((y) => y !== x && ring[q]!.includes(y));
        if (shared.some((y) => !crack.has(key(x, y)))) part[root(p)] = root(q);
      }
    const groups = new Map<number, number[][]>();
    ring.forEach((t, k) => groups.set(root(k), [...(groups.get(root(k)) ?? []), t]));
    if (groups.size < 2) continue;
    duplicated.add(x);
    const parts = [...groups.values()],
      areaOf = (ts: number[][]): number =>
        ts.reduce((s, t) => s + 0.5 * norm(cross(sub(at(t[1]!), at(t[0]!)), sub(at(t[2]!), at(t[0]!)))), 0),
      areas = parts.map(areaOf),
      total = areas.reduce((s, a) => s + a, 0) || 1,
      whole = mass[x]!,
      copies = parts.map((_, k) => (k === 0 ? x : from.length + k - 1));
    for (let k = 1; k < parts.length; k++) {
      pos.push(...at(x));
      vel.push(vel[3 * x]!, vel[3 * x + 1]!, vel[3 * x + 2]!);
      mass.push((whole * areas[k]!) / total);
      pinned.push(pinned[x]!);
      from.push(from[x]!);
    }
    mass[x] = (whole * areas[0]!) / total;
    parts.forEach((ts, k) => {
      if (k === 0) return;
      for (const t of ts) t[t.indexOf(x)] = copies[k]!;
    });
    // Each edge at the vertex goes with the part that holds its other end, or the part nearest it.
    for (const e of edges) {
      if (e.dead || (e.a !== x && e.b !== x)) continue;
      const y = e.a === x ? e.b : e.a;
      let k = parts.findIndex((ts) => ts.some((t) => t.includes(y)));
      if (k < 0) {
        let nearest = Number.POSITIVE_INFINITY;
        parts.forEach((ts, j) => {
          for (const t of ts) {
            const d = dist(centroid(t, at), at(y));
            if (d < nearest) {
              nearest = d;
              k = j;
            }
          }
        });
      }
      if (e.a === x) e.a = copies[k]!;
      else e.b = copies[k]!;
    }
  }
  // A side whose ends were not both left joined is open now; the rest are slits a later cut opens.
  for (const k of [...crack]) {
    const [p, q] = k.split(',').map(Number) as [number, number];
    if (duplicated.has(p) || duplicated.has(q)) crack.delete(k);
  }

  // The new body: the same particles first, then those the cuts made.
  const desc = make(pos),
    alive = edges.filter((e) => !e.dead),
    structural = alive.filter((e) => !e.bend),
    bend = alive.filter((e) => e.bend),
    rows = from.map((parts) => first + parts.reduce((best, p) => (p[1] > best[1] ? p : best))[0]),
    members = from.map((parts) => parts.reduce((best, p) => (p[1] > best[1] ? p : best))[0]);
  desc.edgePairs = structural.flatMap((e) => [e.a, e.b]);
  desc.bendPairs = bend.flatMap((e) => [e.a, e.b]);
  desc.triangles = triangles.flat();
  if (body.edgeKinds.length > 0) {
    desc.edgeKinds = structural.map((e) => (e.src >= 0 ? (body.edgeKinds[e.src] ?? 0) : 0));
    desc.edgeShear = structural.map((e) => (e.src >= 0 ? (body.edgeShear[e.src] ?? 0) : 0));
  }
  carry(desc, body, c, rows, new Map(), mass);
  desc.setPinnedParticles(pinned.flatMap((p, k) => (p ? [k] : [])));
  desc.tethers = body.tetherStretch;
  desc.airDrag = body.airDrag;
  desc.aero = body.aero;
  desc.density = body.density;
  if (body.selfContacts) {
    desc.selfContacts = true;
    desc.selfFriction = body.selfFriction;
  }
  skinLimitsDesc(desc, body, members);
  const piece = soft.create(desc),
    after = soft.columns(),
    afterFem = soft.cellColumns();
  [...structural, ...bend].forEach((e, k) => {
    after.rest[piece.firstEdge + k] = e.rest;
    if (afterFem.e_rest0) afterFem.e_rest0[piece.firstEdge + k] = e.rest0;
  });
  for (let i = 0; i < from.length; i++) {
    const row = piece.firstParticle + i;
    after.vx[row] = vel[3 * i]!;
    after.vy[row] = vel[3 * i + 1]!;
    after.vz[row] = vel[3 * i + 2]!;
  }
  carrySkinLimits(body, piece, members);
  if (piece.skinMax)
    from.forEach((parts, i) => {
      if (parts.length < 2) return;
      for (const array of [piece.skinFrom, piece.skinTo, piece.skinNormal])
        for (let k = 0; k < 3; k++) array[3 * i + k] = parts.reduce((s, [p, w]) => s + w * array[3 * p + k]!, 0);
    });
  piece.crackSides = crack;
  soft.remove(body);
  // Where each particle of the old body went: itself, and its copies along the crack.
  const where = new Map<number, SoftDestination[]>();
  from.forEach((parts, i) => {
    if (parts.length !== 1) return;
    const p = parts[0]![0];
    where.set(p, [...(where.get(p) ?? []), { body: piece, particle: i }]);
  });
  return { split: { pieces: [piece], destinations: (p) => where.get(p) ?? [] }, cuts };
}

/** The greatest principal stretch of a face (its strain, stretch less 1) and its direction in the world. */
function principalStretch(
  a: Vec3,
  b: Vec3,
  d: Vec3,
  lab: number,
  lad: number,
  lbd: number,
): { strain: number; along: Vec3 } | null {
  // The rest triangle laid flat: a at the origin, b along x, d above.
  const dx = (lab * lab + lad * lad - lbd * lbd) / (2 * lab),
    dy2 = lad * lad - dx * dx;
  if (!(dy2 > 0)) return null;
  const dy = Math.sqrt(dy2),
    det = lab * dy,
    eb = sub(b, a),
    ed = sub(d, a),
    // F = [eb ed] inverse([[lab, dx], [0, dy]]).
    f1 = scale(eb, dy / det),
    f2: Vec3 = [
      (-eb[0] * dx + ed[0] * lab) / det,
      (-eb[1] * dx + ed[1] * lab) / det,
      (-eb[2] * dx + ed[2] * lab) / det,
    ],
    c11 = dot(f1, f1),
    c12 = dot(f1, f2),
    c22 = dot(f2, f2),
    mean = (c11 + c22) / 2,
    half = (c11 - c22) / 2,
    spread = Math.sqrt(half * half + c12 * c12),
    largest = mean + spread;
  // Its eigenvector in the rest plane, then carried into the world by F.
  let r: [number, number] = Math.abs(c12) > 1e-12 ? [c12, largest - c11] : c11 >= c22 ? [1, 0] : [0, 1];
  const length = Math.sqrt(r[0] * r[0] + r[1] * r[1]);
  r = [r[0] / length, r[1] / length];
  const along = unit([f1[0] * r[0] + f2[0] * r[1], f1[1] * r[0] + f2[1] * r[1], f1[2] * r[0] + f2[2] * r[1]]);
  if (!along) return null;
  return { strain: Math.sqrt(largest) - 1, along };
}

/** How many faces hold each side. */
function sideCounts(triangles: number[][]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of triangles)
    for (let k = 0; k < 3; k++) {
      const s = key(t[k]!, t[(k + 1) % 3]!);
      out.set(s, (out.get(s) ?? 0) + 1);
    }
  return out;
}

/** Whether face `t` has a side at `v` that no other face holds. */
function boundaryAt(t: number[], v: number, sides: Map<string, number>): boolean {
  return t.some((y) => y !== v && sides.get(key(v, y)) === 1);
}

/** Whether segments pq and rs cross, seen along `normal`. */
function segmentsCross(p: Vec3, q: Vec3, r: Vec3, s: Vec3, normal: Vec3): boolean {
  const side = (a: Vec3, b: Vec3, x: Vec3): number => dot(cross(sub(b, a), sub(x, a)), normal);
  const d1 = side(p, q, r),
    d2 = side(p, q, s),
    d3 = side(r, s, p),
    d4 = side(r, s, q);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function centroid(t: number[], at: (i: number) => Vec3): Vec3 {
  const [a, b, c] = [at(t[0]!), at(t[1]!), at(t[2]!)];
  return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));
function unit(a: Vec3): Vec3 | null {
  const length = norm(a);
  return length > 0 ? scale(a, 1 / length) : null;
}
