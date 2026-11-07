/// <reference lib="esnext.disposable" preserve="true" />
// Weather that differs from place to place: a base weather over the whole map, fronts (straight lines that sweep across
// it and leave other weather behind) and cells (round areas such as a storm or a fog bank that drift with their own
// velocity). `stateAt(x, z)` blends them in a fixed order; everything is a pure function of position and time, so two
// players see the same sky and a replay gives the same weather.
import { MargoError } from '@margoengine/math/errors';
import { blendStates, resolveState, type WeatherPresetName, type WeatherState } from './state.js';

/** A preset name or a partial state (missing fields from the weather beneath it). */
export type RegionWeather = WeatherPresetName | Partial<WeatherState>;

/**
 * A straight front: the line through `origin` at time 0, moving toward `direction` at `speed`. Behind it (where it has
 * passed) the weather is `behind`; ahead it is `ahead`, or what lies beneath; along the line itself, `along`, if given.
 */
export interface WeatherFront {
  /** A point on the front at time 0, world `[x, z]` in metres. */
  origin: readonly [number, number];
  /** Direction the front moves toward in radians, 0 toward +Z and pi/2 toward +X (like `windDirection`). */
  direction: number;
  /** Metres per second, 0 to 200. Default 8 (a typical cold front, about 30 km/h). */
  speed?: number;
  /** Width of the change across the front in metres, 1 to 100,000. Default 2,000. */
  width?: number;
  /** Weather once the front has passed. */
  behind: RegionWeather;
  /** Weather ahead of the front. Default the weather beneath (the base, or earlier fronts). */
  ahead?: RegionWeather;
  /** Weather on the front itself (a squall line), blended in over `width` either side. Default none. */
  along?: RegionWeather;
}

/** A round area of its own weather (a storm cell, a fog bank, a snow squall) that drifts at `velocity`. */
export interface WeatherCell {
  /** Centre at time 0, world `[x, z]` in metres. */
  center: readonly [number, number];
  /** Radius in metres inside which the cell's weather is whole, 1 to 1,000,000. */
  radius: number;
  /** Width of the edge outside `radius` over which it fades into the weather around it, 0 to 1,000,000. Default `radius`. */
  falloff?: number;
  /** The cell's weather. */
  weather: RegionWeather;
  /** Drift in metres per second, `[x, z]`. Default `[0, 0]`. */
  velocity?: readonly [number, number];
  /** Seconds the cell exists, `[from, to]` (it grows in over the first and fades out over the last tenth). Default always. */
  life?: readonly [number, number];
}

/** {@link WeatherRegions} settings. */
export interface RegionOptions {
  /** Weather everywhere nothing else is. Default `'clear'`. */
  base?: RegionWeather;
  /** Fronts, applied in order over the base. Default none. */
  fronts?: readonly WeatherFront[];
  /** Cells, applied in order over the fronts. Default none. */
  cells?: readonly WeatherCell[];
}

interface ResolvedFront {
  readonly f: WeatherFront;
  readonly behind: WeatherState;
  readonly ahead?: WeatherState;
  readonly along?: WeatherState;
}
interface ResolvedCell {
  readonly c: WeatherCell;
  readonly state: WeatherState;
}

const finite = (value: unknown, name: string, min: number, max: number): void => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`Weather region ${name} must be a number from ${min} to ${max}; pass a finite value in range`);
};
const pair = (value: unknown, name: string, limit: number): void => {
  if (!Array.isArray(value) || value.length !== 2)
    throw new TypeError(`Weather region ${name} needs [x, z]; pass an array of two numbers`);
  finite(value[0], `${name}[0]`, -limit, limit);
  finite(value[1], `${name}[1]`, -limit, limit);
};
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function checkFront(f: WeatherFront, base: WeatherState): ResolvedFront {
  if (typeof f !== 'object' || f === null)
    throw new TypeError('A weather front must be an object; pass {origin, direction, behind}');
  pair(f.origin, 'front origin', 1e9);
  finite(f.direction, 'front direction', -1000, 1000);
  if (f.speed !== undefined) finite(f.speed, 'front speed', 0, 200);
  if (f.width !== undefined) finite(f.width, 'front width', 1, 100000);
  return {
    f,
    behind: resolveState(f.behind, base),
    ahead: f.ahead === undefined ? undefined : resolveState(f.ahead, base),
    along: f.along === undefined ? undefined : resolveState(f.along, base),
  };
}

function checkCell(c: WeatherCell, base: WeatherState): ResolvedCell {
  if (typeof c !== 'object' || c === null)
    throw new TypeError('A weather cell must be an object; pass {center, radius, weather}');
  pair(c.center, 'cell center', 1e9);
  finite(c.radius, 'cell radius', 1, 1e6);
  if (c.falloff !== undefined) finite(c.falloff, 'cell falloff', 0, 1e6);
  if (c.velocity !== undefined) pair(c.velocity, 'cell velocity', 1000);
  if (c.life !== undefined) {
    pair(c.life, 'cell life', 1e9);
    if (!(c.life[1] > c.life[0]))
      throw new RangeError('Weather region cell life must end after it starts; pass [from, to] with to > from');
  }
  return { c, state: resolveState(c.weather, base) };
}

/**
 * Weather over a map: a base, fronts that sweep across it and cells that drift. Sample it where something is with
 * {@link stateAt}; feed a `WeatherMachine` at the camera with {@link apply} so its ground wetness, snow and wind follow.
 * @throws TypeError / RangeError on a bad front, cell or base; MargoError `'disposed'` after `dispose()`.
 * @example
 * const map = new WeatherRegions({base: 'partlyCloudy', fronts: [{origin: [-5000, 0], direction: Math.PI / 2, behind: 'rain'}]});
 * const here = map.stateAt(camera.x, camera.z);
 */
export class WeatherRegions implements Disposable {
  private baseState: WeatherState;
  private frontList: ResolvedFront[] = [];
  private cellList: ResolvedCell[] = [];
  private clock = 0;
  private disposed = false;

  constructor(options: RegionOptions = {}) {
    if (typeof options !== 'object' || options === null)
      throw new TypeError('Weather region options must be an object; pass {} for a clear map');
    this.baseState = resolveState(options.base ?? 'clear');
    for (const f of options.fronts ?? []) this.addFront(f);
    for (const c of options.cells ?? []) this.addCell(c);
  }

  /** Seconds of map time; fronts and cells move with it. */
  get time(): number {
    return this.clock;
  }
  set time(value: number) {
    this.alive();
    finite(value, 'time', -1e9, 1e9);
    this.clock = value;
  }
  /** The base weather (a copy). */
  get base(): WeatherState {
    return { ...this.baseState };
  }
  set base(value: RegionWeather) {
    this.alive();
    this.baseState = resolveState(value);
  }
  /** Fronts in the order they apply. */
  get fronts(): readonly WeatherFront[] {
    return this.frontList.map((r) => r.f);
  }
  /** Cells in the order they apply. */
  get cells(): readonly WeatherCell[] {
    return this.cellList.map((r) => r.c);
  }

  /** Adds a front over those already there; returns a remover. A bad front throws and nothing changes. */
  addFront(front: WeatherFront): () => void {
    this.alive();
    const r = checkFront(front, this.baseState);
    this.frontList.push(r);
    return () => {
      this.frontList = this.frontList.filter((x) => x !== r);
    };
  }

  /** Adds a cell over those already there; returns a remover. A bad cell throws and nothing changes. */
  addCell(cell: WeatherCell): () => void {
    this.alive();
    const r = checkCell(cell, this.baseState);
    this.cellList.push(r);
    return () => {
      this.cellList = this.cellList.filter((x) => x !== r);
    };
  }

  /** Moves map time on by `delta` seconds. */
  update(delta: number): this {
    this.alive();
    finite(delta, 'delta', 0, 1e9);
    this.clock += delta;
    return this;
  }

  /**
   * Seconds until front `front` reaches world `(x, z)`, from time `t`; negative once it has passed. Use it for a
   * forecast ("rain in 4 minutes").
   */
  arrival(front: WeatherFront, x: number, z: number, t = this.clock): number {
    const s = Math.sin(front.direction),
      c = Math.cos(front.direction),
      ahead = (x - front.origin[0]) * s + (z - front.origin[1]) * c;
    const speed = front.speed ?? 8;
    return speed > 0 ? (ahead - speed * t) / speed : ahead >= 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  }

  /** The weather at world `(x, z)` at time `t` (default now). */
  stateAt(x: number, z: number, t = this.clock): WeatherState {
    this.alive();
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(t))
      throw new RangeError('Weather region position and time must be finite numbers; pass world x and z in metres');
    let state = { ...this.baseState };
    for (const { f, behind, ahead, along } of this.frontList) {
      const width = f.width ?? 2000,
        // Distance ahead of the front: positive where it has not arrived yet.
        d = (x - f.origin[0]) * Math.sin(f.direction) + (z - f.origin[1]) * Math.cos(f.direction) - (f.speed ?? 8) * t,
        passed = smoothstep(width / 2, -width / 2, d);
      state = blendStates(ahead ?? state, behind, passed, 'linear');
      if (along) state = blendStates(state, along, 1 - smoothstep(0, width, Math.abs(d)), 'linear');
    }
    for (const { c, state: weather } of this.cellList) {
      const v = c.velocity ?? [0, 0],
        dx = x - (c.center[0] + v[0] * t),
        dz = z - (c.center[1] + v[1] * t),
        falloff = c.falloff ?? c.radius;
      let w =
        falloff > 0
          ? 1 - smoothstep(c.radius, c.radius + falloff, Math.hypot(dx, dz))
          : Math.hypot(dx, dz) <= c.radius
            ? 1
            : 0;
      if (c.life) {
        const [from, to] = c.life,
          edge = (to - from) / 10;
        w *= smoothstep(from, from + edge, t) * smoothstep(to, to - edge, t);
      }
      if (w > 0) state = blendStates(state, weather, w, 'linear');
    }
    return state;
  }

  /**
   * Sets `machine` to the weather at `(x, z)` (a jump, so call it every frame before `machine.update`), so the
   * machine's wind, ground wetness and snow cover follow the place: walk into the rain and the ground gets wet.
   */
  apply(machine: { set(target: Partial<WeatherState>): unknown }, x: number, z: number): WeatherState {
    const state = this.stateAt(x, z);
    machine.set(state);
    return state;
  }

  /** Ends the map; use afterwards throws `MargoError` `'disposed'`. */
  dispose(): void {
    this.disposed = true;
    this.frontList = [];
    this.cellList = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  private alive(): void {
    if (this.disposed) throw new MargoError('disposed', 'WeatherRegions is disposed; create a new one');
  }
}
