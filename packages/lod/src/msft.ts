import type { EngineKernel } from '@margoengine/core';
import { meshRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { GLTFDocument, PBRModel, PBRPrimitive } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { worldRadius } from '../../shared/sphere.js';

/** One highest-detail material and the lower-detail materials named by MSFT_lod. */
export interface MaterialLODEntry {
  /** Highest-detail material's index. */
  material: number;
  /** All material indices, finest first. */
  levels: readonly number[];
  /** Optional decreasing MSFT_screencoverage hints. */
  screenCoverage?: readonly number[];
}
/**
 * Reads material MSFT_lod chains without altering the document or loading resources. Cycles, duplicate references,
 * out-of-range indices and invalid coverage hints fail before a controller can change any material.
 */
export function readMaterialLODs(doc: GLTFDocument): readonly MaterialLODEntry[] {
  const definitions = doc.materials ?? [],
    out: MaterialLODEntry[] = [];
  definitions.forEach((def, material) => {
    const lod = (def.extensions as { MSFT_lod?: { ids?: unknown } } | undefined)?.MSFT_lod;
    if (lod === undefined) return;
    const ids = lod?.ids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((i) => !Number.isInteger(i) || i < 0 || i >= definitions.length || i === material)
    )
      throw new TypeError(
        'MSFT_lod material ids must name distinct lower materials in this file; re-export valid material levels.',
      );
    const coverage = (def.extras as { MSFT_screencoverage?: unknown } | undefined)?.MSFT_screencoverage;
    if (
      coverage !== undefined &&
      (!Array.isArray(coverage) ||
        coverage.length > ids.length + 1 ||
        coverage.some((v, i) => typeof v !== 'number' || !(v > 0 && v <= 1) || (i > 0 && v >= coverage[i - 1])))
    )
      throw new TypeError(
        'MSFT_screencoverage needs decreasing numbers in (0,1], at most one per material level; correct the hints.',
      );
    out.push({
      material,
      levels: [material, ...ids],
      ...(coverage ? { screenCoverage: [...(coverage as number[])] } : {}),
    });
  });
  const chains = new Map(out.map((entry) => [entry.material, entry.levels.slice(1)])),
    state = new Uint8Array(definitions.length);
  for (const material of chains.keys()) {
    if (state[material] === 2) continue;
    const stack = [{ material, next: 0 }];
    state[material] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1],
        children = chains.get(top.material) ?? [];
      if (top.next === children.length) {
        state[top.material] = 2;
        stack.pop();
        continue;
      }
      const child = children[top.next++];
      if (state[child] === 1)
        throw new TypeError('MSFT_lod material chains contain a cycle; reference strictly lower detail materials.');
      if (state[child] === 0) {
        state[child] = 1;
        stack.push({ material: child, next: 0 });
      }
    }
  }
  return out;
}

/** Settings for material-level screen coverage switching. */
export interface MSFTMaterialLODOptions {
  /** Fraction of a coverage threshold used as a dead band, in [0,1). Default 0.1. */
  hysteresis?: number;
  /** Divides effective coverage; values above 1 choose coarser materials sooner. Default 1. */
  bias?: number;
}
interface MaterialSlot {
  primitive: PBRPrimitive;
  entry: MaterialLODEntry;
  center: readonly number[];
  radius: number;
  level: number;
}
let serial = 0;
/**
 * Switches MSFT_lod materials per primitive using projected bounds and hysteresis. Material texture bindings refresh
 * through the model's API, retaining geometry and deformation buffers. Node levels remain managed by LOD.fromModel.
 * Attach after a progressive model's completion. Material hints choose quality and never hide geometry.
 */
export class MSFTMaterialLOD implements EnginePlugin {
  readonly name = 'msft-material-lod:' + serial++;
  private engine?: Engine;
  private readonly slots: MaterialSlot[];
  private disposed = false;
  /** Hysteresis fraction. Default 0.1. */
  hysteresis: number;
  /** Coverage divisor. Default 1. */
  bias: number;
  constructor(
    readonly model: PBRModel,
    { hysteresis = 0.1, bias = 1 }: MSFTMaterialLODOptions = {},
  ) {
    if (
      typeof hysteresis !== 'number' ||
      typeof bias !== 'number' ||
      !(hysteresis >= 0 && hysteresis < 1) ||
      !(bias > 0 && bias < Infinity)
    )
      throw new RangeError('Invalid material LOD settings; use hysteresis in [0,1) and a finite positive bias.');
    const entries = new Map(readMaterialLODs(model.asset.doc).map((entry) => [entry.material, entry]));
    this.hysteresis = hysteresis;
    this.bias = bias;
    this.slots = [...model.primitives, ...model.pointsAndLines].flatMap((primitive) => {
      const entry = entries.get(primitive.definition.material!);
      if (!entry) return [];
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < primitive.vertices.length; i += 20)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], primitive.vertices[i + k]);
          max[k] = Math.max(max[k], primitive.vertices[i + k]);
        }
      const center = min.map((v, k) => (v + max[k]) / 2);
      const radius = Math.hypot(...min.map((v, k) => max[k] - v)) / 2;
      return [{ primitive, entry, center, radius, level: 0 }];
    });
  }
  /** Attaches a controller, after checking all material chains. */
  static attach(engine: EngineKernel, model: PBRModel, options?: MSFTMaterialLODOptions): MSFTMaterialLOD {
    const value = new MSFTMaterialLOD(model, options);
    engine.use(value);
    return value;
  }
  setup(engine: Engine): void {
    if (this.disposed || this.engine || meshRuntime(this.model.root).engine !== engine)
      throw new MargoError(
        'state',
        'Material LOD needs an unused controller and a model from this engine; create a new controller.',
      );
    this.engine = engine;
  }
  /** Current material level of each managed primitive, in model primitive order. */
  get levels(): readonly number[] {
    return this.slots.map((slot) => slot.level);
  }
  onPreUpdate(): void {
    if (!this.disposed) this.update();
  }
  /** Re-evaluates projected coverage, changing only primitives whose material level changed. */
  update(): void {
    if (this.disposed)
      throw new MargoError('disposed', 'Material LOD is disposed; attach a new controller before updating.');
    const e = this.engine;
    if (!e || this.model.disposed) return;
    if (
      typeof this.hysteresis !== 'number' ||
      typeof this.bias !== 'number' ||
      !(this.hysteresis >= 0 && this.hysteresis < 1) ||
      !(this.bias > 0 && this.bias < Infinity)
    )
      throw new RangeError('Invalid material LOD settings; use hysteresis in [0,1) and a finite positive bias.');
    e.store.tick(false);
    const c = e.camera.matrix,
      yScale = Math.hypot(c[1], c[5], c[9]) || 1 / Math.tan((e.camera.fov * Math.PI) / 360);
    const changes: { primitive: PBRPrimitive; material: number }[] = [],
      chosen: { slot: MaterialSlot; level: number }[] = [];
    for (const slot of this.slots) {
      const m = meshRuntime(slot.primitive.node).matrix,
        [x, y, z] = slot.center;
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12],
        wy = m[1] * x + m[5] * y + m[9] * z + m[13],
        wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const radius = worldRadius(m, 0, slot.radius, wx, wy, wz);
      const w = c.some((v) => v !== 0)
        ? Math.abs(c[3] * wx + c[7] * wy + c[11] * wz + c[15])
        : Math.hypot(wx - e.camera.position[0], wy - e.camera.position[1], wz - e.camera.position[2]);
      const coverage = w ? (radius * yScale) / (w * this.bias) : Infinity;
      const threshold = (level: number) => slot.entry.screenCoverage?.[level - 1] ?? 0.25 * 0.5 ** (level - 1);
      let next = 0;
      while (next + 1 < slot.entry.levels.length && coverage <= threshold(next + 1)) next++;
      if (next < slot.level && coverage <= threshold(slot.level) * (1 + this.hysteresis)) next = slot.level;
      if (next !== slot.level) {
        changes.push({ primitive: slot.primitive, material: slot.entry.levels[next] });
        chosen.push({ slot, level: next });
      }
    }
    if (changes.length) this.model.setPrimitiveMaterials(changes);
    for (const { slot, level } of chosen) slot.level = level;
  }
  /** Restores the initial materials and releases the controller, retaining the caller-owned model. */
  dispose(): void {
    if (this.disposed) return;
    if (!this.model.disposed)
      this.model.setPrimitiveMaterials(this.slots.map(({ primitive }) => ({ primitive, material: undefined })));
    this.disposed = true;
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
