import type { Camera, EngineKernel, Geometry, Mesh, Vec3 } from '@margoengine/core';
import { parseColor, type ColorInput } from './color.js';
import { Line, type LineMaterialOptions } from './line.js';
import { meshWorldMatrix } from './lines.js';
import { invertMatrix } from '@margoengine/math/mat4';
import { copyIfChanged, finiteArray, transformPoint } from './math.js';

/** Material options shared by every helper. Helpers default to 1 pixel, butt caps and miter joins. */
export type HelperOptions = Omit<LineMaterialOptions, 'color'>;

const helperStyle = (options: HelperOptions): LineMaterialOptions => ({ cap: 'butt', join: 'miter', ...options });
const rgb = (color: ColorInput): number[] => parseColor(color) as number[];
const vec3 = (value: Vec3, label: string): Vec3 => {
  if (!value || value.length !== 3) throw new TypeError(`${label} needs 3 values`);
  finiteArray(value, label);
  return value;
};
function basis(normal: Vec3): [number[], number[], number[]] {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (!length) throw new RangeError('Direction must be nonzero');
  const n = normal.map((v) => v / length),
    helper = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const u = [
    helper[1] * n[2] - helper[2] * n[1],
    helper[2] * n[0] - helper[0] * n[2],
    helper[0] * n[1] - helper[1] * n[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]);
  u[0] /= ul;
  u[1] /= ul;
  u[2] /= ul;
  return [n, u, [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]];
}

/** Grid in the XZ plane, like three.js `GridHelper`. The two center lines use `color1`. */
export class GridHelper extends Line {
  constructor({
    size = 10,
    divisions = 10,
    color1 = '#444444',
    color2 = '#888888',
    ...options
  }: { size?: number; divisions?: number; color1?: ColorInput; color2?: ColorInput } & HelperOptions = {}) {
    if (!(size > 0) || !Number.isInteger(divisions) || divisions < 1 || divisions > 10000)
      throw new RangeError('Invalid grid size or divisions');
    const positions: number[] = [],
      colors: number[] = [],
      center = rgb(color1),
      other = rgb(color2),
      half = size / 2,
      step = size / divisions;
    for (let i = 0; i <= divisions; i++) {
      const k = -half + i * step,
        c = i * 2 === divisions ? center : other;
      positions.push(-half, 0, k, half, 0, k, k, 0, -half, k, 0, half);
      for (let j = 0; j < 4; j++) colors.push(...c);
    }
    super({ ...helperStyle(options), mode: 'segments', positions, colors });
  }
}

/** Polar grid in the XZ plane, like three.js `PolarGridHelper`. Sectors and rings alternate between the two colors. */
export class PolarGridHelper extends Line {
  constructor({
    radius = 10,
    sectors = 16,
    rings = 8,
    divisions = 64,
    color1 = '#444444',
    color2 = '#888888',
    ...options
  }: {
    radius?: number;
    sectors?: number;
    rings?: number;
    divisions?: number;
    color1?: ColorInput;
    color2?: ColorInput;
  } & HelperOptions = {}) {
    if (
      !(radius > 0) ||
      ![sectors, rings, divisions].every((v) => Number.isInteger(v) && v >= 0 && v <= 4096) ||
      divisions < 3
    )
      throw new RangeError('Invalid polar grid options');
    const positions: number[] = [],
      colors: number[] = [],
      c1 = rgb(color1),
      c2 = rgb(color2);
    for (let i = 0; i < sectors; i++) {
      const angle = (i / sectors) * Math.PI * 2,
        c = i & 1 ? c2 : c1;
      positions.push(0, 0, 0, Math.sin(angle) * radius, 0, Math.cos(angle) * radius);
      colors.push(...c, ...c);
    }
    for (let i = 0; i < rings; i++) {
      const r = radius - (radius / rings) * i,
        c = i & 1 ? c2 : c1;
      for (let j = 0; j < divisions; j++) {
        const a = (j / divisions) * Math.PI * 2,
          b = ((j + 1) / divisions) * Math.PI * 2;
        positions.push(Math.sin(a) * r, 0, Math.cos(a) * r, Math.sin(b) * r, 0, Math.cos(b) * r);
        colors.push(...c, ...c);
      }
    }
    super({ ...helperStyle(options), mode: 'segments', positions, colors });
  }
}

/** X, Y and Z axes in red, green and blue, like three.js `AxesHelper`. */
export class AxesHelper extends Line {
  constructor({ size = 1, ...options }: { size?: number } & HelperOptions = {}) {
    if (!(size > 0)) throw new RangeError('Axes size must be positive');
    super({
      ...helperStyle(options),
      mode: 'segments',
      positions: [0, 0, 0, size, 0, 0, 0, 0, 0, 0, size, 0, 0, 0, 0, 0, 0, size],
      colors: [1, 0, 0, 1, 0.6, 0, 0, 1, 0, 0.6, 1, 0, 0, 0, 1, 0, 0.6, 1],
    });
  }
  setColors(x: ColorInput | ArrayLike<number> | null, y?: ColorInput, z?: ColorInput): this {
    if (y === undefined || z === undefined || x === null || (typeof x === 'object' && x.length !== 3))
      return super.setColors(x as ArrayLike<number> | null);
    const a = rgb(x as ColorInput),
      b = rgb(y),
      c = rgb(z);
    return super.setColors([...a, ...a, ...b, ...b, ...c, ...c]);
  }
}

const boxEdges = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7];
function boxPositions(min: ArrayLike<number>, max: ArrayLike<number>, out: number[] = []): number[] {
  out.length = 0;
  for (const corner of boxEdges)
    out.push(corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]);
  return out;
}

/** Edges of an axis-aligned box given by min and max corners, like three.js `Box3Helper`. */
export class Box3Helper extends Line {
  constructor(
    min: Vec3 = [-0.5, -0.5, -0.5],
    max: Vec3 = [0.5, 0.5, 0.5],
    { color = '#ffff00', ...options }: { color?: ColorInput } & HelperOptions = {},
  ) {
    super({ ...helperStyle(options), color, mode: 'segments' });
    this.setBox(min, max);
  }
  setBox(min: Vec3, max: Vec3): this {
    vec3(min, 'Box min');
    vec3(max, 'Box max');
    if (min.some((v, i) => v > max[i])) throw new RangeError('Box min exceeds max');
    return this.setPositions(boxPositions(min, max));
  }
}

const localBounds = new WeakMap<Geometry, Float32Array>();
/** Local axis-aligned bounds of a core Geometry as min xyz, max xyz. Cached per geometry. */
export function geometryBounds(geometry: Geometry): Float32Array {
  let bounds = localBounds.get(geometry);
  if (!bounds) {
    bounds = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    const v = geometry.vertices;
    for (let i = 0; i < v.length; i += 6)
      for (let a = 0; a < 3; a++) {
        bounds[a] = Math.min(bounds[a], v[i + a]);
        bounds[a + 3] = Math.max(bounds[a + 3], v[i + a]);
      }
    localBounds.set(geometry, bounds);
  }
  return bounds;
}

/** World-space bounding box of a core mesh, updated every frame, like three.js `BoxHelper`. */
export class BoxHelper extends Line {
  private source: Mesh;
  private readonly seen = new Float32Array(16).fill(NaN);
  private geometry: Geometry | null = null;
  private readonly scratch: number[] = [];
  private readonly corner = [0, 0, 0];
  constructor(mesh: Mesh, { color = '#ffff00', ...options }: { color?: ColorInput } & HelperOptions = {}) {
    super({ ...helperStyle(options), color, mode: 'segments', positions: new Array(72).fill(0) });
    this.source = mesh;
    mesh.check();
  }
  setFromMesh(mesh: Mesh): this {
    mesh.check();
    this.source = mesh;
    this.seen.fill(NaN);
    return this;
  }
  update(engine: EngineKernel): boolean {
    const matrix = meshWorldMatrix(engine, this.source),
      geometry = this.source.geometry;
    if (!matrix || !geometry) return false;
    if (!copyIfChanged(this.seen, matrix) && geometry === this.geometry) return true;
    this.geometry = geometry;
    const b = geometryBounds(geometry),
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity],
      p = this.corner;
    for (let i = 0; i < 8; i++) {
      transformPoint(p, 0, matrix, i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2]);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a]);
        max[a] = Math.max(max[a], p[a]);
      }
    }
    this.setPositions(boxPositions(min, max, this.scratch));
    return true;
  }
}

/** An arrow from `origin` along `direction`, like three.js `ArrowHelper`; the head is drawn as a wire cone. */
export class ArrowHelper extends Line {
  private dir: Vec3;
  private origin: Vec3;
  private length: number;
  private headLength: number;
  private headWidth: number;
  constructor({
    direction = [0, 0, 1],
    origin = [0, 0, 0],
    length = 1,
    color = '#ffff00',
    headLength,
    headWidth,
    ...options
  }: {
    direction?: Vec3;
    origin?: Vec3;
    length?: number;
    color?: ColorInput;
    headLength?: number;
    headWidth?: number;
  } & HelperOptions = {}) {
    super({ ...helperStyle(options), color, mode: 'segments' });
    this.dir = vec3(direction, 'Arrow direction');
    this.origin = vec3(origin, 'Arrow origin');
    this.length = length;
    this.headLength = headLength ?? 0.2 * length;
    this.headWidth = headWidth ?? 0.2 * this.headLength;
    this.rebuild();
  }
  setDirection(direction: Vec3): this {
    this.dir = vec3(direction, 'Arrow direction');
    return this.rebuild();
  }
  setOrigin(origin: Vec3): this {
    this.origin = vec3(origin, 'Arrow origin');
    return this.rebuild();
  }
  setLength(length: number, headLength = 0.2 * length, headWidth = 0.2 * headLength): this {
    this.length = length;
    this.headLength = headLength;
    this.headWidth = headWidth;
    return this.rebuild();
  }
  private rebuild(): this {
    if (
      ![this.length, this.headLength, this.headWidth].every((v) => Number.isFinite(v) && v >= 0) ||
      !(this.length > 0) ||
      this.headLength > this.length
    )
      throw new RangeError('Invalid arrow length');
    const [n, u, v] = basis(this.dir),
      o = this.origin,
      at = (s: number, a = 0, b = 0) => [0, 1, 2].map((i) => o[i] + n[i] * s + u[i] * a + v[i] * b);
    const tip = at(this.length),
      base = this.length - this.headLength,
      positions = [...at(0), ...at(base)],
      spokes = 8;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2,
        b = ((i + 1) / spokes) * Math.PI * 2,
        r = this.headWidth / 2;
      const p = at(base, Math.cos(a) * r, Math.sin(a) * r),
        q = at(base, Math.cos(b) * r, Math.sin(b) * r);
      positions.push(...tip, ...p, ...p, ...q);
    }
    return this.setPositions(positions);
  }
}

const cameraColors = { frustum: '#ffaa00', cone: '#ff0000', up: '#00aaff', target: '#ffffff', cross: '#333333' };
// Named NDC points in WebGPU reversed-Z: near plane z = 1, far plane z = 0.
const cameraPoints: Record<string, [number, number, number]> = {
  n1: [-1, -1, 1],
  n2: [1, -1, 1],
  n3: [-1, 1, 1],
  n4: [1, 1, 1],
  f1: [-1, -1, 0],
  f2: [1, -1, 0],
  f3: [-1, 1, 0],
  f4: [1, 1, 0],
  u1: [-0.7, 1.1, 1],
  u2: [0.7, 1.1, 1],
  u3: [0, 2, 1],
  c: [0, 0, 1],
  t: [0, 0, 0],
  cn1: [-1, 0, 1],
  cn2: [1, 0, 1],
  cn3: [0, -1, 1],
  cn4: [0, 1, 1],
  cf1: [-1, 0, 0],
  cf2: [1, 0, 0],
  cf3: [0, -1, 0],
  cf4: [0, 1, 0],
};
const cameraPairs: Array<[string, string, keyof typeof cameraColors]> = [
  ['n1', 'n2', 'frustum'],
  ['n2', 'n4', 'frustum'],
  ['n4', 'n3', 'frustum'],
  ['n3', 'n1', 'frustum'],
  ['f1', 'f2', 'frustum'],
  ['f2', 'f4', 'frustum'],
  ['f4', 'f3', 'frustum'],
  ['f3', 'f1', 'frustum'],
  ['n1', 'f1', 'frustum'],
  ['n2', 'f2', 'frustum'],
  ['n3', 'f3', 'frustum'],
  ['n4', 'f4', 'frustum'],
  ['p', 'n1', 'cone'],
  ['p', 'n2', 'cone'],
  ['p', 'n3', 'cone'],
  ['p', 'n4', 'cone'],
  ['u1', 'u2', 'up'],
  ['u2', 'u3', 'up'],
  ['u3', 'u1', 'up'],
  ['c', 't', 'target'],
  ['p', 'c', 'cross'],
  ['cn1', 'cn2', 'cross'],
  ['cn3', 'cn4', 'cross'],
  ['cf1', 'cf2', 'cross'],
  ['cf3', 'cf4', 'cross'],
];

/**
 * Frustum, cone, up marker and center cross of a Margo Engine `Camera`, like three.js `CameraHelper`.
 * Each frame the camera is updated with `aspect` (default: the engine canvas aspect) unless it is the engine's own camera.
 */
export class CameraHelper extends Line {
  aspect?: number;
  private readonly inverse = new Float64Array(16);
  private readonly seen = new Float32Array(16).fill(NaN);
  private readonly positions: number[] = [];
  constructor(
    readonly camera: Camera,
    { aspect, ...options }: { aspect?: number } & HelperOptions = {},
  ) {
    const colors: number[] = [];
    for (const [, , kind] of cameraPairs) {
      const c = rgb(cameraColors[kind]);
      colors.push(...c, ...c);
    }
    super({ ...helperStyle(options), mode: 'segments', positions: new Array(cameraPairs.length * 6).fill(0), colors });
    this.aspect = aspect;
  }
  update(engine: EngineKernel): boolean {
    const camera = this.camera;
    if (camera !== engine.camera)
      camera.update(this.aspect ?? engine.canvas.width / Math.max(1, engine.canvas.height), true);
    if (!copyIfChanged(this.seen, camera.matrix) || !invertMatrix(camera.matrix, this.inverse)) return true;
    const out = this.positions;
    out.length = 0;
    const point = [0, 0, 0];
    for (const [a, b] of cameraPairs)
      for (const name of [a, b]) {
        if (name === 'p') {
          out.push(...camera.position);
          continue;
        }
        const [x, y, z] = cameraPoints[name];
        transformPoint(point, 0, this.inverse, x, y, z);
        out.push(...point);
      }
    this.setPositions(out);
    return true;
  }
}

/** Outline and diagonals of the plane `normal . p + constant = 0`, like three.js `PlaneHelper`. */
export class PlaneHelper extends Line {
  constructor({
    normal = [0, 1, 0],
    constant = 0,
    size = 1,
    color = '#ffff00',
    ...options
  }: { normal?: Vec3; constant?: number; size?: number; color?: ColorInput } & HelperOptions = {}) {
    super({ ...helperStyle(options), color, mode: 'segments' });
    this.setPlane(normal, constant, size);
  }
  setPlane(normal: Vec3, constant = 0, size = 1): this {
    vec3(normal, 'Plane normal');
    if (!Number.isFinite(constant) || !(size > 0)) throw new RangeError('Invalid plane');
    const length = Math.hypot(normal[0], normal[1], normal[2]),
      [n, u, v] = basis(normal),
      h = size / 2;
    const at = (a: number, b: number) =>
      [0, 1, 2].map((i) => (-constant / length) * n[i] + u[i] * a * h + v[i] * b * h);
    const c = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
    return this.setPositions([
      ...c[0],
      ...c[1],
      ...c[1],
      ...c[2],
      ...c[2],
      ...c[3],
      ...c[3],
      ...c[0],
      ...c[0],
      ...c[2],
      ...c[1],
      ...c[3],
    ]);
  }
}

/** One line per vertex along its normal, in world space, like three.js `VertexNormalsHelper`. */
export class VertexNormalsHelper extends Line {
  size: number;
  private readonly seen = new Float32Array(16).fill(NaN);
  private geometry: Geometry | null = null;
  private seenSize = NaN;
  private scratch = new Float32Array(0);
  constructor(
    readonly mesh: Mesh,
    { size = 1, color = '#ff0000', ...options }: { size?: number; color?: ColorInput } & HelperOptions = {},
  ) {
    super({ ...helperStyle(options), color, mode: 'segments' });
    mesh.check();
    this.size = size;
  }
  update(engine: EngineKernel): boolean {
    const m = meshWorldMatrix(engine, this.mesh),
      geometry = this.mesh.geometry;
    if (!m || !geometry) return false;
    if (!Number.isFinite(this.size)) throw new RangeError('Normal size must be finite');
    if (!copyIfChanged(this.seen, m) && geometry === this.geometry && this.size === this.seenSize) return true;
    this.geometry = geometry;
    this.seenSize = this.size;
    // Normal matrix: inverse transpose of the upper 3x3, from the cofactors.
    const c0 = [m[5] * m[10] - m[6] * m[9], m[6] * m[8] - m[4] * m[10], m[4] * m[9] - m[5] * m[8]];
    const c1 = [m[2] * m[9] - m[1] * m[10], m[0] * m[10] - m[2] * m[8], m[1] * m[8] - m[0] * m[9]];
    const c2 = [m[1] * m[6] - m[2] * m[5], m[2] * m[4] - m[0] * m[6], m[0] * m[5] - m[1] * m[4]];
    const det = m[0] * c0[0] + m[1] * c0[1] + m[2] * c0[2],
      v = geometry.vertices,
      count = v.length / 6;
    if (this.scratch.length !== count * 6) this.scratch = new Float32Array(count * 6);
    const out = this.scratch;
    for (let i = 0; i < count; i++) {
      const o = i * 6,
        x = v[o + 3],
        y = v[o + 4],
        z = v[o + 5];
      transformPoint(out, o, m, v[o], v[o + 1], v[o + 2]);
      const nx = c0[0] * x + c1[0] * y + c2[0] * z,
        ny = c0[1] * x + c1[1] * y + c2[1] * z,
        nz = c0[2] * x + c1[2] * y + c2[2] * z;
      const s = (Math.sign(det || 1) * this.size) / (Math.hypot(nx, ny, nz) || 1);
      out[o + 3] = out[o] + nx * s;
      out[o + 4] = out[o + 1] + ny * s;
      out[o + 5] = out[o + 2] + nz * s;
    }
    this.setPositions(out);
    return true;
  }
}
