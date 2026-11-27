// Splitting a soft body in pieces: after cells tear or a blade cuts, the particles along the crack are duplicated, one for each
// side that meets there (the virtual nodes of Molino, Bao and Fedkiw, "A Virtual Node Algorithm for Changing Mesh Topology
// During Simulation", SIGGRAPH 2004), and each piece of cells that is no longer joined to another becomes a soft body of its own,
// with the rest shapes, plastic flow and rest lengths its cells and edges had.
import type { SoftBodies, SoftBody, SoftBodyDesc } from './soft.js';
import { CRACK_FRONT_MASK, NUCLEATED_CELL } from './soft-tensile-seam.js';
import { boundaryTriangles, closedSurface, meshVolume } from './soft-volume.js';

const TORN = 1;
const PINNED = 1;
const NONE = 0xffffffff;

/** Where a particle of the body that was split went: one place for each piece it is part of. */
export interface SoftDestination {
  /** The piece. */
  body: SoftBody;
  /** The particle's number in that piece. */
  particle: number;
}

/** What splitting a body made. */
export interface SoftSplit {
  /** The new bodies, in the order they were made. */
  pieces: SoftBody[];
  /** Where a particle of the old body (numbered as in the old body) went. A particle on a crack went to each side of it. */
  destinations(particle: number): SoftDestination[];
}

/** Rebuild the query surface from the piece's current boundary, inheriting the live contact settings. */
export function carryCutSurface(soft: SoftBodies, original: SoftBody, piece: SoftBody): void {
  const collider = original.surface?.colliders[0];
  if (!collider?.valid || piece.triangleList.length === 0) return;
  const { collision, contactForce } = collider.activeEvents();
  // Carry volume mass only when the old collider owned it and the new collision mesh still encloses it.
  let density: number | undefined;
  if (collider.volume() > 0) {
    const indices = piece.skin ? piece.meshIndices() : piece.triangleList;
    if (
      closedSurface(indices) &&
      meshVolume(piece.skin ? piece.meshVertices() : piece.particlePositions(), indices) > 0
    )
      density = collider.density();
  }
  soft.createSurfaceCollider(piece, {
    friction: collider.friction(),
    restitution: collider.restitution(),
    frictionCombine: collider.frictionCombineRule(),
    restitutionCombine: collider.restitutionCombineRule(),
    contactSkin: collider.contactSkin(),
    collisionGroups: collider.interactionGroups(),
    solverGroups: collider.solverInteractionGroups(),
    sensor: collider.isSensor(),
    enabled: collider.isEnabled(),
    events: collision,
    activeCollisionTypes: collider.activeCollisionTypes(),
    activeHooks: collider.activeHooks(),
    contactForceEvents: contactForce,
    contactForceThreshold: collider.contactForceEventThreshold(),
    density,
    userData: collider.userData,
  });
}

/** A copy of the kernel's columns: making a piece grows the memory, which leaves earlier views empty. */
const snapshot = (columns: Record<string, Float32Array>): Record<string, Float32Array> =>
  Object.fromEntries(Object.entries(columns).map(([name, view]) => [name, view.slice()]));

const find = (parent: Int32Array, i: number): number => {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]!]!;
    i = parent[i]!;
  }
  return i;
};
const join = (parent: Int32Array, a: number, b: number): void => {
  parent[find(parent, a)] = find(parent, b);
};

/**
 * Splits `body` where its cells or edges have torn or `cut` faces (cell index times 4 plus the corner opposite) are cut: returns
 * null when nothing is split, or the pieces with the old body removed. Each piece can have a rebuilt surface collider.
 */
export function splitBody(
  soft: SoftBodies,
  body: SoftBody,
  make: (positions: number[]) => SoftBodyDesc,
  cut?: ReadonlySet<number>,
): SoftSplit | null {
  if (body.removed) return null;
  const { count } = body.cellRange;
  if (count > 0) return splitCells(soft, body, make, cut);
  return splitEdges(soft, body, make);
}

/** A body of edges only: its pieces are the connected parts of the edges that are left. */
function splitEdges(soft: SoftBodies, body: SoftBody, make: (positions: number[]) => SoftBodyDesc): SoftSplit | null {
  const c = snapshot(soft.columns()),
    n = body.particles,
    parent = Int32Array.from({ length: n }, (_, i) => i),
    alive: number[] = [];
  for (let e = 0; e < body.edgeTotal; e++) {
    if ((c.eflags[body.firstEdge + e]! & TORN) !== 0) continue;
    alive.push(e);
    // Only a structural or shear edge joins particles into a piece: a bend edge reaches across a tear and holds nothing together.
    if (e < body.structural)
      join(parent, c.ea[body.firstEdge + e]! - body.firstParticle, c.eb[body.firstEdge + e]! - body.firstParticle);
  }
  const roots = new Set<number>(),
    // The sides of torn edges, as pairs of particles, for the triangles that stand on them.
    tornSide = new Set<number>();
  for (let e = 0; e < body.structural; e++)
    if ((c.eflags[body.firstEdge + e]! & TORN) !== 0) {
      const a = c.ea[body.firstEdge + e]! - body.firstParticle,
        b = c.eb[body.firstEdge + e]! - body.firstParticle;
      tornSide.add(Math.min(a, b) * n + Math.max(a, b));
    }
  for (let i = 0; i < n; i++) roots.add(find(parent, i));
  if (roots.size <= 1) return null;
  const f = snapshot(soft.cellColumns()),
    pieces: SoftBody[] = [],
    where = new Map<number, SoftDestination>();
  for (const root of roots) {
    const members: number[] = [];
    for (let i = 0; i < n; i++) if (find(parent, i) === root) members.push(i);
    const local = new Map(members.map((p, k) => [p, k])),
      desc = make(
        members.flatMap((p) => [
          c.x[body.firstParticle + p]!,
          c.y[body.firstParticle + p]!,
          c.z[body.firstParticle + p]!,
        ]),
      );
    carry(
      desc,
      body,
      c,
      members.map((p) => body.firstParticle + p),
      local,
      members.map((p) => body.masses[p]!),
    );
    const edgeRows: number[] = [];
    for (const e of alive) {
      const a = c.ea[body.firstEdge + e]! - body.firstParticle,
        b = c.eb[body.firstEdge + e]! - body.firstParticle;
      if (!local.has(a) || !local.has(b)) continue;
      (e < body.structural ? desc.edgePairs : desc.bendPairs).push(local.get(a)!, local.get(b)!);
      if (e < body.structural) desc.edgeKinds.push(body.edgeKinds[e] ?? 0);
      edgeRows.push(e);
    }
    // The triangles of the piece: those whose corners are all in it and none of whose sides has torn (a crack that does not part
    // the body leaves its triangles out, as a hole in the surface).
    const triangles = body.triangleList;
    for (let t = 0; t < triangles.length; t += 3) {
      const corner = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
      if (!corner.every((p) => local.has(p))) continue;
      let whole = true;
      for (let k = 0; k < 3 && whole; k++) {
        const key = Math.min(corner[k]!, corner[(k + 1) % 3]!) * n + Math.max(corner[k]!, corner[(k + 1) % 3]!);
        if (tornSide.has(key)) whole = false;
      }
      if (whole) desc.triangles.push(...corner.map((p) => local.get(p)!));
    }
    if (desc.triangles.length > 0) {
      desc.selfContacts = body.selfContacts;
      desc.selfFriction = body.selfFriction;
    }
    desc.tethers = body.tetherStretch;
    skinLimitsDesc(desc, body, members);
    const piece = soft.create(desc),
      after = soft.columns(),
      fem = soft.cellColumns(),
      structural = edgeRows.filter((e) => e < body.structural),
      ordered = [...structural, ...edgeRows.filter((e) => e >= body.structural)];
    ordered.forEach((e, k) => {
      after.rest[piece.firstEdge + k] = c.rest[body.firstEdge + e]!;
      fem.e_rest0![piece.firstEdge + k] = f.e_rest0![body.firstEdge + e]!;
    });
    members.forEach((p, k) => {
      const row = piece.firstParticle + k,
        old = body.firstParticle + p;
      after.vx[row] = c.vx[old]!;
      after.vy[row] = c.vy[old]!;
      after.vz[row] = c.vz[old]!;
      where.set(p, { body: piece, particle: k });
    });
    carryShape(
      soft,
      body,
      c,
      piece,
      members.map((p) => body.firstParticle + p),
    );
    carrySkinLimits(body, piece, members);
    pieces.push(piece);
    carryCutSurface(soft, body, piece);
  }
  soft.remove(body);
  return { pieces, destinations: (p) => (where.has(p) ? [where.get(p)!] : []) };
}

/**
 * Gives a piece with shape matching the rest offsets its particles had in the body, taken about the piece's own centre of mass (the
 * spring pulls each particle toward its place in the rest shape the body had, whole or part of it).
 */
function carryShape(
  soft: SoftBodies,
  body: SoftBody,
  c: Record<string, Float32Array>,
  piece: SoftBody,
  oldRows: number[],
): void {
  if (!body.matched) return;
  const after = soft.columns();
  let w = 0,
    x = 0,
    y = 0,
    z = 0;
  for (const old of oldRows) {
    w += c.sw![old]!;
    x += c.sw![old]! * c.rx![old]!;
    y += c.sw![old]! * c.ry![old]!;
    z += c.sw![old]! * c.rz![old]!;
  }
  oldRows.forEach((old, k) => {
    const row = piece.firstParticle + k;
    after.sw![row] = c.sw![old]!;
    after.rx![row] = c.rx![old]! - x / w;
    after.ry![row] = c.ry![old]! - y / w;
    after.rz![row] = c.rz![old]! - z / w;
  });
}

/**
 * The volume constraint of a closed surface goes to a piece of cells (its boundary is closed by construction): the same factor of the
 * volume the piece has at rest, the sum of its cells' rest volumes.
 */
function carryVolume(
  soft: SoftBodies,
  body: SoftBody,
  c: Record<string, Float32Array>,
  piece: SoftBody,
  desc: SoftBodyDesc,
  rest: number,
): void {
  if (!body.volumeOn || !(body.surfaceRest > 0) || desc.triangles.length === 0) return;
  const factor = c.vb_target![body.handle]! / body.surfaceRest;
  piece.surfaceRest = rest;
  piece.volumeOn = true;
  soft.setVolumeFactorOf(piece, factor);
}

/**
 * The skin goes to the pieces: each takes the vertices bound to its cells, with the cell numbers it has now, and the triangles whose
 * three corners it holds.
 */
function carrySkin(body: SoftBody, piece: SoftBody, desc: SoftBodyDesc, oldCells: number[]): void {
  const skin = body.skin;
  if (!skin) return;
  const cellOf = new Map(oldCells.map((old, k) => [old, k])),
    vertex = new Map<number, number>(),
    keep: number[] = [];
  for (let i = 0; i < skin.cell.length; i++)
    if (cellOf.has(skin.cell[i]!)) {
      vertex.set(i, keep.length);
      keep.push(i);
    }
  if (keep.length === 0) return;
  const indices: number[] = [];
  for (let t = 0; t < skin.indices.length; t += 3) {
    const corner = [skin.indices[t]!, skin.indices[t + 1]!, skin.indices[t + 2]!];
    if (corner.every((v) => vertex.has(v))) indices.push(...corner.map((v) => vertex.get(v)!));
  }
  piece.skin = {
    vertices: Float32Array.from(
      keep.flatMap((i) => [skin.vertices[i * 3]!, skin.vertices[i * 3 + 1]!, skin.vertices[i * 3 + 2]!]),
    ),
    indices: Uint32Array.from(indices),
    cell: Uint32Array.from(keep.map((i) => cellOf.get(skin.cell[i]!)!)),
    weight: Float32Array.from(keep.flatMap((i) => [0, 1, 2, 3].map((k) => skin.weight[i * 4 + k]!))),
  };
  piece.skinCells = Uint32Array.from(desc.cells);
}

/** What a piece copies from the body it was split from. */
export function carry(
  desc: SoftBodyDesc,
  body: SoftBody,
  c: ReturnType<SoftBodies['columns']>,
  rows: number[],
  local: Map<number, number>,
  masses: number[],
): void {
  desc.setMasses(masses);
  desc.setPinnedParticles(rows.map((row, k) => ((c.pflags[row]! & PINNED) !== 0 ? k : -1)).filter((k) => k >= 0));
  desc.setParticleRadius(c.radius[rows[0]!]!);
  desc.setGravityScale(c.gravity_scale[body.handle]!).setLinearDamping(c.linear_damping[body.handle]!);
  desc.setMaterial(body.material);
  desc.setCellMaterial(body.cellMaterial);
  desc.fiber = body.fiber;
  desc.orthotropy = body.orthotropy;
  desc.orthotropicStrength = body.orthotropicStrength;
  desc.crackBand = body.crackBand;
  desc.tensileNucleation = body.tensileNucleation;
  desc.coplanarToughness = body.coplanarToughness;
  desc.inheritedBand = desc.crackBand !== null;
  desc.groups = body.collisionGroups;
  desc.shapeMatching = body.matched;
  desc.solver = body.solverKind;
  void local;
}

function splitCells(
  soft: SoftBodies,
  body: SoftBody,
  make: (positions: number[]) => SoftBodyDesc,
  cut?: ReadonlySet<number>,
): SoftSplit | null {
  const c = snapshot(soft.columns()),
    f = snapshot(soft.cellColumns()),
    damage = soft.copyOrthotropicFailure(body),
    band = soft.copyCrackBand(body),
    { first, count } = body.cellRange,
    flags = f.flags as unknown as Uint32Array,
    at = (name: string): Float32Array => f[name]!,
    corner = (t: number, k: number): number => at(`p${k}`)[t]!,
    across = (t: number, k: number): number => at(`nb${k}`)[t]!,
    isAlive = (t: number): boolean => (flags[t]! & TORN) === 0;
  const cells: number[] = [];
  // A cell that tore is not dropped: it parts from every cell it was joined to and, with the torn cells it touches, goes on as a
  // piece of its own, so the volume and mass of the body are kept.
  for (let t = first; t < first + count; t++) cells.push(t);
  // A cell corner is a slot; corners that are the same particle and share a face the crack leaves whole are one virtual node.
  const slots = new Int32Array(count * 4).map((_, i) => i),
    part = Int32Array.from({ length: count }, (_, i) => i);
  for (const t of cells) {
    for (let k = 0; k < 4; k++) {
      const n = across(t, k);
      if (n === NONE || isAlive(t) !== isAlive(n)) continue;
      const opposite = [0, 1, 2, 3].find((j) => across(n, j) === t);
      if (cut?.has(t * 4 + k) || (opposite !== undefined && cut?.has(n * 4 + opposite))) continue;
      join(part, t - first, n - first);
      for (let j = 0; j < 4; j++) {
        if (j === k) continue;
        const p = corner(t, j);
        for (let j2 = 0; j2 < 4; j2++) if (corner(n, j2) === p) join(slots, (t - first) * 4 + j, (n - first) * 4 + j2);
      }
    }
  }
  const pieceOf = new Map<number, number>(),
    pieceIds: number[] = [];
  for (const t of cells) {
    const r = find(part, t - first);
    if (!pieceOf.has(r)) {
      pieceOf.set(r, pieceIds.length);
      pieceIds.push(r);
    }
  }
  const nodesOf = new Map<number, Set<number>>();
  for (const t of cells)
    for (let j = 0; j < 4; j++) {
      const p = corner(t, j),
        set = nodesOf.get(p) ?? new Set<number>();
      set.add(find(slots, (t - first) * 4 + j));
      nodesOf.set(p, set);
    }
  const cracked = [...nodesOf.values()].some((s) => s.size > 1);
  // One piece with no crack: the cells that tore are gone from it and it carries on as it is.
  if ((pieceIds.length <= 1 && !cracked) || cells.length === 0) return null;
  // The share of a particle's mass each node of it takes: by the rest volume of the cells that meet at the node.
  const volume = new Map<number, number>(),
    nodeVolume = new Map<number, number>();
  for (const t of cells)
    for (let j = 0; j < 4; j++) {
      const density = body.cellMaterials?.[t - first]?.density ?? 1;
      const share = (at('vol0')[t]! * density) / 4;
      volume.set(corner(t, j), (volume.get(corner(t, j)) ?? 0) + share);
      const node = find(slots, (t - first) * 4 + j);
      nodeVolume.set(node, (nodeVolume.get(node) ?? 0) + share);
    }
  const pieces: SoftBody[] = [],
    where = new Map<number, SoftDestination[]>();
  for (const root of pieceIds) {
    const mine = cells.filter((t) => find(part, t - first) === root),
      nodeIndex = new Map<number, number>(),
      origin: number[] = [];
    for (const t of mine)
      for (let j = 0; j < 4; j++) {
        const node = find(slots, (t - first) * 4 + j);
        if (!nodeIndex.has(node)) {
          nodeIndex.set(node, origin.length);
          origin.push(corner(t, j));
        }
      }
    const rows = origin,
      nodeOf = [...nodeIndex.keys()],
      masses = origin.map((p, k) => {
        const total = body.masses[p - body.firstParticle]!,
          share = nodeVolume.get(nodeOf[k]!)! / (volume.get(p) || 1);
        return Math.max(total * share, total * 1e-6);
      }),
      desc = make(origin.flatMap((p) => [c.x[p]!, c.y[p]!, c.z[p]!]));
    carry(desc, body, c, rows, nodeIndex, masses);
    desc.massGiven = true;
    desc.cells = mine.flatMap((t) => [0, 1, 2, 3].map((j) => nodeIndex.get(find(slots, (t - first) * 4 + j))!));
    if (body.cellMaterials) desc.setCellMaterials(mine.map((row) => body.cellMaterials![row - first]!));
    // The piece's surface: its own boundary faces, the faces along the crack among them.
    if (body.triangleList.length > 0 || body.surface) {
      desc.triangles = boundaryTriangles(
        desc.cells,
        origin.flatMap((p) => [c.x[p]!, c.y[p]!, c.z[p]!]),
      );
      desc.selfContacts = body.selfContacts && desc.triangles.length > 0;
      desc.selfFriction = body.selfFriction;
    }
    desc.tethers = body.tetherStretch;
    skinLimitsDesc(
      desc,
      body,
      origin.map((p) => p - body.firstParticle),
    );
    // Edges: each edge of the body goes to the node pair the cells that hold both of its ends use.
    const byParticle = new Map<number, number[]>();
    for (const t of mine)
      for (let j = 0; j < 4; j++) byParticle.set(corner(t, j), [...(byParticle.get(corner(t, j)) ?? []), t]);
    const edgeRows: number[] = [],
      seen = new Set<string>(),
      pairsStructural: number[] = [],
      pairsBend: number[] = [];
    for (let e = 0; e < body.edgeTotal; e++) {
      if ((c.eflags[body.firstEdge + e]! & TORN) !== 0) continue;
      const a = c.ea[body.firstEdge + e]!,
        b = c.eb[body.firstEdge + e]!;
      for (const t of byParticle.get(a) ?? []) {
        const ja = [0, 1, 2, 3].find((j) => corner(t, j) === a),
          jb = [0, 1, 2, 3].find((j) => corner(t, j) === b);
        if (ja === undefined || jb === undefined) continue;
        const na = nodeIndex.get(find(slots, (t - first) * 4 + ja))!,
          nb = nodeIndex.get(find(slots, (t - first) * 4 + jb))!,
          key = `${e}:${na}:${nb}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (e < body.structural ? pairsStructural : pairsBend).push(na, nb);
        edgeRows.push(e);
      }
    }
    desc.edgePairs = pairsStructural;
    desc.bendPairs = pairsBend;
    const ordered = [...edgeRows.filter((e) => e < body.structural), ...edgeRows.filter((e) => e >= body.structural)],
      piece = soft.create(desc),
      after = soft.columns(),
      fem = soft.cellColumns();
    // Everything a cell and an edge remember of its past goes with it.
    const names = [
      ...[0, 1, 2, 3].map((k) => `p${k}`),
      ...Array.from({ length: 9 }, (_, k) => `b${k}`),
      ...Array.from({ length: 9 }, (_, k) => `o${k}`),
      'vol0',
      'flowed',
      'load',
    ];
    mine.forEach((t, i) => {
      const row = piece.cellRange.first + i;
      fem.flags![row] = fem.flags![row]! | (flags[t]! & (NUCLEATED_CELL | CRACK_FRONT_MASK));
      if (damage) soft.restoreOrthotropicFailure(row, damage, t - first);
      if (band) soft.restoreCrackBand(row, band, t - first);
      for (const name of names) {
        if (/^p\d$/.test(name)) {
          const k = Number(name[1]),
            local = nodeIndex.get(find(slots, (t - first) * 4 + k))!;
          fem[name]![row] = piece.firstParticle + local;
        } else fem[name]![row] = at(name)[t]!;
      }
    });
    soft.relinkCells(piece);
    ordered.forEach((e, k) => {
      after.rest[piece.firstEdge + k] = c.rest[body.firstEdge + e]!;
      fem.e_rest0![piece.firstEdge + k] = at('e_rest0')[body.firstEdge + e]!;
    });
    origin.forEach((p, k) => {
      const row = piece.firstParticle + k;
      after.vx[row] = c.vx[p]!;
      after.vy[row] = c.vy[p]!;
      after.vz[row] = c.vz[p]!;
      const list = where.get(p - body.firstParticle) ?? [];
      list.push({ body: piece, particle: k });
      where.set(p - body.firstParticle, list);
    });
    carryShape(soft, body, c, piece, origin);
    carryVolume(
      soft,
      body,
      c,
      piece,
      desc,
      mine.reduce((sum, t) => sum + f.vol0![t]!, 0),
    );
    carrySkin(
      body,
      piece,
      desc,
      mine.map((t) => t - first),
    );
    carrySkinLimits(
      body,
      piece,
      origin.map((p) => p - body.firstParticle),
    );
    pieces.push(piece);
    carryCutSurface(soft, body, piece);
  }
  soft.remove(body);
  return { pieces, destinations: (p) => where.get(p) ?? [] };
}

/** Whether the triangle `face` meets the triangle `blade`. */
export function crossesBlade(
  face: readonly (readonly [number, number, number])[],
  blade: readonly (readonly [number, number, number])[],
): boolean {
  // Two triangles meet when an edge of one pierces the other (Moller and Trumbore, "Fast, Minimum Storage Ray-Triangle
  // Intersection", J. Graphics Tools 2(1), 1997, for a segment).
  const sub = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    a[0]! - b[0]!,
    a[1]! - b[1]!,
    a[2]! - b[2]!,
  ];
  const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ];
  const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const pierces = (p: readonly number[], q: readonly number[], tri: readonly (readonly number[])[]): boolean => {
    const dir = sub(q, p),
      e1 = sub(tri[1]!, tri[0]!),
      e2 = sub(tri[2]!, tri[0]!),
      h = cross(dir, e2),
      a = dot(e1, h);
    if (Math.abs(a) < 1e-14) return false;
    const s = sub(p, tri[0]!),
      u = dot(s, h) / a;
    if (u < 0 || u > 1) return false;
    const qv = cross(s, e1),
      v = dot(dir, qv) / a;
    if (v < 0 || u + v > 1) return false;
    const t = dot(e2, qv) / a;
    return t >= 0 && t <= 1;
  };
  for (let i = 0; i < 3; i++) {
    if (pierces(face[i]!, face[(i + 1) % 3]!, blade)) return true;
    if (pierces(blade[i]!, blade[(i + 1) % 3]!, face)) return true;
  }
  return false;
}

/** A piece of a skinned body keeps its particles' limits. */
export function skinLimitsDesc(desc: SoftBodyDesc, body: SoftBody, members: readonly number[]): void {
  if (!body.skinMax) return;
  const max = body.skinMax,
    back = body.skinBack;
  desc.skinMax = Float32Array.from(members, (p) => max[p]!);
  desc.skinBack = back && Float32Array.from(members, (p) => back[p]!);
}

/** ...and where the skin holds them, its normals there and which of them the skin pinned. */
export function carrySkinLimits(body: SoftBody, piece: SoftBody, members: readonly number[]): void {
  if (!body.skinMax || !piece.skinMax) return;
  members.forEach((p, k) => {
    for (let a = 0; a < 3; a++) {
      piece.skinFrom[3 * k + a] = body.skinFrom[3 * p + a]!;
      piece.skinTo[3 * k + a] = body.skinTo[3 * p + a]!;
      piece.skinNormal[3 * k + a] = body.skinNormal[3 * p + a]!;
    }
    piece.skinPins[k] = body.skinPins[p]!;
  });
}
