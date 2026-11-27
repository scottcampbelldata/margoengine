// Built-in debug wireframe overlay for @margoengine/physics/breakable.
// Returns { vertices, colors } line segments compatible with @margoengine/lines and physics.debugRender().
import type { DebugColor, DebugLines } from '../debug.js';
import { rotateVec, type Quat, type Vec3 } from '../math.js';
import type { BreakableBond } from './graph.js';
import type { BreakableCell, BreakablePolyhedron } from './polyhedron.js';

/** Custom colour and size overrides for {@link BreakableDebugRenderOptions.style}. */
export interface BreakableDebugStyle {
  /** Unfractured Voronoi cell seam colour (default `[0.35, 0.85, 0.95, 0.75]`). */
  cell?: DebugColor;
  /** Undamaged bond colour at health = 1 (default `[0.2, 0.92, 0.35, 1]`). */
  bondHealthy?: DebugColor;
  /** Half-damaged bond colour at health = 0.5 (default `[0.98, 0.86, 0.18, 1]`). */
  bondDamaged?: DebugColor;
  /** Near-failure bond colour at health -> 0 (default `[0.96, 0.22, 0.16, 1]`). */
  bondCritical?: DebugColor;
  /** Grounded/support anchor pin colour (default `[0.25, 0.65, 1, 1]`). */
  anchor?: DebugColor;
  /** Active (awake) debris outline colour (default `[1, 0.55, 0.15, 1]`). */
  debrisActive?: DebugColor;
  /** Sleeping debris outline colour (default `[0.45, 0.52, 0.58, 0.75]`). */
  debrisSleeping?: DebugColor;
  /** Half-size of anchor pin markers in metres (default `0.08`). */
  anchorPinSize?: number;
}

/** Options controlling which overlays {@link BreakableWorld.debugRender} emits. */
export interface BreakableDebugRenderOptions {
  /** Draw unfractured cell seams on intact and surviving islands (default `true`). */
  cells?: boolean;
  /** Draw connection-graph bonds coloured by health green -> yellow -> red (default `true`). */
  bonds?: boolean;
  /** Draw anchor pins on grounded/supported chunks (default `true`). */
  anchors?: boolean;
  /** Draw active vs sleeping debris fragment wireframes (default `true`). */
  debris?: boolean;
  /** Optional colour and pin-size overrides. */
  style?: BreakableDebugStyle;
}

/** Internal read-only snapshot of an island needed by the debug line builder. */
export interface DebugIslandView {
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly originOffset: Vec3;
  readonly cellIndices: readonly number[];
  readonly isDebris: boolean;
  readonly sleeping: boolean;
}

/** Internal read-only snapshot of a breakable body needed by the debug line builder. */
export interface DebugBodyView {
  readonly basePolyhedron: BreakablePolyhedron;
  readonly cells: readonly BreakableCell[];
  readonly bonds: readonly BreakableBond[];
  readonly anchoredFlags: Uint8Array;
  readonly islands: readonly DebugIslandView[];
  readonly intactPose: { position: Vec3; rotation: Quat } | null;
}

const DEFAULT_CELL: DebugColor = [0.35, 0.85, 0.95, 0.75];
const DEFAULT_HEALTHY: DebugColor = [0.2, 0.92, 0.35, 1];
const DEFAULT_DAMAGED: DebugColor = [0.98, 0.86, 0.18, 1];
const DEFAULT_CRITICAL: DebugColor = [0.96, 0.22, 0.16, 1];
const DEFAULT_ANCHOR: DebugColor = [0.25, 0.65, 1, 1];
const DEFAULT_DEBRIS_ACTIVE: DebugColor = [1, 0.55, 0.15, 1];
const DEFAULT_DEBRIS_SLEEPING: DebugColor = [0.45, 0.52, 0.58, 0.75];

function lerpColor(a: DebugColor, b: DebugColor, t: number): DebugColor {
  const s = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + (b[3] - a[3]) * s];
}

function bondHealthColor(health: number, healthy: DebugColor, damaged: DebugColor, critical: DebugColor): DebugColor {
  const h = Math.min(1, Math.max(0, health));
  if (h >= 0.5) return lerpColor(damaged, healthy, (h - 0.5) * 2);
  return lerpColor(critical, damaged, h * 2);
}

function toWorld(local: Vec3, islandPos: Vec3, islandRot: Quat, originOffset: Vec3): [number, number, number] {
  const rel: [number, number, number] = [
    local[0] - originOffset[0],
    local[1] - originOffset[1],
    local[2] - originOffset[2],
  ];
  const r = rotateVec(islandRot, rel);
  return [islandPos[0] + r[0], islandPos[1] + r[1], islandPos[2] + r[2]];
}

class LineAccumulator {
  readonly positions: number[] = [];
  readonly colors: number[] = [];

  segment(a: Vec3, b: Vec3, color: DebugColor): void {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    this.colors.push(color[0], color[1], color[2], color[3], color[0], color[1], color[2], color[3]);
  }

  finish(): DebugLines {
    return {
      vertices: new Float32Array(this.positions),
      colors: new Float32Array(this.colors),
    };
  }
}

function drawAnchorPin(out: LineAccumulator, center: Vec3, size: number, color: DebugColor): void {
  const [x, y, z] = center;
  const top: Vec3 = [x, y + size, z];
  const bottom: Vec3 = [x, y - size, z];
  const px: Vec3 = [x + size, y, z];
  const nx: Vec3 = [x - size, y, z];
  const pz: Vec3 = [x, y, z + size];
  const nz: Vec3 = [x, y, z - size];
  // Octahedron diamond marker + downward pin stem.
  out.segment(top, px, color);
  out.segment(top, nx, color);
  out.segment(top, pz, color);
  out.segment(top, nz, color);
  out.segment(bottom, px, color);
  out.segment(bottom, nx, color);
  out.segment(bottom, pz, color);
  out.segment(bottom, nz, color);
  out.segment(px, pz, color);
  out.segment(pz, nx, color);
  out.segment(nx, nz, color);
  out.segment(nz, px, color);
  out.segment(bottom, [x, y - size * 2.2, z], color);
}

function drawPolyhedronEdges(
  out: LineAccumulator,
  poly: BreakablePolyhedron,
  pos: Vec3,
  rot: Quat,
  color: DebugColor,
): void {
  const n = poly.vertices.length;
  const seen = new Set<number>();
  for (let f = 0; f < poly.faces.length; f++) {
    const loop = poly.faces[f]!.indices;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      const va = toWorld(poly.vertices[lo]!, pos, rot, [0, 0, 0]);
      const vb = toWorld(poly.vertices[hi]!, pos, rot, [0, 0, 0]);
      out.segment(va, vb, color);
    }
  }
}

function drawCellWireframe(
  out: LineAccumulator,
  cell: BreakableCell,
  pos: Vec3,
  rot: Quat,
  originOffset: Vec3,
  color: DebugColor,
): void {
  const verts = cell.polyhedron.vertices;
  const edges = cell.edges;
  for (let i = 0; i < edges.length; i += 2) {
    const a = verts[edges[i]!]!;
    const b = verts[edges[i + 1]!]!;
    out.segment(toWorld(a, pos, rot, originOffset), toWorld(b, pos, rot, originOffset), color);
  }
}

/** Builds debug line segments for every breakable body and debris fragment. */
export function buildBreakableDebugLines(
  bodies: readonly DebugBodyView[],
  options: BreakableDebugRenderOptions = {},
): DebugLines {
  const { cells = true, bonds = true, anchors = true, debris = true, style = {} } = options;
  const cellColor = style.cell ?? DEFAULT_CELL;
  const healthyColor = style.bondHealthy ?? DEFAULT_HEALTHY;
  const damagedColor = style.bondDamaged ?? DEFAULT_DAMAGED;
  const criticalColor = style.bondCritical ?? DEFAULT_CRITICAL;
  const anchorColor = style.anchor ?? DEFAULT_ANCHOR;
  const debrisActiveColor = style.debrisActive ?? DEFAULT_DEBRIS_ACTIVE;
  const debrisSleepingColor = style.debrisSleeping ?? DEFAULT_DEBRIS_SLEEPING;
  const pinSize = style.anchorPinSize ?? 0.08;

  const out = new LineAccumulator();

  for (let b = 0; b < bodies.length; b++) {
    const body = bodies[b]!;
    if (body.cells.length === 0) {
      // Unfractured impact-mode body: draw its base polyhedron outline when cell overlay is enabled.
      if (cells && body.intactPose) {
        drawPolyhedronEdges(out, body.basePolyhedron, body.intactPose.position, body.intactPose.rotation, cellColor);
      }
      continue;
    }

    // Map each cell index to the live island currently carrying it.
    const cellIsland = new Map<number, DebugIslandView>();
    for (let i = 0; i < body.islands.length; i++) {
      const island = body.islands[i]!;
      for (let k = 0; k < island.cellIndices.length; k++) {
        const cellIdx = island.cellIndices[k]!;
        cellIsland.set(cellIdx, island);
        const cell = body.cells[cellIdx]!;
        if (island.isDebris) {
          if (debris) {
            drawCellWireframe(
              out,
              cell,
              island.position,
              island.rotation,
              island.originOffset,
              island.sleeping ? debrisSleepingColor : debrisActiveColor,
            );
          }
        } else {
          if (cells) {
            drawCellWireframe(out, cell, island.position, island.rotation, island.originOffset, cellColor);
          }
          if (anchors && body.anchoredFlags[cellIdx]) {
            const worldCenter = toWorld(cell.centroid, island.position, island.rotation, island.originOffset);
            drawAnchorPin(out, worldCenter, pinSize, anchorColor);
          }
        }
      }
    }

    if (bonds) {
      for (let i = 0; i < body.bonds.length; i++) {
        const bond = body.bonds[i]!;
        if (bond.broken) continue;
        const islandA = cellIsland.get(bond.cellA);
        const islandB = cellIsland.get(bond.cellB);
        if (!islandA || islandA !== islandB) continue;
        const cellA = body.cells[bond.cellA]!;
        const cellB = body.cells[bond.cellB]!;
        const pA = toWorld(cellA.centroid, islandA.position, islandA.rotation, islandA.originOffset);
        const pB = toWorld(cellB.centroid, islandA.position, islandA.rotation, islandA.originOffset);
        out.segment(pA, pB, bondHealthColor(bond.health, healthyColor, damagedColor, criticalColor));
      }
    }
  }

  return out.finish();
}
