// Debug draw: a navmesh, routes and agents as line segments. The `*Lines` functions give plain arrays and need no GPU, so
// they run in Node and in tests; NavDebug feeds them to `@margoengine/lines`.
import { Line, type Lines } from '@margoengine/lines';
import type { Crowd, CrowdAgent, CrowdAgentState } from './crowd.js';
import type { NavLink, NavMesh, NavRoute, Vec3 } from './index.js';
import type { TiledNavMesh } from './tiles.js';

/** Red, green, blue, each 0 to 1 in linear colour. */
export type NavDebugColor = readonly [number, number, number];

/** Line segments: `positions` holds x, y, z per point, `colors` r, g, b, a per point, in pairs. */
export interface NavDebugLines {
  positions: Float32Array;
  colors: Float32Array;
}

/** Colours of {@link meshLines}, {@link routeLines} and {@link crowdLines}. */
export interface NavDebugColors {
  /** Edges between polygons of a mesh. */
  inner?: NavDebugColor;
  /** Edges with nothing beyond them, tile lines among them. */
  outline?: NavDebugColor;
  /** Off-mesh links. */
  link?: NavDebugColor;
  /** Routes, and the rest of an agent's route. */
  route?: NavDebugColor;
  /** Agents by state. */
  agents?: Partial<Record<CrowdAgentState, NavDebugColor>>;
}

/** Options of {@link meshLines}, {@link routeLines} and {@link crowdLines}. */
export interface NavDebugOptions {
  /** Lifts everything off the ground, so lines do not fight with it. World units. Default 0.05. */
  lift?: number;
  /** Colours, over the defaults. */
  colors?: NavDebugColors;
}

const INNER: NavDebugColor = [0.1, 0.45, 0.5];
const OUTLINE: NavDebugColor = [0.2, 0.9, 1];
const LINK: NavDebugColor = [1, 0.7, 0.1];
const ROUTE: NavDebugColor = [1, 0.95, 0.3];
const STATES: Record<CrowdAgentState, NavDebugColor> = {
  idle: [0.6, 0.6, 0.6],
  moving: [0.2, 1, 0.3],
  offmesh: [1, 0.7, 0.1],
  arrived: [0.3, 0.5, 1],
  unreachable: [1, 0.15, 0.1],
};
/** Segments in an off-mesh link's arc and in an agent's ring. */
const ARC = 8;
const RING = 16;

/** Collects segments. */
class Segments {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  constructor(private readonly lift: number) {}
  add(a: ArrayLike<number>, b: ArrayLike<number>, color: NavDebugColor): void {
    this.positions.push(a[0], a[1] + this.lift, a[2], b[0], b[1] + this.lift, b[2]);
    this.colors.push(color[0], color[1], color[2], 1, color[0], color[1], color[2], 1);
  }
  finish(): NavDebugLines {
    return { positions: new Float32Array(this.positions), colors: new Float32Array(this.colors) };
  }
}

function lifted(options: NavDebugOptions | undefined): number {
  const lift = options?.lift ?? 0.05;
  if (!Number.isFinite(lift)) throw new RangeError('Debug lift must be finite; pass a height.');
  return lift;
}

/** Is the edge from `a` to `b` a portal among `links`? */
function isPortal(links: readonly NavLink[], a: Vec3, b: Vec3): boolean {
  const same = (p: Vec3, q: Vec3) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  return links.some(
    ({ offMesh, left, right }) =>
      offMesh === undefined && ((same(left, a) && same(right, b)) || (same(left, b) && same(right, a))),
  );
}

function drawMesh(out: Segments, mesh: NavMesh, inner: NavDebugColor, outline: NavDebugColor): void {
  for (let p = 0; p < mesh.polygonCount; p++) {
    const vertices = mesh.polygonVertices(p),
      links = mesh.polygonLinks(p);
    for (let i = 0; i < vertices.length; i++) {
      const a = mesh.vertices[vertices[i]],
        b = mesh.vertices[vertices[(i + 1) % vertices.length]];
      if (!isPortal(links, a, b)) out.add(a, b, outline);
      // A shared edge is held by two polygons: draw it from the lower numbered side only.
      else if (vertices[i] < vertices[(i + 1) % vertices.length]) out.add(a, b, inner);
    }
  }
}

function drawLink(out: Segments, start: Vec3, end: Vec3, color: NavDebugColor): void {
  const rise = Math.hypot(end[0] - start[0], end[2] - start[2]) / 4;
  let last: ArrayLike<number> = start;
  for (let i = 1; i <= ARC; i++) {
    const t = i / ARC,
      next = [
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t + 4 * rise * t * (1 - t),
        start[2] + (end[2] - start[2]) * t,
      ];
    out.add(last, next, color);
    last = next;
  }
}

/**
 * The polygons of a mesh as segments: shared edges, outlines and off-mesh links as arcs. On a tiled mesh tile lines
 * draw as outlines, so the tiles show.
 */
export function meshLines(surface: NavMesh | TiledNavMesh, options?: NavDebugOptions): NavDebugLines {
  const out = new Segments(lifted(options)),
    colors = options?.colors,
    inner = colors?.inner ?? INNER,
    outline = colors?.outline ?? OUTLINE,
    link = colors?.link ?? LINK,
    seen = new Set<number>(),
    each = (links: readonly NavLink[]) => {
      for (const { offMesh, start, end } of links)
        if (offMesh !== undefined && !seen.has(offMesh)) {
          seen.add(offMesh);
          drawLink(out, start as Vec3, end as Vec3, link);
        }
    };
  if ('tileList' in surface) {
    for (const { mesh } of surface.tileList()) if (mesh) drawMesh(out, mesh, inner, outline);
    const { count, adjacency, owners } = surface.graph();
    for (let p = 0; p < count; p++) if (owners[p]) each(adjacency[p]);
  } else {
    drawMesh(out, surface, inner, outline);
    for (let p = 0; p < surface.polygonCount; p++) each(surface.polygonLinks(p));
  }
  return out.finish();
}

function drawRoute(
  out: Segments,
  points: readonly Vec3[],
  offMesh: readonly number[],
  route: NavDebugColor,
  link: NavDebugColor,
): void {
  for (let i = 1; i < points.length; i++)
    if (offMesh.includes(i - 1)) drawLink(out, points[i - 1], points[i], link);
    else out.add(points[i - 1], points[i], route);
}

/** A route as segments, its off-mesh stretches as arcs. */
export function routeLines(route: NavRoute, options?: NavDebugOptions): NavDebugLines {
  const out = new Segments(lifted(options));
  drawRoute(out, route.points, route.offMesh, options?.colors?.route ?? ROUTE, options?.colors?.link ?? LINK);
  return out.finish();
}

/**
 * Agents as segments: a ring of the agent's radius in the colour of its state, its velocity, and the rest of its route.
 */
export function crowdLines(agents: Crowd | readonly CrowdAgent[], options?: NavDebugOptions): NavDebugLines {
  const out = new Segments(lifted(options)),
    route = options?.colors?.route ?? ROUTE;
  for (const agent of 'agents' in agents ? agents.agents : agents) {
    const { position: at, velocity, radius, path, corner, state } = agent,
      color = options?.colors?.agents?.[state] ?? STATES[state];
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * 2 * Math.PI,
        b = ((i + 1) / RING) * 2 * Math.PI;
      out.add(
        [at[0] + Math.cos(a) * radius, at[1], at[2] + Math.sin(a) * radius],
        [at[0] + Math.cos(b) * radius, at[1], at[2] + Math.sin(b) * radius],
        color,
      );
    }
    if (velocity[0] || velocity[2]) out.add(at, [at[0] + velocity[0], at[1], at[2] + velocity[2]], color);
    let last: ArrayLike<number> = at;
    for (let i = corner; i < path.length; i++) {
      out.add(last, path[i], route);
      last = path[i];
    }
  }
  return out.finish();
}

/** Options of {@link NavDebug}. */
export interface NavDebugDrawOptions extends NavDebugOptions {
  /** Agents to draw. Default none. */
  crowd?: Crowd;
  /** Line width, CSS pixels. Default 1.5. */
  width?: number;
}

/**
 * Draws a mesh, its crowd and routes you give it with `@margoengine/lines`. Call {@link NavDebug.update} each frame: the
 * mesh lines are made again only when the mesh changes. `using` works.
 */
export class NavDebug {
  private readonly mesh: Line;
  private readonly agents: Line;
  private readonly route: Line;
  private version = -1;
  private disposed = false;

  constructor(
    private readonly lines: Lines,
    private readonly surface: NavMesh | TiledNavMesh,
    private readonly options: NavDebugDrawOptions = {},
  ) {
    const make = () => lines.add(new Line({ mode: 'segments', width: options?.width ?? 1.5 }));
    this.mesh = make();
    this.agents = make();
    this.route = make();
    this.update();
  }

  /** Draws a route until the next call; null clears it. */
  showRoute(route: NavRoute | null): void {
    const { positions, colors } = route ? routeLines(route, this.options) : { positions: [], colors: [] };
    this.route.setPositions(positions, colors);
  }

  /** Brings the lines up to date with the mesh and the crowd. */
  update(): void {
    if (this.disposed) return;
    if (this.surface.version !== this.version) {
      this.version = this.surface.version;
      const { positions, colors } = meshLines(this.surface, this.options);
      this.mesh.setPositions(positions, colors);
    }
    if (this.options?.crowd) {
      const { positions, colors } = crowdLines(this.options.crowd, this.options);
      this.agents.setPositions(positions, colors);
    }
  }

  /** Takes the lines away. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const line of [this.mesh, this.agents, this.route]) this.lines.remove(line);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
