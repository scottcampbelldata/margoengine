/// <reference lib="esnext.disposable" preserve="true" />
// Clean room from RFC 7946 (2016), Haines (1994), Green (2007), Tanner et al. (1998).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import type { TerrainLighting } from './index.js';
import type { TerrainVirtualTexture } from './rvt.js';
import { margoError } from '../../shared/errors.js';

/** A position on a terrain's world XZ plane, in metres. */
export type TerrainOverlayPosition = readonly [number, number];
/** Linear-light fill or stroke style. */
export interface TerrainOverlayStyle {
  /** Linear straight RGBA in 0..1. Default [1,0.25,0,1]. */ color?: readonly [number, number, number, number];
  /** Stroke width (or Point diameter) in world metres, above zero. Default 2. */ width?: number;
}
/** Fixed resource and filter options. */
export interface TerrainOverlayOptions {
  /** Maximum independent primitives, 1..65536. Default 4096. */ maxPrimitives?: number;
  /** Maximum line/polygon segments, 1..1048576. Default 65536. */ maxSegments?: number;
  /** Half-width of the edge filter in cache texels, 0..2. Default 0.5. */ antialias?: number;
  /** Distinct storage binding when sharing an RVT with other collections. Default 120. */ binding?: number;
}
/** RFC 7946 feature information passed to the style function. */
export interface TerrainOverlayFeature {
  /** GeoJSON type. */ type: 'Feature';
  /** Optional feature identifier. */ id?: string | number;
  /** User properties. */ properties: Readonly<Record<string, unknown>> | null;
  /** RFC 7946 geometry, or null. */ geometry: unknown;
}
/** Projection and styling for an imported GeoJSON object, feature, or collection. */
export interface TerrainOverlayGeoJSONOptions {
  /** Converts RFC 7946 longitude, latitude (degrees) to this terrain's local world XZ metres. Required. */
  project: (position: readonly number[]) => TerrainOverlayPosition;
  /** A common style, or per-feature style. Geometry-only inputs receive a feature with null properties. */
  style?: TerrainOverlayStyle | ((feature: TerrainOverlayFeature) => TerrainOverlayStyle);
}

interface OverlayPrimitive {
  segments: [number, number, number, number][];
  bounds: [number, number, number, number];
  color: [number, number, number, number];
  width: number;
  polygon: boolean;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function position(v: readonly number[]): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isFinite(n) && Number.isFinite(Math.fround(n))))
    throw new RangeError('Invalid overlay position; give two finite world XZ coordinates representable as float32.');
  return [v[0], v[1]];
}
function styleOf(style: TerrainOverlayStyle = {}): { color: [number, number, number, number]; width: number } {
  const color = style.color ?? [1, 0.25, 0, 1],
    width = style.width ?? 2;
  if (
    !Array.isArray(color) ||
    color.length !== 4 ||
    !color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
    !Number.isFinite(width) ||
    !Number.isFinite(Math.fround(width)) ||
    width <= 0
  )
    throw new RangeError('Invalid overlay style; give linear RGBA channels 0..1 and width in metres above zero.');
  return { color: [color[0], color[1], color[2], color[3]], width };
}
function primitive(
  paths: readonly (readonly TerrainOverlayPosition[])[],
  polygon: boolean,
  style: TerrainOverlayStyle,
): OverlayPrimitive {
  if (!Array.isArray(paths) || !paths.length)
    throw new TypeError('Invalid overlay paths; give at least one line or polygon ring.');
  const s = styleOf(style),
    segments: [number, number, number, number][] = [];
  let minX = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  for (const path of paths) {
    if (!Array.isArray(path) || path.length < (polygon ? 3 : 1))
      throw new RangeError('Invalid overlay path; give at least three polygon vertices or one point.');
    const points = path.map(position);
    for (const [x, z] of points) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
    const closed = points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1];
    const count = polygon && !closed ? points.length : Math.max(1, points.length - 1);
    for (let k = 0; k < count; k++) {
      const a = points[k],
        b = points[(k + 1) % points.length];
      segments.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return { ...s, polygon, segments, bounds: [minX, minZ, maxX, maxZ] };
}
function geoPrimitives(input: unknown, options: TerrainOverlayGeoJSONOptions): OverlayPrimitive[] {
  if (typeof options?.project !== 'function')
    throw new TypeError('GeoJSON needs a projection; pass project(longitudeLatitude) returning local XZ metres.');
  const out: OverlayPrimitive[] = [];
  const point = (value: unknown): TerrainOverlayPosition => {
    if (
      !Array.isArray(value) ||
      value.length < 2 ||
      !value.every((v) => typeof v === 'number' && Number.isFinite(v)) ||
      value[0] < -180 ||
      value[0] > 180 ||
      value[1] < -90 ||
      value[1] > 90
    )
      throw new RangeError(
        'Invalid GeoJSON position; give finite longitude -180..180 and latitude -90..90, with optional altitude.',
      );
    // Pass a copy: neither caller arrays nor subsequent projection mutation can alias stored coordinates.
    return position(options.project([...value]));
  };
  const path = (value: unknown, ring: boolean): TerrainOverlayPosition[] => {
    if (!Array.isArray(value) || value.length < (ring ? 4 : 2))
      throw new RangeError('Invalid GeoJSON path; give two line positions or four positions in a closed ring.');
    if (ring) {
      const a = value[0],
        b = value.at(-1);
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.every((v, i) => v === b[i]))
        throw new RangeError('Open GeoJSON polygon ring; repeat the first position at the end.');
    }
    return value.map(point);
  };
  const list = (v: unknown): unknown[] => {
    if (!Array.isArray(v)) throw new TypeError('Invalid GeoJSON coordinates; supply an array.');
    return v;
  };
  const geometry = (value: unknown, style: TerrainOverlayStyle): void => {
    if (!record(value) || typeof value.type !== 'string')
      throw new TypeError('Invalid GeoJSON geometry; supply a standard geometry object.');
    const c = value.coordinates;
    switch (value.type) {
      case 'Point':
        out.push(primitive([[point(c)]], false, style));
        break;
      case 'MultiPoint':
        for (const p of list(c)) out.push(primitive([[point(p)]], false, style));
        break;
      case 'LineString':
        if (list(c).length) out.push(primitive([path(c, false)], false, style));
        break;
      case 'MultiLineString':
        for (const p of list(c)) out.push(primitive([path(p, false)], false, style));
        break;
      case 'Polygon':
        if (list(c).length)
          out.push(
            primitive(
              list(c).map((p) => path(p, true)),
              true,
              style,
            ),
          );
        break;
      case 'MultiPolygon':
        for (const p of list(c))
          if (list(p).length)
            out.push(
              primitive(
                list(p).map((r) => path(r, true)),
                true,
                style,
              ),
            );
        break;
      case 'GeometryCollection':
        for (const g of list(value.geometries)) geometry(g, style);
        break;
      default:
        throw new TypeError(
          'Unsupported GeoJSON geometry; supply Point, LineString, Polygon, their Multi forms or GeometryCollection.',
        );
    }
  };
  const visit = (value: unknown): void => {
    if (!record(value))
      throw new TypeError('Invalid GeoJSON input; supply a geometry, Feature or FeatureCollection object.');
    if (value.type === 'FeatureCollection') {
      for (const feature of list(value.features)) {
        if (!record(feature) || feature.type !== 'Feature')
          throw new TypeError('Invalid GeoJSON features; use Feature objects in a FeatureCollection.');
        visit(feature);
      }
    } else {
      const feature: TerrainOverlayFeature =
        value.type === 'Feature'
          ? (value as unknown as TerrainOverlayFeature)
          : { type: 'Feature', properties: null, geometry: value };
      if (feature.properties !== null && !record(feature.properties))
        throw new TypeError('Invalid GeoJSON properties; give an object or null.');
      if (feature.geometry === null) return;
      const style = typeof options.style === 'function' ? options.style(feature) : (options.style ?? {});
      geometry(feature.geometry, style);
    }
  };
  visit(input);
  return out;
}

let nextId = 0;
/** Ground-clamped metre-width strokes, filled polygons with holes and projected GeoJSON, baked through an RVT. */
export class TerrainOverlays implements EnginePlugin, TerrainLighting, Disposable {
  readonly name = 'terrain-overlays:' + nextId++;
  /** Owning engine while attached. */ owner?: Engine;
  /** Whether the collection has been disposed. */ disposed = false;
  readonly #options: Required<TerrainOverlayOptions>;
  readonly #items = new Map<number, OverlayPrimitive[]>();
  #next = 0;
  #device?: GPUDevice;
  #buffer?: GPUBuffer;
  #remove?: () => void;
  #code = new Map<string, string>();

  constructor(
    private readonly rvt: TerrainVirtualTexture,
    options: TerrainOverlayOptions = {},
  ) {
    if (!rvt || typeof rvt.addSurface !== 'function' || typeof rvt.invalidate !== 'function')
      throw new TypeError('Invalid overlay target; pass a TerrainVirtualTexture with surface support.');
    this.#options = {
      maxPrimitives: options.maxPrimitives ?? 4096,
      maxSegments: options.maxSegments ?? 65536,
      antialias: options.antialias ?? 0.5,
      binding: options.binding ?? 120,
    };
    if (
      !Number.isInteger(this.#options.maxPrimitives) ||
      this.#options.maxPrimitives < 1 ||
      this.#options.maxPrimitives > 65536 ||
      !Number.isInteger(this.#options.maxSegments) ||
      this.#options.maxSegments < 1 ||
      this.#options.maxSegments > 1048576 ||
      !Number.isFinite(this.#options.antialias) ||
      !(this.#options.antialias >= 0 && this.#options.antialias <= 2) ||
      !Number.isInteger(this.#options.binding) ||
      this.#options.binding < 0 ||
      this.#options.binding >= 1000
    )
      throw new RangeError(
        'Invalid overlay limits; give maxPrimitives 1..65536, maxSegments 1..1048576, antialias 0..2 and binding 0..999.',
      );
  }
  /** Attaches to an RVT on the same engine. The RVT and terrain remain borrowed. */
  static attach(
    engine: EngineKernel,
    rvt: TerrainVirtualTexture,
    options: TerrainOverlayOptions = {},
  ): TerrainOverlays {
    const overlay = new TerrainOverlays(rvt, options);
    engineRuntime(engine).use(overlay);
    return overlay;
  }
  /** Number of user overlays; one GeoJSON collection is one overlay with many primitives. */ get length(): number {
    return this.#items.size;
  }
  /** Stable IDs in bottom-to-top paint order. */ get order(): readonly number[] {
    return [...this.#items.keys()];
  }
  #live(): void {
    if (this.disposed) throw margoError('disposed', 'Terrain overlays are disposed; attach a new collection.');
  }
  #existing(id: number): OverlayPrimitive[] {
    const item = this.#items.get(id);
    if (!item) throw new RangeError('Unknown overlay ID; use an ID returned by addPolyline, addPolygon or addGeoJSON.');
    return item;
  }
  #change(id: number, value: OverlayPrimitive[], existing: boolean): number {
    this.#live();
    const previous = existing ? this.#existing(id) : [];
    const primitives = [...this.#items]
      .filter(([key]) => key !== id)
      .flatMap(([, shapes]) => shapes)
      .concat(value);
    const segments = primitives.reduce((sum, p) => sum + p.segments.length, 0);
    if (primitives.length > this.#options.maxPrimitives || segments > this.#options.maxSegments)
      throw new RangeError(
        'Overlay resource budget exceeded; remove primitives or raise maxPrimitives/maxSegments within device limits.',
      );
    const bytes = (1 + primitives.length * 3 + segments) * 16;
    if (this.#device && bytes > this.#device.limits.maxStorageBufferBindingSize)
      throw new RangeError('Overlay storage exceeds device limits; reduce the geometry.');
    this.#items.set(id, value);
    if (!existing) this.#next++;
    this.#write();
    this.#dirty(previous);
    this.#dirty(value);
    return id;
  }
  /** Adds a round-cap/round-join polyline with width in metres. A single position draws a round point. */
  addPolyline(points: readonly TerrainOverlayPosition[], style: TerrainOverlayStyle = {}): number {
    return this.#change(this.#next, [primitive([points], false, style)], false);
  }
  /** Adds a filled polygon: first ring is exterior, subsequent rings are holes; open direct rings close automatically. */
  addPolygon(rings: readonly (readonly TerrainOverlayPosition[])[], style: TerrainOverlayStyle = {}): number {
    return this.#change(this.#next, [primitive(rings, true, style)], false);
  }
  /** Adds any RFC 7946 geometry or feature collection, projecting degrees to terrain metres and ignoring altitude. */
  addGeoJSON(input: unknown, options: TerrainOverlayGeoJSONOptions): number {
    return this.#change(this.#next, geoPrimitives(input, options), false);
  }
  /** Replaces a stroke live, retaining its ID and paint order. */
  setPolyline(id: number, points: readonly TerrainOverlayPosition[], style: TerrainOverlayStyle = {}): void {
    this.#change(id, [primitive([points], false, style)], true);
  }
  /** Replaces a filled polygon live, retaining its ID and paint order. */
  setPolygon(id: number, rings: readonly (readonly TerrainOverlayPosition[])[], style: TerrainOverlayStyle = {}): void {
    this.#change(id, [primitive(rings, true, style)], true);
  }
  /** Reprojects/replaces a GeoJSON overlay atomically; invalid input preserves the previous drawing. */
  setGeoJSON(id: number, input: unknown, options: TerrainOverlayGeoJSONOptions): void {
    this.#change(id, geoPrimitives(input, options), true);
  }
  /** Changes every primitive's color/width in one overlay without changing its positions. */
  setStyle(id: number, style: TerrainOverlayStyle): void {
    const shapes = this.#existing(id).map((s) => ({ ...s, ...styleOf({ color: s.color, width: s.width, ...style }) }));
    this.#change(id, shapes, true);
  }
  /** Removes an overlay and invalidates its previous painted footprint. */
  remove(id: number): boolean {
    this.#live();
    const item = this.#items.get(id);
    if (!item) return false;
    this.#items.delete(id);
    this.#write();
    this.#dirty(item);
    return true;
  }
  /** Moves an overlay in bottom-to-top paint order. */
  move(id: number, index: number): void {
    this.#live();
    const item = this.#existing(id);
    if (!Number.isInteger(index) || index < 0 || index >= this.length)
      throw new RangeError('Invalid overlay order; use an index in 0..length-1.');
    const items = [...this.#items].filter(([key]) => key !== id);
    items.splice(index, 0, [id, item]);
    this.#items.clear();
    for (const [key, value] of items) this.#items.set(key, value);
    this.#write();
    for (const [, value] of items) this.#dirty(value);
  }
  #dirty(shapes: readonly OverlayPrimitive[]): void {
    const aa = this.rvt.texel * 2 ** (this.rvt.levels - 1) * this.#options.antialias;
    for (const s of shapes) {
      const pad = (s.polygon ? 0 : s.width / 2) + aa,
        b = s.bounds;
      this.rvt.invalidate(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad);
    }
  }
  #write(): void {
    if (!this.#device) return;
    const shapes = [...this.#items.values()].flat(),
      segments = shapes.reduce((n, s) => n + s.segments.length, 0);
    const values = new Float32Array((1 + shapes.length * 3 + segments) * 4);
    values.set([shapes.length, this.#options.antialias, 0, 0]);
    let segment = 1 + shapes.length * 3;
    shapes.forEach((s, i) => {
      const at = (1 + i * 3) * 4;
      values.set(s.bounds, at);
      values.set(s.color, at + 4);
      values.set([segment, s.segments.length, s.polygon ? 1 : 0, s.width / 2], at + 8);
      for (const edge of s.segments) {
        values.set(edge, segment * 4);
        segment++;
      }
    });
    if (values.byteLength > this.#device.limits.maxStorageBufferBindingSize)
      throw new RangeError('Overlay storage exceeds device limits; reduce primitives or segments.');
    if (!this.#buffer || this.#buffer.size < values.byteLength) {
      const buffer = this.#device.createBuffer({ size: values.byteLength, usage: 0x80 | 0x8 });
      this.#buffer?.destroy();
      this.#buffer = buffer;
    }
    this.#device.queue.writeBuffer(this.#buffer, 0, values);
  }
  setup(engine: Engine): void {
    this.#live();
    if (!engine.gpu) throw margoError('unsupported', 'Terrain overlays require a GPU device; attach to a GPU engine.');
    if (this.rvt.disposed || (this.rvt.owner && this.rvt.owner !== engine))
      throw margoError('attached', 'Terrain overlays require a live RVT on the same engine; attach them together.');
    this.owner = engine;
    this.#device = engine.gpu;
    this.#write();
    this.#remove ??= this.rvt.addSurface(this);
  }
  /** Read-only storage used by the RVT bake and its steep/far fallback. */
  bindings(): GPUBindGroupEntry[] {
    return this.#buffer ? [{ binding: this.#options.binding, resource: { buffer: this.#buffer } }] : [];
  }
  /** Paints the actual RVT surface and the uncached fallback with identical segment-distance/even-odd coverage. */
  shader(source: string, group: number): string {
    const key = group + source,
      cached = this.#code.get(key);
    if (cached) return cached;
    const name = 'terrainOverlay' + this.#options.binding;
    const marker = 'return terrainSurfaceColor;';
    if (!source.includes(marker))
      throw margoError(
        'unsupported',
        'Overlay shader needs the RVT bake or reader fallback; attach through TerrainVirtualTexture.addSurface.',
      );
    const patched = source.replace(
      marker,
      `terrainSurfaceColor=${name}(terrainSurfaceColor,position,footprint);${marker}`,
    );
    const code =
      `@group(${group}) @binding(${this.#options.binding}) var<storage,read> ${name}Data:array<vec4f>;
fn ${name}(color:vec3f,p:vec2f,footprint:f32)->vec3f {
  var result=color;let header=${name}Data[0];let aa=max(footprint*header.y,0.000001);
  for(var k=0u;k<u32(header.x);k++){
    let box=${name}Data[1u+k*3u];let style=${name}Data[2u+k*3u];let rule=${name}Data[3u+k*3u];
    let margin=select(rule.w,0.0,rule.z>0.5)+aa;
    if(any(p<box.xy-vec2f(margin))||any(p>box.zw+vec2f(margin))||style.a<=0.0){continue;}
    var distance=3.402823e38;var inside=false;
    for(var j=0u;j<u32(rule.y);j++){
      let edge=${name}Data[u32(rule.x)+j];let a=edge.xy;let b=edge.zw;let delta=b-a;
      let t=clamp(dot(p-a,delta)/max(dot(delta,delta),1e-30),0.0,1.0);distance=min(distance,length(p-a-t*delta));
      if((a.y>p.y)!=(b.y>p.y)){let crossing=a.x+(p.y-a.y)*(b.x-a.x)/(b.y-a.y);if(p.x<crossing){inside=!inside;}}
    }
    var signedDistance=distance-rule.w;
    if(rule.z>0.5){signedDistance=select(distance,-distance,inside);}
    var coverage=select(0.0,1.0,signedDistance<=0.0);if(header.y>0.0){coverage=1.0-smoothstep(-aa,aa,signedDistance);}result=mix(result,style.rgb,style.a*coverage);
  }return result;
}\n` + patched;
    this.#code.set(key, code);
    return code;
  }
  /** Reuploads retained vector data without replacing the borrowed RVT or its registration. */
  onDeviceRestored(engine: Engine): void {
    this.#buffer?.destroy();
    this.#buffer = undefined;
    this.setup(engine);
    this.rvt.invalidate();
  }
  /** Removes its RVT provider and scene registration, destroys owned storage, and retains the borrowed terrain/RVT. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.#buffer?.destroy();
    this.#buffer = undefined;
    this.#device = undefined;
    this.#code.clear();
    this.#items.clear();
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.owner = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
