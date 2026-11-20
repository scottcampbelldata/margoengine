// CPU twins of the point and spot loop's light terms, for LightBounce (`@margoengine/clustered/bounce`, KB-BOUNCE-TERMS1):
// each reads the very words its term uploads and mirrors its WGSL, so a lamp's bounce is weighed by the light it casts.
// They live here, imported only by the bounce entry, so an IES, projector or layers user who does not bounce pays no
// byte for them. The terms are told apart by their plugin name (no import of their classes):
// - 'clustered:ies' (ies.ts `clusterIes`): the unorm16 grid, 1 degree of vertical angle by 5 of horizontal, bilinear;
// - 'clustered:projector' (projector.ts `clusterProjector`, and cube-projector.ts `clusterCubeProjector` when it has
//   `cubeWords`): rgba8 texels, sRGB decode per IEC 61966-2-1, alpha, bilinear (the cube's filter crosses face edges);
// - 'clustered:layers' (layers.ts `clusterLayer`): the light's mask against core meshes' layer 0, which the capture draws.
import type { ClusteredLightRecord, ClusteredLightTerm } from './index.js';

type V3 = readonly number[];
type RGB = [number, number, number];
const ONE: RGB = [1, 1, 1],
  BLACK: RGB = [0, 0, 0],
  TAU = 2 * Math.PI,
  ROWS = 181,
  // The header of the IES, projector and cube blocks: 4 words, then 16 entries of 4 words.
  HEADER = 68;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a: V3, b: V3): RGB => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit = (a: V3): RGB => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  decode = (word: number, shift: number, srgb: boolean) => {
    const c = ((word >>> shift) & 255) / 255;
    return !srgb ? c : c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  },
  /** An rgba8 word's linear colour times its alpha. */
  texelColour = (word: number, srgb: boolean): RGB => {
    const a = (word >>> 24) / 255;
    return [decode(word, 0, srgb) * a, decode(word, 8, srgb) * a, decode(word, 16, srgb) * a];
  },
  bilinear = (p: RGB, q: RGB, r: RGB, t: RGB, f: number, g: number): RGB =>
    [0, 1, 2].map((k) => (p[k] + (q[k] - p[k]) * f) * (1 - g) + (r[k] + (t[k] - r[k]) * f) * g) as RGB;

/** `clusterIes`: the profile's factor for light `index` toward `position` (1 without a profile). */
export function iesTwin(w: Uint32Array, index: number, light: ClusteredLightRecord, position: V3): RGB {
  if (index >= w[0] || !w[HEADER + index * 2]) return ONE;
  const id = w[HEADER + index * 2],
    o = HEADER + w[4 + (id - 1) * 4],
    columns = w[5 + (id - 1) * 4],
    axis = light.direction ?? [0, -1, 0],
    d = unit([position[0] - light.position[0], position[1] - light.position[1], position[2] - light.position[2]]),
    value = (k: number) => (k & 1 ? w[o + (k >> 1)] >>> 16 : w[o + (k >> 1)] & 0xffff) / 65535,
    t = (Math.acos(Math.min(1, Math.max(-1, dot(d, axis)))) * (ROWS - 1)) / Math.PI,
    r0 = Math.min(Math.floor(t), ROWS - 2),
    fr = t - r0;
  let c0 = 0,
    c1 = 0,
    fc = 0;
  if (columns > 1) {
    const side = Math.abs(axis[0]) > 0.9 ? [0, 0, 1] : [1, 0, 0],
      k = dot(side, axis),
      x = unit([side[0] - axis[0] * k, side[1] - axis[1] * k, side[2] - axis[2] * k]),
      y = cross(x, axis),
      turn = Math.atan2(dot(d, y), dot(d, x)) - new Float32Array(w.buffer)[HEADER + index * 2 + 1],
      s = ((turn - TAU * Math.floor(turn / TAU)) * columns) / TAU;
    c0 = Math.min(Math.floor(s), columns - 1);
    c1 = (c0 + 1) % columns;
    fc = s - c0;
  }
  const at = (c: number) => value(c * ROWS + r0) * (1 - fr) + value(c * ROWS + r0 + 1) * fr,
    v = at(c0) * (1 - fc) + at(c1) * fc;
  return [v, v, v];
}
/** `clusterProjector`: a spot's projected image at `position` (1 for a point light or a light without one). */
export function projectorTwin(w: Uint32Array, index: number, light: ClusteredLightRecord, position: V3): RGB {
  const at = HEADER + index * 4,
    dir = light.direction;
  if (index >= w[0] || !dir || !w[at]) return ONE;
  const floats = new Float32Array(w.buffer),
    image = 4 + (w[at] - 1) * 4,
    offset = w[image],
    width = w[image + 1],
    height = w[image + 2],
    srgb = w[image + 3] === 1,
    back = [-dir[0], -dir[1], -dir[2]],
    x = unit(cross(Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0], back)),
    y = cross(back, x),
    rel = [position[0] - light.position[0], position[1] - light.position[1], position[2] - light.position[2]],
    depth = dot(rel, dir);
  if (depth <= 0) return BLACK;
  const c = light.cosOuter ?? 0,
    stored = floats[at + 1],
    fy = 1 / (stored > 0 ? stored : Math.sqrt(Math.max(1 - c * c, 0)) / Math.max(c, 1e-6)),
    fx = fy / floats[at + 2],
    u = ((dot(rel, x) * fx) / depth) * 0.5 + 0.5,
    v = ((dot(rel, y) * fy) / depth) * -0.5 + 0.5;
  if (u < 0 || v < 0 || u > 1 || v > 1) return BLACK;
  const texel = (i: number, j: number) =>
      texelColour(w[HEADER + offset + Math.min(Math.max(j, 0), height - 1) * width + Math.min(Math.max(i, 0), width - 1)], srgb),
    tx = u * width - 0.5,
    ty = v * height - 0.5,
    i = Math.floor(tx),
    j = Math.floor(ty);
  return bilinear(texel(i, j), texel(i + 1, j), texel(i, j + 1), texel(i + 1, j + 1), tx - i, ty - j);
}
// `cubeCookieCoord` and `cubeCookieDirection`: face uv in [0, 1] and the face, and back.
function cubeCoord(d: V3): RGB {
  const a = d.map(Math.abs);
  let f = 0,
    p: number[],
    m = a[0];
  if (a[0] >= a[1] && a[0] >= a[2]) {
    if (d[0] >= 0) p = [-d[2], -d[1]];
    else (f = 1), (p = [d[2], -d[1]]);
  } else if (a[1] >= a[2]) {
    m = a[1];
    if (d[1] >= 0) (f = 2), (p = [d[0], d[2]]);
    else (f = 3), (p = [d[0], -d[2]]);
  } else {
    m = a[2];
    if (d[2] >= 0) (f = 4), (p = [d[0], -d[1]]);
    else (f = 5), (p = [-d[0], -d[1]]);
  }
  const s = Math.max(m, 1e-30);
  return [(p[0] / s) * 0.5 + 0.5, (p[1] / s) * 0.5 + 0.5, f];
}
function cubeDirection(face: number, p: V3): RGB {
  switch (face) {
    case 0:
      return [1, -p[1], -p[0]];
    case 1:
      return [-1, -p[1], p[0]];
    case 2:
      return [p[0], 1, p[1]];
    case 3:
      return [p[0], -1, -p[1]];
    case 4:
      return [p[0], -p[1], 1];
    default:
      return [-p[0], -p[1], -1];
  }
}
/** `clusterCubeProjector`: a point light's cube cookie toward `position` (1 for a spot or a light without one). */
export function cubeTwin(w: Uint32Array, index: number, light: ClusteredLightRecord, position: V3): RGB {
  if (index >= w[0] || light.direction) return ONE;
  const at = HEADER + index * 8,
    id = w[at];
  if (!id) return ONE;
  const world = [position[0] - light.position[0], position[1] - light.position[1], position[2] - light.position[2]];
  if (dot(world, world) < 1e-30) return ONE;
  const f32 = new Float32Array(w.buffer),
    q = [f32[at + 4], f32[at + 5], f32[at + 6], f32[at + 7]],
    v = [-q[0], -q[1], -q[2]],
    inner = cross(v, world).map((c, k) => c + q[3] * world[k]),
    turn = cross(v, inner),
    d = world.map((c, k) => c + 2 * turn[k]),
    image = 4 + (id - 1) * 4,
    offset = w[image],
    side = w[image + 1],
    srgb = w[image + 2] === 1,
    pixel = (c: number) => Math.min(Math.max(Math.trunc(c * side), 0), side - 1),
    decoded = (c: V3) => texelColour(w[HEADER + offset + c[2] * side * side + pixel(c[1]) * side + pixel(c[0])], srgb),
    texel = (face: number, i: number, j: number): RGB => {
      const outX = i < 0 || i >= side,
        outY = j < 0 || j >= side,
        sx = ((i + 0.5) / side) * 2 - 1,
        sy = ((j + 0.5) / side) * 2 - 1;
      if (outX && outY) {
        const corner = cubeDirection(face, [Math.sign(sx), Math.sign(sy)]),
          a = decoded(cubeCoord([corner[0] * 2, corner[1], corner[2]])),
          b = decoded(cubeCoord([corner[0], corner[1] * 2, corner[2]])),
          c = decoded(cubeCoord([corner[0], corner[1], corner[2] * 2]));
        return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      }
      if (outX || outY) {
        const m = cubeCoord(cubeDirection(face, [sx, sy]));
        return decoded([(pixel(m[0]) + 0.5) / side, (pixel(m[1]) + 0.5) / side, m[2]]);
      }
      return decoded([(i + 0.5) / side, (j + 0.5) / side, face]);
    },
    coord = cubeCoord(d),
    tx = coord[0] * side - 0.5,
    ty = coord[1] * side - 0.5,
    i = Math.floor(tx),
    j = Math.floor(ty);
  return bilinear(texel(coord[2], i, j), texel(coord[2], i + 1, j), texel(coord[2], i, j + 1), texel(coord[2], i + 1, j + 1), tx - i, ty - j);
}
/** `clusterLayer` for core meshes (layer 0): 1 when light `index` is on layer 0. */
export function layerTwin(w: Uint32Array, index: number): RGB {
  const on = (index < w[0] ? w[4 + index] : 1) & 1;
  return [on, on, on];
}
type Packed = ClusteredLightTerm & { name?: string; words?: Uint32Array; cubeWords?: Uint32Array };
/**
 * The factor of `term` for light `index` toward `position`: a built-in term's twin from its words, else the term's own
 * `emission`, else 1.
 */
export function termEmission(term: ClusteredLightTerm, index: number, light: ClusteredLightRecord, position: V3): readonly number[] {
  const t = term as Packed;
  if (t.words instanceof Uint32Array) {
    if (t.name === 'clustered:ies') return iesTwin(t.words, index, light, position);
    if (t.name === 'clustered:layers') return layerTwin(t.words, index);
    if (t.name === 'clustered:projector') {
      const spot = projectorTwin(t.words, index, light, position);
      if (!(t.cubeWords instanceof Uint32Array)) return spot;
      const cube = cubeTwin(t.cubeWords, index, light, position);
      return [spot[0] * cube[0], spot[1] * cube[1], spot[2] * cube[2]];
    }
  }
  return t.emission ? t.emission(index, light, position) : ONE;
}
/** What identifies a term's present entries: its packed words (new on every set call), else its `revision`. */
export function termState(term: ClusteredLightTerm): unknown {
  const t = term as Packed;
  return t.words instanceof Uint32Array ? [t.words, t.cubeWords] : (t.revision ?? 0);
}
