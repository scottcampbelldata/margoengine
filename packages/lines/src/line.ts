/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel, Mesh } from '@margoengine/core';
import { parseColor, type ColorInput } from './color.js';
import {
  CAPS,
  JOINS,
  MODES,
  computeLineDistances,
  segmentCount,
  type LineCap,
  type LineJoin,
  type LineMode,
} from './geometry.js';
import { copyIfChanged, finiteArray, identity, type Mat4 } from './math.js';

export interface LineMaterialOptions {
  /** Uniform color, multiplied with vertex colors. Default white. */
  color?: ColorInput;
  /** 0..1. Default 1. */
  opacity?: number;
  /** CSS pixels, or world units when `worldUnits` is set. Default 1. */
  width?: number;
  worldUnits?: boolean;
  join?: LineJoin;
  cap?: LineCap;
  /** Miter length over line width above which a miter join falls back to bevel. Default 4. */
  miterLimit?: number;
  dashed?: boolean;
  dashSize?: number;
  gapSize?: number;
  dashOffset?: number;
  /** Multiply by the line's per-vertex colors. Default true when the line has colors. */
  vertexColors?: boolean;
  /** Skip the depth test and draw over the scene. Default false. */
  onTop?: boolean;
  /** One-pixel coverage ramp on edges, caps and dash ends. Default true. */
  antialias?: boolean;
}

/** Style shared by any number of lines, like three.js `LineMaterial`. Fields may be changed at any time. */
export class LineMaterial {
  readonly color = new Float32Array([1, 1, 1]);
  opacity = 1;
  width = 1;
  worldUnits = false;
  join: LineJoin = 'round';
  cap: LineCap = 'round';
  miterLimit = 4;
  dashed = false;
  dashSize = 1;
  gapSize = 1;
  dashOffset = 0;
  vertexColors?: boolean;
  onTop = false;
  antialias = true;
  constructor(options: LineMaterialOptions = {}) {
    this.set(options);
  }
  set(options: LineMaterialOptions): this {
    const { color, ...rest } = options;
    if (color !== undefined) this.setColor(color);
    for (const [key, value] of Object.entries(rest))
      if (value !== undefined) (this as unknown as Record<string, unknown>)[key] = value;
    this.validate();
    return this;
  }
  setColor(color: ColorInput): this {
    parseColor(color, this.color);
    return this;
  }
  /** Throws when a field is out of range. Called on every frame the material is used. */
  validate(): void {
    finiteArray(this.color, 'Line color');
    const numbers = [this.opacity, this.width, this.miterLimit, this.dashSize, this.gapSize, this.dashOffset];
    if (numbers.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
      throw new RangeError('Line material values must be finite numbers');
    if (this.opacity < 0 || this.opacity > 1) throw new RangeError('Line opacity must be 0..1');
    if (this.width <= 0) throw new RangeError('Line width must be positive');
    if (this.miterLimit < 1) throw new RangeError('Miter limit must be at least 1');
    if (this.dashSize <= 0 || this.gapSize < 0)
      throw new RangeError('Dash size must be positive and gap size non-negative');
    if (!JOINS.includes(this.join) || !CAPS.includes(this.cap)) throw new TypeError('Unknown line join or cap');
    for (const flag of [this.worldUnits, this.dashed, this.onTop, this.antialias])
      if (typeof flag !== 'boolean') throw new TypeError('Line flags must be boolean');
  }
}

export interface LineOptions extends LineMaterialOptions {
  /** x, y, z per point. */
  positions?: ArrayLike<number>;
  /** r, g, b or r, g, b, a per point, linear 0..1. */
  colors?: ArrayLike<number> | null;
  /** 'segments' draws pairs like LineSegments2, 'strip' a polyline like Line2, 'loop' a closed polyline. Default 'strip'. */
  mode?: LineMode;
  /** Share a material between lines; material options on this object are applied to it. */
  material?: LineMaterial;
  /** Follow this mesh's world matrix. */
  mesh?: Mesh | null;
  /** Model matrix when not attached to a mesh (column-major). Default identity. */
  matrix?: Mat4;
  visible?: boolean;
}

interface Owner {
  remove(line: Line): void;
}

/**
 * A fat line: segments or a polyline drawn as screen-space quads with joins, caps, dashes and antialiasing.
 * Replaces three.js `Line2`, `LineSegments2`, `LineGeometry` and `LineSegmentsGeometry`.
 */
export class Line {
  readonly material: LineMaterial;
  mode: LineMode;
  visible: boolean;
  /** Model matrix used when the line is not attached to a mesh. Edit in place or call setMatrix. */
  readonly matrix: Float32Array;
  /** x, y, z, distance per point; capacity may exceed `count`. */
  points = new Float32Array(0);
  /** r, g, b, a per point when the line has colors. */
  colors: Float32Array | null = null;
  /** Bumped when positions or colors change size or content; read by the plugin. */
  version = 0;
  /** Bumped when buffers must grow. */
  capacityVersion = 0;
  /** Total length for dashes, including a loop's closing segment. */
  totalDistance = 0;
  private pointCount = 0;
  private target: Mesh | null = null;
  private owner?: Owner;
  private distancesFor = new Float32Array(16).fill(NaN);
  private distanceVersion = -1;
  private distanceMode?: LineMode;

  constructor(options: LineOptions = {}) {
    const { positions, colors, mode = 'strip', material, mesh = null, matrix, visible = true, ...style } = options;
    if (!MODES.includes(mode)) throw new TypeError('Unknown line mode');
    this.mode = mode;
    this.visible = visible;
    this.material = material ?? new LineMaterial();
    this.material.set(style);
    this.matrix = identity();
    if (matrix) this.setMatrix(matrix);
    if (positions) this.setPositions(positions, colors ?? undefined);
    else if (colors) throw new TypeError('Colors need positions');
    this.attach(mesh);
  }

  get count(): number {
    return this.pointCount;
  }
  get segmentCount(): number {
    return segmentCount(this.mode, this.pointCount);
  }
  get attachedMesh(): Mesh | null {
    return this.target;
  }

  /**
   * Replaces the points. Reuses the existing CPU and GPU buffers when the point count fits the current
   * capacity, so per-frame updates of the same size never allocate. Pass `colors` to replace colors too.
   */
  setPositions(positions: ArrayLike<number>, colors?: ArrayLike<number> | null): this {
    if (positions.length % 3) throw new RangeError('Positions need x, y, z per point');
    finiteArray(positions, 'Line positions');
    const count = positions.length / 3;
    if (count > 4_000_000) throw new RangeError('Too many line points');
    if (count * 4 > this.points.length) {
      this.points = new Float32Array(count * 4);
      this.capacityVersion++;
      if (this.colors) this.growColors(count);
    }
    for (let i = 0; i < count; i++) {
      this.points[i * 4] = positions[i * 3];
      this.points[i * 4 + 1] = positions[i * 3 + 1];
      this.points[i * 4 + 2] = positions[i * 3 + 2];
      this.points[i * 4 + 3] = 0;
    }
    this.pointCount = count;
    this.version++;
    if (colors !== undefined) this.setColors(colors);
    else if (this.colors && this.colors.length < count * 4) this.growColors(count);
    return this;
  }

  /** Per-point colors, r, g, b or r, g, b, a each (linear 0..1). `null` removes them. */
  setColors(colors: ArrayLike<number> | null): this {
    if (colors === null) {
      if (this.colors) {
        this.colors = null;
        this.capacityVersion++;
        this.version++;
      }
      return this;
    }
    const count = this.pointCount,
      stride = colors.length === count * 4 ? 4 : colors.length === count * 3 ? 3 : 0;
    if (!stride) throw new RangeError('Colors need r, g, b or r, g, b, a per point');
    finiteArray(colors, 'Line colors');
    if (!this.colors || this.colors.length < count * 4) this.growColors(count);
    const out = this.colors!;
    for (let i = 0; i < count; i++) {
      out[i * 4] = colors[i * stride];
      out[i * 4 + 1] = colors[i * stride + 1];
      out[i * 4 + 2] = colors[i * stride + 2];
      out[i * 4 + 3] = stride === 4 ? colors[i * stride + 3] : 1;
    }
    this.version++;
    return this;
  }

  private growColors(count: number): void {
    const next = new Float32Array(Math.max(count * 4, this.points.length)).fill(1);
    if (this.colors) next.set(this.colors.subarray(0, Math.min(this.colors.length, next.length)));
    this.colors = next;
    this.capacityVersion++;
  }

  /** Follow a core mesh's world matrix (the line's points are then in the mesh's local space), or null for world space. */
  attach(mesh: Mesh | null): this {
    if (mesh !== null && (typeof mesh !== 'object' || typeof mesh.check !== 'function'))
      throw new TypeError('Expected a Margo Engine mesh');
    mesh?.check();
    this.target = mesh;
    return this;
  }

  setMatrix(matrix: Mat4): this {
    if (matrix.length !== 16) throw new TypeError('Matrix needs 16 values');
    finiteArray(matrix, 'Line matrix');
    this.matrix.set(Array.from(matrix));
    return this;
  }

  /** Called by the plugin each frame before drawing; helpers override it to follow their targets. Return false to skip this frame. */
  update(_engine: EngineKernel): boolean | void {}

  /** Recomputes dash distances when the points, mode or model matrix changed. */
  updateDistances(model: Mat4): void {
    if (
      !copyIfChanged(this.distancesFor, model) &&
      this.distanceVersion === this.version &&
      this.distanceMode === this.mode
    )
      return;
    this.totalDistance = computeLineDistances(this.points, this.pointCount, this.mode, model);
    this.distanceMode = this.mode;
    this.distanceVersion = this.version;
    this.version++;
    this.distanceVersion = this.version;
  }

  /** @internal */
  bind(owner: Owner | undefined): void {
    if (owner && this.owner && this.owner !== owner) throw new Error('Line already belongs to another Lines plugin');
    this.owner = owner;
  }
  get attached(): boolean {
    return this.owner !== undefined;
  }

  /** Removes the line from its plugin and releases its GPU buffers. The line can be added again later. */
  dispose(): void {
    this.owner?.remove(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
