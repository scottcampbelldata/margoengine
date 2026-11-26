// Commit a planned plane cut while carrying the material law, plastic rest basis,
// and each fragment's share of the original nodal mass and momentum.
import { MargoError } from '@margoengine/math/errors';
import type { Vec3 } from './math.js';
import { faceKey, type SliceCell, type SlicePlan, type SlicePoint, TETRA_EDGES } from './soft-plane-cut.js';
import { carryCutSurface, type SoftDestination, type SoftSplit } from './soft-split.js';
import { CRACK_FRONT_MASK, CRACK_FRONT_SHIFT, NUCLEATED_CELL } from './soft-tensile-seam.js';
import { MIN_TET_DETERMINANT, tetDeterminant } from './soft-volume.js';
import type { SoftBodies, SoftBody, SoftBodyDesc } from './soft.js';

type NodeState = {
  oldParticle: number | null;
  position: Vec3;
  previous: Vec3;
  velocity: Vec3;
  target: Vec3 | null;
  force: Vec3 | null;
};

const PARTICLE_PINNED = 1;
const PARTICLE_TARGETED = 2;
const MATRIX_ENTRIES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
const AXES = [0, 1, 2] as const;
const blend = (from: number, to: number, weight: number): number => (1 - weight) * from + weight * to;
const vecOf = (at: (axis: 0 | 1 | 2) => number): Vec3 => [at(0), at(1), at(2)];

function childBasis(cell: SliceCell, state: Record<string, Float32Array>, row: number, key: string): number[] {
  const parentBasis = MATRIX_ENTRIES.map((i) => state[`${key}${i}`]![row]!);
  const inverse = cell.inverse;
  if (!inverse) return parentBasis;
  const basis = MATRIX_ENTRIES.map((i) => {
    const r = inverse[Math.floor(i / 3)]!;
    const c = i % 3;
    return Math.fround(r[0] * parentBasis[c]! + r[1] * parentBasis[c + 3]! + r[2] * parentBasis[c + 6]!);
  });
  return basis;
}

/** A front edge is material data: a cut can subdivide it without moving it off its original material endpoints. */
function cutFrontFlags(plan: SlicePlan, cell: SliceCell, oldCells: Uint32Array, flags: number): number {
  const { crackFront, points, releasedFront } = plan;
  if (!crackFront?.size && (flags & CRACK_FRONT_MASK) === 0) return 0;
  const at = (corner: number): number => oldCells[4 * cell.parent + corner]!;
  // Once the lips split this material edge, none of its incident cells has an active segment there.
  const previousEdges = TETRA_EDGES.filter(
    ([a, b], i) =>
      (flags & (1 << (CRACK_FRONT_SHIFT + i))) !== 0 &&
      !(releasedFront?.includes(at(a)) && releasedFront.includes(at(b))),
  );
  const belongs = (point: SlicePoint, a: number, b: number): boolean => {
    const onEdge = (p: number): boolean => p === a || p === b;
    return point.vertices
      ? point.vertices.every(([p, weight]) => weight === 0 || onEdge(p))
      : onEdge(point.first) && (point.weight === 0 || onEdge(point.second));
  };
  let transferred = 0;
  TETRA_EDGES.forEach(([a, b], i) => {
    const u = points[cell.nodes[a]]!;
    const v = points[cell.nodes[b]]!;
    const fresh = crackFront?.has(faceKey([cell.nodes[a], cell.nodes[b]]));
    if (fresh || previousEdges.some(([a, b]) => belongs(u, at(a), at(b)) && belongs(v, at(a), at(b))))
      transferred |= 1 << (CRACK_FRONT_SHIFT + i);
  });
  return transferred;
}

export function makeCutPieces(
  soft: SoftBodies,
  body: SoftBody,
  make: (positions: number[]) => SoftBodyDesc,
  planCut: (current: Float32Array, cells: Uint32Array) => SlicePlan | null,
  crackedCell?: number,
  automatic = false,
): SoftSplit | null {
  const current = body.particlePositions();
  const oldCells = body.cells();
  const plan = planCut(current, oldCells);
  if (!plan) return null;
  const old = soft.columns();
  const fem = soft.cellColumns();
  const oldBodyParticle = body.firstParticle;
  const oldBodyCell = body.cellRange.first;
  const support = new Float64Array(body.particles);
  oldCells.forEach((p, i) => {
    const cell = Math.floor(i / 4);
    const volume = fem.vol0![oldBodyCell + cell]!;
    support[p] = support[p]! + volume * (body.cellMaterials?.[cell]?.density ?? 1);
  });
  if (support.some((volume) => volume <= 0))
    throw new MargoError(
      'state',
      'Some particles have no tetrahedra. Build a fully tetrahedralized solid or use a face cut.',
    );

  const at = (p: number): number => oldBodyParticle + p;
  const interpolate = (
    point: SlicePoint,
    cols: readonly [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>],
  ): Vec3 => {
    const { first, second, weight, vertices } = point;
    if (vertices)
      return vecOf((axis) => vertices.reduce((value, [p, fraction]) => value + fraction * cols[axis][at(p)]!, 0));
    return vecOf((axis) => blend(cols[axis][at(first)]!, cols[axis][at(second)]!, weight));
  };
  const volumeFactor = body.volumeOn ? old.vb_target![body.handle]! / body.surfaceRest : null;
  const fiber = body.fiber;
  const orthotropy = body.orthotropy;
  const strength = body.orthotropicStrength;
  const damage = soft.copyOrthotropicFailure(body);
  const band = soft.copyCrackBand(body);
  const bandLimits = body.crackBand;
  const externalForce = body.force;
  const velocity = [old.vx, old.vy, old.vz] as const;
  const positions = [old.x, old.y, old.z] as const;
  const targets = [old.tx, old.ty, old.tz] as const;
  const prepared = [];
  for (const cells of plan.pieces) {
    const nodes = [...new Set(cells.flatMap(({ nodes }) => nodes))];
    const index = new Map(nodes.map((p, i) => [p, i]));
    const rest = nodes.flatMap((node) => interpolate(plan.points[node]!, [old.rx!, old.ry!, old.rz!]).map(Math.fround));
    if (
      automatic &&
      cells.some(
        ({ nodes: [a, b, c, d] }) =>
          !(
            Math.abs(tetDeterminant(rest, index.get(a)!, index.get(b)!, index.get(c)!, index.get(d)!)) >
            MIN_TET_DETERMINANT
          ),
      )
    )
      return null;
    const masses = new Float64Array(nodes.length);
    const momenta = new Float64Array(nodes.length * 3);
    const forces = body.pointForces.size > 0 ? new Float64Array(nodes.length * 3) : null;
    let restVolume = 0;
    const history = cells.map((cell) => {
      const row = oldBodyCell + cell.parent;
      const volume = cell.fraction * fem.vol0![row]!;
      restVolume += volume;
      const density = body.cellMaterials?.[cell.parent]?.density ?? 1;
      for (const node of cell.nodes) {
        const point = plan.points[node]!;
        const contribute = (p: number, weight: number): void => {
          const local = index.get(node)!;
          // A child's 1/4-volume lumping integrates every linear parent shape function exactly.
          const share = (weight * volume * density) / support[p]!;
          const mass = share * body.masses[p]!;
          masses[local] = masses[local]! + mass;
          for (const axis of AXES)
            momenta[3 * local + axis] = momenta[3 * local + axis]! + mass * velocity[axis]![at(p)]!;
          const force = forces && body.pointForces.get(p);
          if (forces && force)
            for (const axis of AXES) forces[3 * local + axis] = forces[3 * local + axis]! + share * force[axis];
        };
        if (point.vertices) {
          for (const [particle, weight] of point.vertices) contribute(particle, weight);
        } else {
          contribute(point.first, 1 - point.weight);
          if (point.weight > 0) contribute(point.second, point.weight);
        }
      }
      const flags = fem.flags![row]!;
      const fractured = cell.parent === crackedCell || (flags & NUCLEATED_CELL) !== 0;
      return {
        nodes: cell.nodes.map((node) => index.get(node)!),
        volume,
        restBasis: childBasis(cell, fem, row, 'b'),
        initialBasis: childBasis(cell, fem, row, 'o'),
        flowed: fem.flowed![row]!,
        load: fem.load![row]!,
        fractureFlags: fractured ? NUCLEATED_CELL : cutFrontFlags(plan, cell, oldCells, flags),
        parent: cell.parent,
      };
    });
    if (
      history.some(
        ({ restBasis, initialBasis }) => !restBasis.every(Number.isFinite) || !initialBasis.every(Number.isFinite),
      )
    ) {
      if (automatic) return null;
      throw new MargoError(
        'failed',
        'The cut creates an unrepresentable rest basis. Move it away from a vertex or edge.',
      );
    }
    if (
      masses.some(
        (mass) =>
          !Number.isFinite(Math.fround(mass)) ||
          !(Math.fround(1 / mass) > 0) ||
          !Number.isFinite(Math.fround(1 / mass)),
      )
    ) {
      if (automatic) return null;
      throw new MargoError(
        'failed',
        'The cut creates an unrepresentable fragment mass. Move the plane away from a vertex or edge.',
      );
    }
    const desc = make(rest);
    desc.setCells(
      history.flatMap(({ nodes }) => nodes),
      body.cellMaterial,
    );
    if (body.cellMaterials) desc.setCellMaterials(history.map(({ parent }) => body.cellMaterials![parent]!));
    if (body.triangleList.length > 0 || body.surface) desc.setSurface();
    desc.setMasses(masses);
    desc.setMaterial(body.material);
    desc.setParticleRadius(old.radius[oldBodyParticle]!);
    desc.setGravityScale(old.gravity_scale[body.handle]!).setLinearDamping(old.linear_damping[body.handle]!);
    desc.fiber = fiber;
    desc.orthotropy = orthotropy;
    desc.orthotropicStrength = strength;
    desc.crackBand = bandLimits;
    desc.tensileNucleation = body.tensileNucleation;
    desc.coplanarToughness = body.coplanarToughness;
    desc.inheritedBand = bandLimits !== null;
    desc.groups = body.collisionGroups;
    desc.shapeMatching = body.matched;
    desc.dominance = body.dominance;
    desc.canSleep = body.canSleepFlag;
    desc.additionalIterations = body.additionalIterations;
    desc.airDrag = body.airDrag;
    desc.selfContacts = body.selfContacts;
    desc.selfFriction = body.selfFriction;
    desc.oriented = body.oriented;
    desc.solver = body.solverKind;
    const state = nodes.map((node, i): NodeState => {
      const point = plan.points[node]!;
      const { first, second, weight, vertices } = point;
      const flags = (p: number): number => old.pflags[at(p)]!;
      const pinned = vertices
        ? vertices.every(([p]) => (flags(p) & PARTICLE_PINNED) !== 0)
        : (flags(first) & flags(second) & PARTICLE_PINNED) !== 0;
      if (pinned) desc.pinned.add(i);
      const goal = (p: number, axis: number): number => {
        const row = at(p);
        const native = (old.pflags[row]! & PARTICLE_TARGETED) !== 0 ? targets : positions;
        return native[axis]![row]!;
      };
      const targeted = vertices
        ? vertices.some(([p]) => (flags(p) & PARTICLE_TARGETED) !== 0)
        : ((flags(first) | flags(second)) & PARTICLE_TARGETED) !== 0;
      const target =
        pinned && targeted
          ? vecOf((axis) =>
              vertices
                ? vertices.reduce((value, [p, fraction]) => value + fraction * goal(p, axis), 0)
                : blend(goal(first, axis), goal(second, axis), weight),
            )
          : null;
      return {
        oldParticle: !vertices && first === second ? first : null,
        position: interpolate(point, positions),
        previous: interpolate(point, [old.px, old.py, old.pz]),
        velocity: vecOf((axis) => momenta[3 * i + axis]! / masses[i]!),
        target,
        force: forces && [forces[3 * i]!, forces[3 * i + 1]!, forces[3 * i + 2]!],
      };
    });
    prepared.push({ desc, history, state, restVolume });
  }

  const totalMass = body.mass();
  const where = new Map<number, SoftDestination[]>();
  const pieces = prepared.map(({ desc, history, state, restVolume }) => {
    const piece = soft.create(desc);
    const c = soft.columns();
    const f = soft.cellColumns();
    history.forEach((data, i) => {
      const row = piece.cellRange.first + i;
      data.nodes.forEach((node, i) => {
        f[`p${i}`]![row] = piece.firstParticle + node;
      });
      MATRIX_ENTRIES.forEach((i) => {
        f[`b${i}`]![row] = data.restBasis[i]!;
        f[`o${i}`]![row] = data.initialBasis[i]!;
      });
      f.vol0![row] = data.volume;
      f.flowed![row] = data.flowed;
      f.load![row] = data.load;
      f.flags![row] = f.flags![row]! | data.fractureFlags;
      if (damage) soft.restoreOrthotropicFailure(row, damage, data.parent);
      if (band) soft.restoreCrackBand(row, band, data.parent);
    });
    soft.relinkCells(piece);
    const massShare = piece.mass() / totalMass;
    piece.force = vecOf((axis) => externalForce[axis] * massShare);
    state.forEach(({ oldParticle, position, previous, velocity, target, force }, particle) => {
      const row = piece.firstParticle + particle;
      [c.x[row], c.y[row], c.z[row]] = position;
      [c.px[row], c.py[row], c.pz[row]] = previous;
      [c.vx[row], c.vy[row], c.vz[row]] = velocity;
      piece.previous.set(previous, particle * 3);
      if (target) {
        [c.tx[row], c.ty[row], c.tz[row]] = target;
        c.pflags[row] = c.pflags[row]! | PARTICLE_TARGETED;
      }
      if (force?.some((component) => component !== 0)) piece.pointForces.set(particle, force);
      if (oldParticle !== null) {
        const list = where.get(oldParticle) ?? [];
        list.push({ body: piece, particle });
        where.set(oldParticle, list);
      }
    });
    if (volumeFactor !== null) {
      piece.surfaceRest = restVolume;
      piece.volumeOn = true;
      soft.setVolumeFactorOf(piece, volumeFactor);
    }
    return piece;
  });
  if (body.surface) {
    try {
      for (const piece of pieces) carryCutSurface(soft, body, piece);
    } catch (error) {
      // Keep the original query surface and its body alive if a replacement could not be made.
      for (const piece of pieces.reverse()) soft.remove(piece);
      throw error;
    }
  }
  soft.remove(body);
  return { pieces, destinations: (particle) => where.get(particle) ?? [] };
}
