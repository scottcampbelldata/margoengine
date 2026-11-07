// Agent types: what kinds of walker a level has. Walkers of one size share a mesh; what each may walk on, and how
// much it dislikes it, is a filter over the polygons' area numbers, so a level is built once per size and not per kind.
import type { CrowdAgent, CrowdAgentOptions } from './crowd.js';
import { Crowd } from './crowd.js';
import type { NavFilter, NavMesh, NavRoute, NavSurface, Vec3 } from './index.js';
import { generate, type NavArea, type NavigationOptions } from './pipeline.js';
import { TiledNavMesh } from './tiles.js';

/** One kind of walker, in world units. */
export interface AgentType {
  /** Body radius. Default 0.5. */
  radius?: number;
  /** Body height. Default 2. */
  height?: number;
  /** Highest step it takes. Default 0.4. */
  climb?: number;
  /** Steepest slope it walks, degrees below 90. Default 45. */
  maxSlope?: number;
  /** Top speed for {@link NavAgents.addAgent}. Default 3.5. */
  maxSpeed?: number;
  /**
   * What each area costs it, by name: a multiplier of 1 or more, `Infinity` for an area it cannot enter. An area not
   * named costs 1, `ground` being everything no box marks.
   */
  areas?: Readonly<Record<string, number>>;
}

/** A box of named ground ({@link NavAgentsOptions.areas}), world units. */
export interface NamedArea {
  /** Lowest corner [x, y, z]. */
  min: readonly [number, number, number];
  /** Highest corner [x, y, z]. */
  max: readonly [number, number, number];
  /** Its name, as agent types call it. */
  area: string;
}

/** Options of {@link NavAgents}. */
export interface NavAgentsOptions
  extends Omit<
    NavigationOptions,
    'walkableHeight' | 'walkableClimb' | 'walkableRadius' | 'walkableSlopeAngle' | 'areas'
  > {
  /** The kinds of walker, by name. */
  types: Readonly<Record<string, AgentType>>;
  /** Named ground, later boxes over earlier ones. Default none. */
  areas?: readonly NamedArea[];
  /** Cut each mesh into tiles of this many cells (`./tiles`); by default each is one `NavMesh`. */
  tileSize?: number;
}

interface Kind {
  surface: NavMesh | TiledNavMesh;
  filter: Float64Array;
  type: Required<Omit<AgentType, 'areas'>>;
}

/**
 * The meshes and filters of a level's agent types. Types of the same size share one mesh; each has its own filter.
 * `route(type, start, end)` plans for a type, and `addAgent(crowd, type, options)` puts one in a crowd, where walkers
 * of every kind avoid each other.
 */
export class NavAgents {
  /** Area names in number order; the first is `ground`. */
  readonly areas: readonly string[];
  private readonly kinds = new Map<string, Kind>();
  /** Distinct meshes built, one per agent size. */
  readonly meshCount: number;
  /**
   * Builds a mesh per size.
   * @param positions Flat xyz positions (Y up).
   * @param indices Flat triangle indices into `positions`.
   * @throws RangeError for invalid geometry, options or types, or more than 255 area names.
   * @throws MargoError `failed` when a type has nothing walkable: its size or slope leaves no room.
   */
  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, options: NavAgentsOptions) {
    const { types, areas = [], tileSize, ...build } = options ?? ({} as NavAgentsOptions);
    if (!types || !Object.keys(types).length)
      throw new RangeError('NavAgents needs types: {name: {radius, height, ...}}');
    const cs = build.cs ?? 0.2,
      ch = build.ch ?? 0.2,
      names = ['ground'];
    const numbered: NavArea[] = areas.map(({ min, max, area }) => {
      if (typeof area !== 'string' || !area) throw new RangeError('A named area needs area: a name');
      if (!names.includes(area)) names.push(area);
      return { min, max, area: names.indexOf(area) };
    });
    for (const type of Object.values(types))
      for (const name of Object.keys(type.areas ?? {})) if (!names.includes(name)) names.push(name);
    if (names.length > 256) throw new RangeError('At most 255 named areas fit an area number');
    this.areas = names;
    const meshes = new Map<string, NavMesh | TiledNavMesh>();
    for (const [name, given] of Object.entries(types)) {
      const type = {
        radius: given.radius ?? 0.5,
        height: given.height ?? 2,
        climb: given.climb ?? 0.4,
        maxSlope: given.maxSlope ?? 45,
        maxSpeed: given.maxSpeed ?? 3.5,
      };
      if (
        !(type.radius >= 0 && type.height > 0 && type.climb >= 0 && type.maxSlope >= 0 && type.maxSlope < 90) ||
        !(type.maxSpeed >= 0) ||
        !Number.isFinite(type.radius + type.height + type.climb + type.maxSpeed)
      )
        throw new RangeError(
          `Agent type ${name}: radius, height, climb and maxSpeed must be finite and maxSlope below 90`,
        );
      // In voxels: the body is rounded up and the step down, so a type never fits where it should not.
      const settings: NavigationOptions = {
          ...build,
          areas: numbered,
          walkableRadius: Math.ceil(type.radius / cs - 1e-9),
          walkableHeight: Math.ceil(type.height / ch - 1e-9),
          walkableClimb: Math.floor(type.climb / ch + 1e-9),
          walkableSlopeAngle: type.maxSlope,
        },
        key = [settings.walkableRadius, settings.walkableHeight, settings.walkableClimb, type.maxSlope].join();
      let surface = meshes.get(key);
      if (!surface) {
        surface =
          tileSize === undefined
            ? generate(positions, indices, settings).mesh
            : new TiledNavMesh(positions, indices, { ...settings, tileSize });
        meshes.set(key, surface);
      }
      const filter = new Float64Array(names.length).fill(1);
      for (const [area, cost] of Object.entries(given.areas ?? {})) {
        if (!(cost >= 1)) throw new RangeError(`Agent type ${name}: area cost must be 1 or more, or Infinity`);
        filter[names.indexOf(area)] = cost;
      }
      this.kinds.set(name, { surface, filter, type });
    }
    this.meshCount = meshes.size;
  }
  private kind(type: string): Kind {
    const kind = this.kinds.get(type);
    if (!kind) throw new RangeError(`No agent type ${type}; the types are ${[...this.kinds.keys()].join(', ')}.`);
    return kind;
  }
  /** The mesh a type walks on: a `NavMesh`, or a `TiledNavMesh` with `tileSize`. */
  mesh(type: string): NavMesh | TiledNavMesh {
    return this.kind(type).surface;
  }
  /** A type's filter: its cost per area number, for `route(start, end, filter)`. */
  filter(type: string): NavFilter {
    return this.kind(type).filter;
  }
  /** Route for a type, or null when an end is off its mesh or nothing it may walk on connects them. */
  route(type: string, start: Vec3, end: Vec3): NavRoute | null {
    const { surface, filter } = this.kind(type);
    return surface.route(start, end, filter);
  }
  /** Corner points of {@link NavAgents.route}, or null. */
  path(type: string, start: Vec3, end: Vec3): Vec3[] | null {
    return this.route(type, start, end)?.points ?? null;
  }
  /** Adds a walker of a type to a crowd: its mesh, filter, radius and speed, unless `options` say otherwise. */
  addAgent(crowd: Crowd, type: string, options: CrowdAgentOptions): CrowdAgent {
    const kind = this.kind(type);
    return crowd.addAgent({
      radius: kind.type.radius || undefined,
      maxSpeed: kind.type.maxSpeed,
      ...options,
      navMesh: kind.surface as NavSurface,
      filter: kind.filter,
    });
  }
}
