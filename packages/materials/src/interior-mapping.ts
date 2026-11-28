// Interior mapping: a room behind every window, traced in the fragment shader of the window's own surface, so a facade
// shows depth and parallax with no geometry behind its glass. Clean room from:
// - J. van Dongen, "Interior Mapping: A New Technique for Rendering Realistic Buildings", Computer Graphics
//   International 2008, https://joostdevblog.blogspot.com/2018/09/interior-mapping-real-rooms-without.html: rooms as
//   the cells between walls, floors and ceilings at regular spacing, the view ray cut by the nearest of those planes,
//   with a further plane inside the room for furnishings.
// - T. Kay and J. Kajiya, "Ray Tracing Complex Scenes", SIGGRAPH 1986, https://doi.org/10.1145/15886.15916: a ray's
//   exit from a box as the least of its three slab exits.
// - S. Lagarde and A. Zanuttini, "Local Image-based Lighting with Parallax-corrected Cubemaps", SIGGRAPH 2012 Talks,
//   https://doi.org/10.1145/2343045.2343094: a cube picture of a room looked up toward the point the ray hits on its
//   box, from the box's middle.
// - M. Jarzynski and M. Olano, "Hash Functions for GPU Rendering", JCGT 9(3), 2020,
//   https://jcgt.org/published/0009/03/02/: the pcg3d hash that gives each room its own look.
// - C. Schlick, "An Inexpensive BRDF Model for Physically-based Rendering", Computer Graphics Forum 13(3), 1994,
//   https://doi.org/10.1111/1467-8659.1330233: the share of light the glass reflects, taken from what comes through.
import type { MaterialOptions } from './built-material.js';
import type { Texture } from './texture-core.js';
import { WgslMaterial } from './wgsl-material.js';

type Vec3 = readonly [number, number, number];
const MAX_LEVELS = 32;
const HELP = '; see https://margoengine.com/errors#materials-interior-mapping';

/** How the rooms lie behind a facade. Metres, Y up. */
export interface RoomGrid {
  /** A point rooms are counted from: a corner of the building, on its ground. Default [0, 0, 0]. */
  origin?: Vec3;
  /** The building's turn about +Y, radians: its facades run along its own x and z. Default 0. */
  yaw?: number;
  /** A room's width along a facade, or `[along x, along z]` where the sides have other bays. Default 3. */
  width?: number | readonly [number, number];
  /** A storey's height, for rooms stacked evenly from the origin. Default 2.8. Ignored with `floors`. */
  height?: number;
  /**
   * Floor levels over the origin, rising, the last the top storey's ceiling: 2 to 33 numbers, for storeys of unequal
   * height. Surfaces below the first or above the last take the end storey's rooms.
   */
  floors?: readonly number[];
  /** How deep a room is behind the glass. Default 4. */
  depth?: number;
}
/** Options of {@link interiorMapping}: the rooms, what they look like, and any other Material option. */
export interface InteriorMappingOptions extends RoomGrid, Omit<MaterialOptions, 'shading'> {
  /** Linear colours of a room's walls, floor and ceiling. */
  wallColor?: Vec3;
  floorColor?: Vec3;
  ceilingColor?: Vec3;
  /** How far rooms differ in colour and brightness, 0 to 1. Default 0.5. */
  variation?: number;
  /** Radiance of a room's surfaces from daylight, the brightest at the window. Live. Default 0.35. */
  daylight?: number;
  /** The share of rooms with a lamp on, 0 to 1. Live. Default 0.15. */
  lit?: number;
  /** A lamp's linear colour and radiance. Live. Default [1, 0.78, 0.52] and 1.4. */
  lampColor?: Vec3;
  lamp?: number;
  /**
   * The share of furnished rooms, 0 to 1: a piece of furniture across the room and, in plain rooms, a door or a
   * picture on the back wall. Default 0.7 (0 with a `map`).
   */
  furniture?: number;
  /** The share of windows with curtains drawn partly across, 0 to 1. Default 0.35. */
  curtains?: number;
  /** The share of windows with a slatted blind partly down, 0 to 1. Default 0.2. */
  blinds?: number;
  /** Linear tint of the glass on what comes through. Default [0.9, 0.95, 0.93]. */
  tint?: Vec3;
  /** Which rooms get which look. Default 0. */
  seed?: number;
  /**
   * Pictures of rooms in place of the plain colours. A cube texture is one room seen from the middle of its box, the
   * window toward +Z. A 2D texture is an atlas (`tiles`) of rooms each drawn in one-point perspective from outside the
   * window, the back wall filling the middle `backWall` share of the tile.
   */
  map?: Texture;
  /** Rooms across and down a 2D `map`. Default [1, 1]. */
  tiles?: readonly [number, number];
  /** The share of a 2D tile's width and height its back wall takes, above 0 and under 1. Default 0.5. */
  backWall?: number;
}
/** What of a building {@link facadeRooms} reads: a `generateBuilding` result of `@margoengine/procedural` fits. */
export interface RoomedBuilding {
  readonly options: {
    readonly width: number;
    readonly depth: number;
    readonly bayWidth: number;
    readonly origin: Vec3;
    readonly yaw: number;
  };
  /** Floor levels over the origin. */
  readonly floors: readonly number[];
  /** Wall top over the origin. */
  readonly eaves: number;
}
/** Where one view ray ends in the room behind a point of a facade, as {@link traceRoom} finds it. */
export interface RoomHit {
  /** The room: its column along the facade, its storey and which way the facade faces (0 +z, 1 +x, 2 -z, 3 -x). */
  readonly cell: readonly [number, number, number];
  readonly face: 'back' | 'floor' | 'ceiling' | 'left' | 'right';
  /** In the room: metres from its left wall as seen from outside, from its floor, and in from the glass. */
  readonly point: Vec3;
  /** The room's width, height and depth. */
  readonly size: Vec3;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function range(v: number, name: string, min: number, max: number): number {
  if (!finite(v) || v < min || v > max)
    throw new RangeError(`interiorMapping ${name} must be from ${min} to ${max}; pass a number in that range${HELP}`);
  return v;
}
function triple(v: Vec3, name: string, min = -Infinity): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => finite(n) && n >= min))
    throw new RangeError(
      `interiorMapping ${name} must be three finite numbers${min === 0 ? ' of 0 or more' : ''}; pass [x, y, z]${HELP}`,
    );
  return [v[0], v[1], v[2]];
}
interface Grid {
  origin: [number, number, number];
  yaw: number;
  width: [number, number];
  levels: number[];
  /** Whether the storeys repeat without end (no `floors` given). */
  even: boolean;
  depth: number;
}
function grid(o: RoomGrid): Grid {
  const w = o.width ?? 3,
    width = (typeof w === 'number' ? [w, w] : [...w]) as [number, number];
  if (width.length !== 2) throw new RangeError('interiorMapping width must be a number or two; pass metres' + HELP);
  width.forEach((v) => range(v, 'width', 0.1, 1000));
  const levels = o.floors ? [...o.floors] : [0, range(o.height ?? 2.8, 'height', 0.1, 1000)];
  if (
    levels.length < 2 ||
    levels.length > MAX_LEVELS + 1 ||
    !levels.every((v, k) => finite(v) && (k === 0 || v - levels[k - 1] >= 0.1))
  )
    throw new RangeError(
      `interiorMapping floors must be 2 to ${MAX_LEVELS + 1} levels, each 0.1 m or more over the last; pass them rising${HELP}`,
    );
  return {
    origin: triple(o.origin ?? [0, 0, 0], 'origin'),
    yaw: range(o.yaw ?? 0, 'yaw', -1000, 1000),
    width,
    levels,
    even: !o.floors,
    depth: range(o.depth ?? 4, 'depth', 0.1, 1000),
  };
}

/**
 * The room grid of a rules building: rooms one facade bay wide (the sides have their own bays), one storey high, and
 * counted from its front left corner, so every window of the facade looks into a room of its own bay. Spread it into
 * {@link interiorMapping}.
 */
export function facadeRooms(building: RoomedBuilding): Required<Omit<RoomGrid, 'height'>> {
  const { width, depth, bayWidth, origin, yaw } = building.options,
    bay = (length: number) => length / Math.max(1, Math.round(length / bayWidth)),
    c = Math.cos(yaw),
    s = Math.sin(yaw),
    x = -width / 2,
    z = depth / 2;
  return {
    origin: [origin[0] + x * c + z * s, origin[1], origin[2] - x * s + z * c],
    yaw,
    width: [bay(width), bay(depth)],
    floors: [...building.floors, building.eaves],
    depth: Math.min(4, Math.min(width, depth) / 2),
  };
}

/**
 * The room a view ray enters through a facade point, and where it ends there: the shader's own trace, for picking a
 * room or checking a layout. `normal` is the facade's outward normal, `direction` the ray's way, into the wall.
 * Undefined for a floor or roof (a level surface) and for a ray that leaves the wall.
 */
export function traceRoom(point: Vec3, normal: Vec3, direction: Vec3, rooms: RoomGrid = {}): RoomHit | undefined {
  const g = grid(rooms),
    c = Math.cos(g.yaw),
    s = Math.sin(g.yaw),
    turn = ([x, y, z]: Vec3): [number, number, number] => [x * c - z * s, y, x * s + z * c],
    p = turn(triple(point, 'point').map((v, k) => v - g.origin[k]) as [number, number, number]),
    n = turn(triple(normal, 'normal')),
    d = turn(triple(direction, 'direction')),
    flat = Math.hypot(n[0], n[2]);
  if (!(flat > 0.3 * Math.hypot(...n))) return undefined;
  const nx = n[0] / flat,
    nz = n[2] / flat,
    alongX = Math.abs(nz) >= Math.abs(nx),
    w = g.width[alongX ? 0 : 1],
    // Right along the facade as seen from outside, and in through it.
    ray = [d[0] * nz - d[2] * nx, d[1], -(d[0] * nx + d[2] * nz)];
  if (!(ray[2] > 0)) return undefined;
  const a = p[0] * nz - p[2] * nx,
    column = Math.floor(a / w);
  let storey: number, base: number, h: number;
  if (g.even) {
    h = g.levels[1];
    storey = Math.floor(p[1] / h);
    base = storey * h;
  } else {
    storey = 0;
    while (storey < g.levels.length - 2 && p[1] >= g.levels[storey + 1]) storey++;
    base = g.levels[storey];
    h = g.levels[storey + 1] - base;
  }
  const size: [number, number, number] = [w, h, g.depth],
    start = [a - column * w, Math.min(h, Math.max(0, p[1] - base)), 0],
    exit = start.map((v, k) => (ray[k] === 0 ? Infinity : ((ray[k] > 0 ? size[k] : 0) - v) / ray[k])),
    t = Math.min(...exit),
    axis = exit.indexOf(t),
    facing = alongX ? (nz > 0 ? 0 : 2) : nx > 0 ? 1 : 3;
  return {
    cell: [column, storey, facing],
    face: axis === 2 ? 'back' : axis === 1 ? (ray[1] > 0 ? 'ceiling' : 'floor') : ray[0] > 0 ? 'right' : 'left',
    point: start.map((v, k) => v + ray[k] * t) as unknown as Vec3,
    size,
  };
}

const levelFields = Array.from({ length: 9 }, (_, k) => `floors${k}`);
/** The shader: the plain rooms, or rooms pictured by a cube or a 2D atlas. */
function shader(map?: 'cube' | '2d'): string {
  const pick = levelFields.map((f, k) => `if (q == ${k}) { return uniforms.${f}[r]; }`).join('\n  ');
  const picture =
    map === 'cube'
      ? `var q = hit / size * 2.0 - 1.0;
    if (h2.x > 0.5) { q.x = -q.x; }
    let across = f32(textureDimensions(roomMap).x);
    let lod = max(0.0, log2(foot * across / min(size.x, size.y)));
    colour = textureSampleLevel(roomMap, roomMapSampler, vec3f(q.x, q.y, -q.z), lod).rgb;`
      : map === '2d'
        ? `let q = hit / size;
    let k = uniforms.back / (1.0 - uniforms.back);
    let scale = k / (k + q.z);
    var t = vec2f(0.5 + (q.x - 0.5) * scale, 0.5 - (q.y - 0.5) * scale);
    if (h2.x > 0.5) { t.x = 1.0 - t.x; }
    let tiles = uniforms.tiles;
    let tile = min(floor(h2.y * tiles.x * tiles.y), tiles.x * tiles.y - 1.0);
    let corner = vec2f(tile - tiles.x * floor(tile / tiles.x), floor(tile / tiles.x));
    let texels = vec2f(textureDimensions(roomMap)) / tiles;
    let lod = max(0.0, log2(foot * texels.x / size.x));
    let inset = min(vec2f(0.5), exp2(lod) / texels * 0.5);
    colour = textureSampleLevel(roomMap, roomMapSampler, (corner + clamp(t, inset, 1.0 - inset)) / tiles, lod).rgb;`
        : `var own = uniforms.wall;
    if (face == 1) { own = uniforms.ground; }
    if (face == 2) { own = uniforms.ceiling; }
    // A room's own tint, its walls more than its floor and ceiling.
    let shades = imHash(id + vec3u(0u, 0u, 4000037u));
    let tint = 0.45 + 1.1 * mix(vec3f(shades.x), shades, 0.35);
    let tone = mix(vec3f(1.0), tint, uniforms.variation * select(0.35, 1.0, face == 0 || face == 3));
    // Corners darken: the distance to the two other surfaces meeting there.
    let edge = min(hit, size - hit);
    let near = select(select(edge.xy, edge.xz, face == 1 || face == 2), edge.yz, face == 3);
    let corner = mix(0.62, 1.0, smoothstep(0.0, 0.7, near.x)) * mix(0.62, 1.0, smoothstep(0.0, 0.7, near.y));
    colour = own * tone * corner;
    // A door or a picture on the back wall.
    if (face == 0 && h2.z < uniforms.furniture) {
      let at = vec2f(hit.x - size.x * (0.2 + 0.6 * h3.x), hit.y);
      if (h3.y < 0.45) {
        colour = mix(colour, own * 0.35, imBox(at - vec2f(0.0, 1.02), vec2f(0.45, 1.02), foot));
      } else {
        let paint = 0.1 + 0.6 * imHash(vec3u(bitcast<u32>(i32(room.x)), bitcast<u32>(i32(room.y)), 77u));
        colour = mix(colour, paint, imBox(at - vec2f(0.0, size.y * 0.55), vec2f(0.4, 0.28), foot));
      }
    }`;
  return `
fn imPcg(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
fn imHash(c: vec3u) -> vec3f {
  return vec3f(imPcg(c) >> vec3u(8u)) * (1.0 / 16777216.0);
}
fn imLevel(k: i32) -> f32 {
  let q = k / 4; let r = k % 4;
  ${pick}
  return 0.0;
}
// How much of a pixel of side foot a box of half size half covers, at offset p from its middle.
fn imBox(p: vec2f, half: vec2f, foot: f32) -> f32 {
  let d = clamp((half - abs(p)) / max(foot, 1e-4) + 0.5, vec2f(0.0), vec2f(1.0));
  return d.x * d.y;
}
fn shade(i: Out, s: Surface) -> Surface {
  // Derivatives are taken before any branch.
  let foot = length(fwidth(i.position));
  var o = s;
  let yaw = uniforms.turn;
  let turned = mat3x3f(vec3f(yaw.x, 0.0, yaw.y), vec3f(0.0, 1.0, 0.0), vec3f(-yaw.y, 0.0, yaw.x));
  let p = turned * (i.position - uniforms.origin);
  let m = turned * normalize(i.normal);
  let level = length(m.xz);
  if (level <= 0.3) { return o; }
  let n = m.xz / level;
  let toward = turned * normalize(i.position - f.eye.xyz);
  let ray = vec3f(toward.x * n.y - toward.z * n.x, toward.y, max(-(toward.x * n.x + toward.z * n.y), 1e-4));
  let alongX = abs(n.y) >= abs(n.x);
  let w = select(uniforms.width.y, uniforms.width.x, alongX);
  let a = p.x * n.y - p.z * n.x;
  let column = floor(a / w);
  var storey = 0.0; var base = 0.0; var h = 0.0;
  if (uniforms.count < 0.5) {
    h = imLevel(1);
    storey = floor(p.y / h);
    base = storey * h;
  } else {
    var k = 0;
    for (var j = 1; j < i32(uniforms.count); j++) { if (p.y >= imLevel(j)) { k = j; } }
    storey = f32(k);
    base = imLevel(k);
    h = imLevel(k + 1) - base;
  }
  let size = vec3f(w, h, uniforms.depth);
  let start = vec3f(a - column * w, clamp(p.y - base, 0.0, h), 0.0);
  let steep = select(vec3f(-1.0), vec3f(1.0), ray >= vec3f(0.0)) * max(abs(ray), vec3f(1e-6));
  let exit = (select(vec3f(0.0), size, steep > vec3f(0.0)) - start) / steep;
  var t = min(exit.x, min(exit.y, exit.z));
  var face = 0;
  if (exit.y <= exit.x && exit.y <= exit.z) { face = select(1, 2, ray.y > 0.0); }
  if (exit.x < exit.y && exit.x <= exit.z) { face = 3; }
  let hit = clamp(start + steep * t, vec3f(0.0), size);
  let facing = select(select(3.0, 1.0, n.x > 0.0), select(2.0, 0.0, n.y > 0.0), alongX);
  let room = vec3f(column, storey, facing);
  let id = vec3u(bitcast<u32>(i32(column)), bitcast<u32>(i32(storey)), u32(facing) + 4u * u32(uniforms.seed));
  let h1 = imHash(id);
  let h2 = imHash(id + vec3u(0u, 0u, 1000003u));
  let h3 = imHash(id + vec3u(0u, 0u, 2000003u));
  let h4 = imHash(id + vec3u(0u, 0u, 3000017u));
  var colour = vec3f(0.0);
  {
    ${picture}
  }
  var at = hit;
  var normal = vec3f(0.0, 0.0, -1.0);
  if (face == 1) { normal = vec3f(0.0, 1.0, 0.0); }
  if (face == 2) { normal = vec3f(0.0, -1.0, 0.0); }
  if (face == 3) { normal = vec3f(select(1.0, -1.0, ray.x > 0.0), 0.0, 0.0); }
  // A piece of furniture across the room, on a plane of its own.
  if (h2.z < uniforms.furniture) {
    let z = size.z * (0.45 + 0.4 * h3.z);
    let tz = z / steep.z;
    if (tz < t) {
      let q = start + steep * tz;
      let half = vec2f(w * (0.12 + 0.2 * h4.x), 0.25 + 0.45 * h4.y);
      let middle = vec2f(clamp(w * h4.z, half.x + 0.1, max(half.x + 0.1, w - half.x - 0.1)), half.y);
      let cover = imBox(q.xy - middle, half, foot);
      if (cover > 0.0) {
        let wood = (0.04 + 0.22 * imHash(id + vec3u(5u, 0u, 0u))) * (0.75 + 0.25 * smoothstep(0.0, 2.0 * half.y, q.y));
        colour = mix(colour, wood, cover);
        if (cover > 0.5) { at = q; normal = vec3f(0.0, 0.0, -1.0); }
      }
    }
  }
  // Curtains and blinds just inside the glass.
  let tc = min(0.12, 0.5 * size.z) / steep.z;
  if (tc < t) {
    let q = start + steep * tc;
    if (q.x >= 0.0 && q.x <= w && q.y >= 0.0 && q.y <= h) {
      if (h1.x * 0.999 + 0.0005 < uniforms.curtains) {
        let open = w * (0.12 + 0.3 * h3.x);
        let cover = clamp((open - min(q.x, w - q.x)) / max(foot, 1e-4) + 0.5, 0.0, 1.0);
        // Folds fade out where a pixel is wider than one.
        let fold = 0.8 + 0.2 * sin(q.x * 45.0) * clamp(1.0 - foot * 14.0, 0.0, 1.0);
        let dye = imHash(id + vec3u(9u, 0u, 0u));
        let cloth = (0.15 + 0.65 * mix(vec3f(dye.x), dye, 0.3)) * fold;
        colour = mix(colour, cloth, cover);
        if (cover > 0.5) { at = q; normal = vec3f(0.0, 0.0, -1.0); }
      } else if (imHash(id + vec3u(13u, 0u, 0u)).x < uniforms.blinds) {
        let drop = h - h * (0.2 + 0.6 * h4.z);
        let cover = clamp((q.y - drop) / max(foot, 1e-4) + 0.5, 0.0, 1.0);
        let slat = mix(0.82, 0.55 + 0.45 * step(0.3, fract(q.y / 0.06)), clamp(1.0 - foot * 40.0, 0.0, 1.0));
        colour = mix(colour, vec3f(0.62, 0.6, 0.55) * slat, cover);
        if (cover > 0.5) { at = q; normal = vec3f(0.0, 0.0, -1.0); }
      }
    }
  }
  // Daylight falls off into the room; a lamp under the ceiling lights what faces it.
  var light = vec3f(uniforms.daylight * mix(1.0, 0.4, clamp(at.z / size.z, 0.0, 1.0)));
  light *= mix(1.0, 0.55 + 0.9 * h3.y, uniforms.variation);
  if (h1.y < uniforms.lit) {
    let lamp = vec3f(0.5 * w, h - 0.25, 0.5 * size.z) - at;
    let far = dot(lamp, lamp);
    let on = max(dot(normal, lamp * inverseSqrt(max(far, 1e-6))), 0.0);
    light += uniforms.lampColor * (uniforms.lamp * (0.25 + 0.75 * on) / (1.0 + far / 4.0));
  }
  let facingGlass = clamp(ray.z, 0.0, 1.0);
  let through = 1.0 - (0.04 + 0.96 * pow(1.0 - facingGlass, 5.0));
  o.emissive += colour * light * uniforms.tint * through;
  return o;
}
`;
}

/**
 * A window material with a room behind the glass: give it to the window surfaces of a facade (the `glass` part of a
 * rules building, with `...facadeRooms(building)`). The surface is dark glossy glass, so sun and environment reflect
 * in it, and the room shows through as emitted light. Rooms differ by cell; `daylight`, `lit`, `lamp` and `lampColor`
 * stay live in `material.uniforms`. Level surfaces are left as they are. Walls must stand upright.
 */
export function interiorMapping(options: InteriorMappingOptions = {}): WgslMaterial {
  const {
      origin,
      yaw,
      width,
      height,
      floors,
      depth,
      wallColor = [0.55, 0.5, 0.42],
      floorColor = [0.22, 0.14, 0.08],
      ceilingColor = [0.75, 0.73, 0.68],
      variation = 0.5,
      daylight = 0.35,
      lit = 0.15,
      lampColor = [1, 0.78, 0.52],
      lamp = 1.4,
      furniture,
      curtains = 0.35,
      blinds = 0.2,
      tint = [0.9, 0.95, 0.93],
      seed = 0,
      map,
      tiles = [1, 1],
      backWall = 0.5,
      ...material
    } = options,
    g = grid({ origin, yaw, width, height, floors, depth });
  if (map && map.dimension !== 'cube' && map.dimension !== '2d')
    throw new TypeError('interiorMapping map must be a 2d or cube Texture; pass one of those' + HELP);
  if (tiles.length !== 2 || !tiles.every((v) => Number.isInteger(v) && v >= 1 && v <= 64))
    throw new RangeError('interiorMapping tiles must be two integers from 1 to 64; pass rooms across and down' + HELP);
  if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000)
    throw new RangeError('interiorMapping seed must be an integer from 0 to 1000000; pass one' + HELP);
  const levels = Array.from({ length: 36 }, (_, k) => g.levels[Math.min(k, g.levels.length - 1)]),
    uniforms: Record<string, number | number[]> = {
      origin: g.origin,
      turn: [Math.cos(g.yaw), Math.sin(g.yaw)],
      width: g.width,
      depth: g.depth,
      // The storeys listed, or 0 where one height repeats.
      count: g.even ? 0 : g.levels.length - 1,
      seed,
      variation: range(variation, 'variation', 0, 1),
      daylight: range(daylight, 'daylight', 0, 1000),
      lit: range(lit, 'lit', 0, 1),
      lampColor: triple(lampColor, 'lampColor', 0),
      lamp: range(lamp, 'lamp', 0, 1000),
      furniture: range(furniture ?? (map ? 0 : 0.7), 'furniture', 0, 1),
      curtains: range(curtains, 'curtains', 0, 1),
      blinds: range(blinds, 'blinds', 0, 1),
      tint: triple(tint, 'tint', 0),
      wall: triple(wallColor, 'wallColor', 0),
      ground: triple(floorColor, 'floorColor', 0),
      ceiling: triple(ceilingColor, 'ceilingColor', 0),
    };
  levelFields.forEach((f, k) => (uniforms[f] = levels.slice(4 * k, 4 * k + 4)));
  if (map?.dimension === '2d') {
    uniforms.tiles = [tiles[0], tiles[1]];
    uniforms.back = range(backWall, 'backWall', 0.01, 0.99);
  }
  return new WgslMaterial({
    color: [0.004, 0.005, 0.006],
    roughness: 0.06,
    metalness: 0,
    ...material,
    shading: 'standard',
    wgsl: shader(map?.dimension as 'cube' | '2d' | undefined),
    uniforms,
    ...(map && { textures: { roomMap: map } }),
  });
}
