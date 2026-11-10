/// <reference lib="esnext.disposable" preserve="true" />
// Optional declarative styling. The interpreter is independent of rendering and never executes supplied JavaScript.
import type { PBRModel, PBRPrimitive } from '@margoengine/gltf-pro';
import type { PBRInstances } from '@margoengine/gltf-pro/instancing';
import type { PointCloud } from '@margoengine/points';
import { SRGBToLinear } from '@margoengine/math/color';
import { MargoError } from '@margoengine/math/errors';
import { expression, type Expression, type Read } from './style-expression.js';
import { readStructuralMetadata } from './metadata.js';
import type { TilesDecorationContext, TilesContentDecoration } from './renderer.js';

/** An expression, literal, or first-matching ordered condition list. */
export type StyleExpression =
  | string
  | number
  | boolean
  | { conditions: readonly (readonly [string, string | number | boolean])[] };
/** The visual properties of an OGC 3D Tiles style. Defaults: white, visible, 1 pixel. */
export interface TileStyleJSON {
  color?: StyleExpression;
  show?: StyleExpression;
  pointSize?: StyleExpression;
  /** Defines read feature properties directly, including properties having the same name. */
  defines?: Readonly<Record<string, string>>;
  meta?: Readonly<Record<string, StyleExpression>>;
}
/** One evaluated style, in sRGB RGBA; undefined means no condition matched. */
export interface FeatureStyle {
  color?: readonly number[];
  show?: boolean;
  pointSize?: number;
  meta: Readonly<Record<string, unknown>>;
}
/** Reusable live styling binding. Updating replaces the previous style; disposal restores the authored data. */
export interface TileStyleBinding extends Disposable {
  update(style: TilesStyle): void;
  dispose(): void;
}
/** Feature properties as an object or a property lookup (for example a BatchTable row). */
export type StyleProperties = Readonly<Record<string, unknown>> | ((name: string) => unknown);
function compile(value: StyleExpression | undefined, fallback: unknown): Expression {
  if (value === undefined) return () => fallback;
  if (typeof value === 'string') return expression(value);
  if (typeof value !== 'object' || value === null) return () => value;
  const pairs = value.conditions.map(([condition, result]) => [expression(condition), compile(result, undefined)]);
  return (read) => {
    for (const [test, result] of pairs) {
      const hit = test(read);
      if (typeof hit !== 'boolean')
        throw new MargoError('state', 'Style condition must return a boolean; compare the property explicitly');
      if (hit) return result(read);
    }
    return undefined;
  };
}
const unit = (v: number) => Math.max(0, Math.min(1, v));
const linear = (c: readonly number[]) => c.map((v, i) => (i < 3 ? SRGBToLinear(unit(v)) : unit(v)));
function binding(apply: (style: TilesStyle) => void, restore: () => void, initial: TilesStyle): TileStyleBinding {
  let disposed = false;
  const result = {
    update(style: TilesStyle) {
      if (disposed) throw new MargoError('disposed', 'Style binding is disposed; create a new binding');
      apply(style);
    },
    dispose() {
      if (!disposed) {
        restore();
        disposed = true;
      }
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
  result.update(initial);
  return result;
}

/** Compiled, reusable OGC style with conditions, defines, vectors, math, strings and regular expressions. */
export class TilesStyle {
  private readonly color: Expression;
  private readonly show: Expression;
  private readonly pointSize: Expression;
  private readonly defines: Map<string, Expression>;
  private readonly meta: Map<string, Expression>;
  constructor(style: TileStyleJSON = {}) {
    this.color = compile(style.color, [1, 1, 1, 1]);
    this.show = compile(style.show, true);
    this.pointSize = compile(style.pointSize, 1);
    this.defines = new Map(Object.entries(style.defines ?? {}).map(([k, v]) => [k, expression(v)]));
    this.meta = new Map(Object.entries(style.meta ?? {}).map(([k, v]) => [k, compile(v, undefined)]));
  }
  /**
   * Pass as TilesRenderer's `decorate` option. Reads b3dm batch properties, pnts BATCH_ID and point semantics,
   * i3dm BATCH_ID and structural metadata attribute/implicit sets. Eviction releases every saved styling array.
   */
  readonly decorate = (context: TilesDecorationContext): TilesContentDecoration => {
    const bindings: TileStyleBinding[] = [];
    let bytes = 0;
    const content = context.content;
    if (context.kind === 'points') {
      const cloud = context.cloud as PointCloud,
        points = context.content;
      bindings.push(
        this.bindPoints(cloud, (i) => {
          const source = cloud.sourceIndex?.[i] ?? i,
            id = points.batchIds?.[source] ?? source;
          return (name) =>
            name === 'POSITION' || name === 'POSITION_ABSOLUTE'
              ? Array.from(
                  points.positions.subarray(source * 3, source * 3 + 3),
                  (v, k) => v + (name === 'POSITION_ABSOLUTE' ? (points.rtcCenter?.[k] ?? 0) : 0),
                )
              : name === 'COLOR'
                ? Array.from((points.colors ?? []).slice(source * 4, source * 4 + 4), (v) => v / 255)
                : points.batchTable?.get(id, name);
        }),
      );
      bytes = cloud.count * (4 + (points.colors ? 0 : 4)); // added GPU size buffer and, if absent, colour buffer
    } else if (context.kind === 'instances') {
      const model = context.model as PBRModel,
        instances = context.content;
      const ids = instances.featureTable.property(
        'BATCH_ID',
        instances.length,
        1,
        (
          instances.featureTable.json.BATCH_ID as
            | { componentType?: 'UNSIGNED_BYTE' | 'UNSIGNED_SHORT' | 'UNSIGNED_INT' }
            | undefined
        )?.componentType ?? 'UNSIGNED_SHORT',
      );
      for (const rows of new Set(model.primitives.map((p) => p.instances).filter((p) => p !== undefined))) {
        bindings.push(this.bindInstances(rows, (i) => (name) => instances.batchTable?.get(ids?.[i] ?? i, name)));
      }
      const saved = model.primitives.map((p) => ({ material: p.material, extension: p.extension }));
      model.primitives.forEach((p) => {
        p.material = { ...p.material, settings: [2, ...p.material.settings.slice(1)] };
        p.extension = { ...p.extension, wgsl: (p.extension?.wgsl ?? '') + '\nif(i.color.a <= 0.0){discard;}' };
      });
      bindings.push({
        update() {},
        dispose() {
          model.primitives.forEach((p, i) => Object.assign(p, saved[i]));
        },
        [Symbol.dispose]() {
          this.dispose();
        },
      });
    } else {
      const model = context.model as PBRModel;
      if (!model.asset || !Array.isArray(model.primitives))
        throw new MargoError(
          'unsupported',
          'Tile styling needs PBRModel primitives and asset; return a gltf-pro model from loadModel',
        );
      const metadata = readStructuralMetadata(context.content.gltf, { buffer: (index) => model.asset.buffers[index] });
      const lookups = new Map<PBRPrimitive, (vertex: number) => StyleProperties>();
      for (const p of model.primitives) {
        const mesh = model.asset.doc.meshes?.findIndex((m) => m.primitives.includes(p.definition)) ?? -1;
        const primitive = model.asset.doc.meshes?.[mesh]?.primitives.indexOf(p.definition) ?? -1;
        const batch = p.definition.attributes?._BATCHID ?? p.definition.attributes?._BATCH_ID;
        const ids = batch === undefined ? undefined : model.asset.accessor(batch, 'SCALAR');
        lookups.set(p, (vertex) =>
          ids
            ? (name) => content.batchTable?.get(ids[vertex], name)
            : (metadata.feature(mesh, primitive, vertex)?.properties ?? content.batchTable?.feature(0) ?? {}),
        );
      }
      bindings.push(this.bindModel(model, (p, v) => lookups.get(p)!(v)));
    }
    return {
      bytes,
      dispose: () => {
        for (const handle of bindings) handle.dispose();
      },
    };
  };
  /** Evaluates one feature; no properties yields the implicit single feature. Throws coded invalid for wrong output types. */
  evaluate(properties: StyleProperties = {}): FeatureStyle {
    const raw: Read =
      typeof properties === 'function'
        ? properties
        : (name) => (Object.hasOwn(properties, name) ? properties[name] : undefined);
    const read: Read = (name) => (this.defines.has(name) ? this.defines.get(name)!(raw) : raw(name));
    const color = this.color(read),
      show = this.show(read),
      pointSize = this.pointSize(read);
    if (
      color !== undefined &&
      (!Array.isArray(color) || color.length !== 4 || color.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    )
      throw new MargoError('state', 'Style color must return four finite components; use color(), rgb() or vec4()');
    if (show !== undefined && typeof show !== 'boolean')
      throw new MargoError('state', 'Style show must return a boolean; compare the property explicitly');
    if (pointSize !== undefined && (typeof pointSize !== 'number' || !Number.isFinite(pointSize) || pointSize < 0))
      throw new MargoError('state', 'Style pointSize must return a finite non-negative number; clamp its expression');
    return {
      color: color === undefined ? undefined : Array.from(color as number[]),
      show: show as boolean | undefined,
      pointSize: pointSize as number | undefined,
      meta: Object.fromEntries([...this.meta].map(([k, v]) => [k, v(read)])),
    };
  }
  /**
   * Styles a loaded PBR model. Resolve properties per vertex (from a batch table, feature ID attribute or texture).
   * Vertex RGB multiplies the authored colour in linear light. Hidden vertices discard in every surface pass.
   * Bind before animation/deformation or shared geometry, as required by PBRModel.writeGeometry.
   */
  bindModel(
    model: PBRModel,
    properties: (primitive: PBRPrimitive, vertex: number) => StyleProperties,
  ): TileStyleBinding {
    const saved = model.primitives.map((p) => ({
      vertices: p.vertices.slice(),
      indices: p.indices,
      uvs: p.uvs,
      material: p.material,
      extension: p.extension,
    }));
    const restore = () => {
      model.primitives.forEach((p, i) => {
        p.material = saved[i].material;
        p.extension = saved[i].extension;
      });
      model.writeGeometry(saved);
    };
    return binding(
      (style) => {
        const values = model.primitives.map((p, index) => {
          const original = saved[index],
            vertices = original.vertices.slice();
          let alpha = false;
          for (let vertex = 0; vertex < vertices.length / 20; vertex++) {
            const value = style.evaluate(properties(p, vertex)),
              color = linear(value.color ?? [1, 1, 1, 1]);
            if (value.show === false) color[3] = 0;
            if (color[3] < 1) alpha = true;
            for (let c = 0; c < 4; c++) vertices[vertex * 20 + 16 + c] *= color[c];
          }
          return { ...original, vertices, alpha };
        });
        // Evaluate every feature before mutating the model, so a malformed style leaves the old appearance intact.
        model.writeGeometry(values);
        model.primitives.forEach((p, i) => {
          const original = saved[i];
          p.material = { ...original.material, settings: original.material.settings.slice() };
          if (values[i].alpha) p.material.settings[0] = 2;
          p.extension = {
            ...original.extension,
            wgsl: (original.extension?.wgsl ?? '') + '\nif(i.color.a <= 0.0){discard;}',
          };
        });
      },
      restore,
      this,
    );
  }
  /** Styles points by their current cloud index. Use sourceIndex when mapping metadata of a spatially sorted cloud. */
  bindPoints(cloud: PointCloud, properties: (point: number) => StyleProperties): TileStyleBinding {
    const colors = cloud.colors?.slice() ?? null,
      sizes = cloud.sizes?.slice() ?? null;
    const floats = cloud.floatColors?.slice() ?? null;
    const original = {
      size: cloud.material.size,
      minPixelSize: cloud.material.minPixelSize,
      maxPixelSize: cloud.material.maxPixelSize,
      sizeUnits: cloud.material.sizeUnits,
      vertexColors: cloud.material.vertexColors,
      transparent: cloud.material.transparent,
      alphaTest: cloud.material.alphaTest,
    };
    const restore = () => {
      cloud.setColors(floats ?? (colors && new Uint8Array(colors.buffer)), 4);
      cloud.setSizes(sizes);
      Object.assign(cloud.material, original);
    };
    return binding(
      (style) => {
        const rgba = new Float32Array(cloud.count * 4),
          scale = new Float32Array(cloud.count);
        for (let i = 0; i < cloud.count; i++) {
          const v = style.evaluate(properties(i)),
            c = v.color ?? [1, 1, 1, 1];
          for (let k = 0; k < 4; k++) rgba[i * 4 + k] = c[k];
          if (v.show === false) rgba[i * 4 + 3] = 0;
          scale[i] = v.show === false ? 0 : (v.pointSize ?? original.size * (sizes?.[i] ?? 1));
        }
        cloud.setColors(
          cloud.colorFormat === 'float'
            ? Float32Array.from(rgba, (v, i) =>
                i % 4 < 3 && cloud.colorSpace === 'linear' ? SRGBToLinear(unit(v)) : unit(v),
              )
            : Uint8Array.from(rgba, (v) => Math.round(unit(v) * 255)),
          4,
        );
        cloud.setSizes(scale);
        cloud.material.size = 1;
        cloud.material.sizeUnits = 'pixels';
        cloud.material.minPixelSize = 0;
        cloud.material.maxPixelSize = scale.reduce((maximum, value) => Math.max(maximum, value), 1);
        cloud.material.vertexColors = true;
        cloud.material.transparent = true;
        cloud.material.alphaTest = Math.max(2 ** -126, original.alphaTest);
      },
      restore,
      this,
    );
  }
  /** Styles i3dm or glTF instance rows. Visibility uses a degenerate transform, retaining stable picking IDs. */
  bindInstances(instances: PBRInstances, properties: (instance: number) => StyleProperties): TileStyleBinding {
    const saved = instances.data.slice();
    const restore = () => {
      for (let i = 0; i < instances.count; i++) {
        instances.setMatrixAt(i, saved.subarray(i * 24, i * 24 + 16));
        instances.setColorAt(i, saved.subarray(i * 24 + 16, i * 24 + 20));
      }
    };
    return binding(
      (style) => {
        const evaluated = Array.from({ length: instances.count }, (_, i) => style.evaluate(properties(i)));
        evaluated.forEach((v, i) => {
          const matrix = saved.slice(i * 24, i * 24 + 16),
            c = linear(v.color ?? [1, 1, 1, 1]);
          if (v.show === false) for (let k = 0; k < 12; k++) matrix[k] = 0;
          instances.setMatrixAt(i, matrix);
          instances.setColorAt(
            i,
            c.map((x, k) => x * saved[i * 24 + 16 + k]),
          );
        });
      },
      restore,
      this,
    );
  }
}
