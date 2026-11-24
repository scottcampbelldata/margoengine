/// <reference lib="esnext.disposable" preserve="true" />
// IFC models on the GPU through @margoengine/materials. readIFCMeshes reads each product's placed geometries once
// (web-ifc's geometryExpressID names a representation an IfcMappedItem repeats); createIFCScene draws a geometry
// placed `instancing` times or more as one instanced mesh and batches the rest into BatchedMesh draws of up to
// 1,000,000 vertices, so a model costs a handful of draw calls per pass. Every element keeps its parts, so it can be
// hidden, isolated, ghosted (a translucent copy, as an x-ray view draws it), recoloured or made translucent, picked
// (instance index, or the element slot the batch writes into UV0 for HitDetails) and cut by section planes, a
// section box or a storey plan. applyBCFView and bcfView carry a viewpoint both ways through /bcf.
import type { EngineKernel } from '@margoengine/core';
import { Material, createInstancedMesh, type InstancedMesh, type MeshGeometry } from '@margoengine/materials';
import type { MaterialMesh } from '@margoengine/materials';
import { BatchedMesh } from '@margoengine/materials/batched';
import type { BCFView, BCFViewInput } from './bcf.js';
import type { IFCData } from './data.js';
import type { IFCMeshes, IFCMeshGeometry, IFCPlacement } from './meshes.js';
import { fail } from './open.js';

export {
  readIFCMeshes,
  streamIFCMeshes,
  type IFCMeshChunk,
  type IFCMeshGeometry,
  type IFCMeshes,
  type IFCMeshOptions,
  type IFCPlacement,
  type IFCStreamOptions,
} from './meshes.js';

/** Options of createIFCScene. Colours are sRGB components 0..1. */
export interface IFCSceneOptions {
  /** A geometry placed this many times or more (opaque placements) draws as one instanced mesh. 0 batches all. Default 2. */
  instancing?: number;
  /** Vertices per batch, 3 to 1,000,000; a larger geometry draws as its own mesh. Default 1,000,000. */
  batchVertices?: number;
  /** Draw both faces of every triangle (IFC tessellations often mix windings). Default true. */
  doubleSided?: boolean;
  /** Colour of ghosted elements. Default [0.62, 0.72, 0.86]. */
  ghostColor?: readonly number[];
  /** Opacity of ghosted elements, 0 to 1. Default 0.15. */
  ghostOpacity?: number;
  /** Colour of selected elements. Default [0.1, 0.55, 1]. */
  selectionColor?: readonly number[];
  /** The model's readIFCData result: storeyPlan needs its storeys. */
  data?: IFCData;
}
/** One element's display state. */
export interface IFCElementState {
  hidden: boolean;
  ghosted: boolean;
  selected: boolean;
  /** Override colour (sRGB), or undefined for the file's colours. */
  color?: [number, number, number];
  /** Override opacity below 1, or undefined. */
  opacity?: number;
}
/** What storeyPlan returns: the cut and a top-down orthographic camera over the storey. */
export interface IFCStoreyPlan {
  /** The storey's elevation and the cut height above it, engine Y in meters. */
  elevation: number;
  cut: number;
  clippingPlanes: number[][];
  camera: { type: 'orthogonal'; position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; height: number };
}

type RGB = [number, number, number];
/** A batch item; a batch that grows moves its items, so `batch` and `item` change and `make` rebuilds the geometry. */
type Item = { batch: BatchedMesh; item: number; make: () => MeshGeometry; vertices: number; indices: number };
type Part = {
  owner: Slot;
  geometry: IFCMeshGeometry;
  matrix: Float32Array;
  /** Linear rgb and alpha as the file gives it. */
  color: [number, number, number, number];
  item?: Item;
  instance?: { group: Group; index: number };
};
type Group = { mesh: InstancedMesh; slots: number[]; white: MeshGeometry };
/** A geometry's opaque placements so far, its instance group once it has one, and its batched opaque parts until then. */
type Use = { uses: number; group?: Group; batched: Part[] };
interface Slot extends IFCElementState {
  id: number;
  /** Its place in `order`: the instance and UV0 picking maps hold it. */
  index: number;
  parts: Part[];
  /** Translucent copies drawn for a ghost or an opacity override. */
  overlay: Item[];
  /** The overlay's colour and alpha, so an unchanged state keeps its copies. */
  overlayKey?: string;
  srgb?: RGB;
}

const ZERO = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function rgbOf(c: readonly number[] | undefined, what: string, fallback: RGB): RGB {
  if (c === undefined) return fallback;
  if (!Array.isArray(c) || c.length < 3 || c.slice(0, 3).some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    fail('range', `${what} must be three sRGB components from 0 to 1`);
  return [c[0], c[1], c[2]];
}
const unit = (v: number | undefined, what: string, fallback: number) =>
  v === undefined ? fallback : Number.isFinite(v) && v >= 0 && v <= 1 ? v : fail('range', `${what} must be a number from 0 to 1`);

/** BatchedMeshes of one material: the last batch grows (twice its size, up to `limit`) before a new one opens. */
class Batches {
  readonly list: BatchedMesh[] = [];
  private readonly owners = new Map<BatchedMesh, Set<Item>>();
  constructor(
    private readonly engine: EngineKernel,
    private readonly material: Material,
    readonly limit: number,
  ) {}
  add(make: () => MeshGeometry, matrix: Float32Array, color: RGB, want: { vertices: number; indices: number; items: number }): Item {
    const geometry = make(),
      vertices = geometry.positions.length / 3,
      indices = geometry.indices!.length;
    let batch =
      this.list.find(
        (b) =>
          b.count < b.maxItems &&
          b.usage.vertices + vertices <= b.maxVertices &&
          b.usage.indices + indices <= b.maxIndices,
      ) ?? this.grow(vertices, indices, want);
    if (!batch) {
      const maxVertices = Math.min(this.limit, Math.max(vertices, want.vertices, 3));
      batch = this.open(
        maxVertices,
        Math.max(indices, Math.min(want.indices, maxVertices * 6)),
        Math.min(1_000_000, Math.max(1, want.items)),
      );
    }
    const item: Item = { batch, item: batch.add(geometry, { matrix, color }), make, vertices, indices };
    this.owners.get(batch)!.add(item);
    return item;
  }
  remove(item: Item): void {
    item.batch.remove(item.item);
    this.owners.get(item.batch)?.delete(item);
  }
  dispose(): void {
    for (const b of this.list.splice(0)) b.dispose();
    this.owners.clear();
  }
  private open(maxVertices: number, maxIndices: number, maxItems: number): BatchedMesh {
    const batch = BatchedMesh.attach(this.engine, this.material, {
      maxVertices,
      maxIndices: Math.max(3, Math.ceil(maxIndices / 3) * 3),
      maxItems,
    });
    this.list.push(batch);
    this.owners.set(batch, new Set());
    return batch;
  }
  /**
   * The last batch rebuilt with room for `vertices` and `indices` more (its live items packed, their matrices, tints
   * and visibility kept), or undefined when that would pass the limits. Streamed chunks fill one batch, not one each.
   */
  private grow(vertices: number, indices: number, want: { vertices: number; indices: number; items: number }): BatchedMesh | undefined {
    const old = this.list.at(-1);
    if (!old) return;
    const live = this.owners.get(old)!;
    let v = vertices,
      i = indices;
    for (const item of live) (v += item.vertices), (i += item.indices);
    if (v > this.limit || live.size + 1 > 1_000_000) return;
    const maxVertices = Math.min(this.limit, Math.max(v, old.maxVertices * 2, want.vertices));
    this.list.pop();
    const batch = this.open(
      maxVertices,
      Math.max(i, Math.min(Math.max(old.maxIndices * 2, want.indices), maxVertices * 6)),
      Math.min(1_000_000, Math.max(live.size + 1, old.maxItems * 2, want.items)),
    );
    for (const item of live) {
      const id = item.item;
      item.item = batch.add(item.make(), { matrix: old.getMatrix(id), color: Array.from(old.getColor(id)) as RGB, visible: old.isVisible(id) });
      item.batch = batch;
      this.owners.get(batch)!.add(item);
    }
    this.owners.delete(old);
    old.dispose();
    return batch;
  }
}

/**
 * An IFC model drawn through @margoengine/materials: instanced meshes for repeated geometry, BatchedMesh draws for the
 * rest, and per-element visibility, ghosting, colour, opacity, selection, picking and clipping. Create it with
 * createIFCScene; dispose it to free every mesh, batch and material.
 */
export class IFCScene {
  /** The opaque, translucent and ghost materials: set their shared options here (clipping goes through clippingPlanes). */
  readonly materials: { opaque: Material; translucent: Material };
  /** The model's origin (readIFCMeshes' `origin`). */
  readonly origin: [number, number, number];
  private readonly slots = new Map<number, Slot>();
  private readonly order: Slot[] = [];
  private readonly opaque: Batches;
  private readonly translucent: Batches;
  private readonly groups: Group[] = [];
  /** Every geometry added so far by key, so a later chunk can place one an earlier chunk sent. */
  private readonly known = new Map<number, IFCMeshGeometry>();
  /** Per geometry key; a different geometry under a known key (another model) starts afresh. */
  private readonly uses = new Map<number, Use>();
  private readonly instancing: number;
  private readonly ghost: RGB;
  private readonly ghostOpacity: number;
  private readonly selection: RGB;
  private readonly data?: IFCData;
  private planes: number[][] = [];
  private disposed = false;

  /** @internal Use createIFCScene. */
  constructor(
    private readonly engine: EngineKernel,
    origin: readonly number[],
    options: IFCSceneOptions = {},
  ) {
    const limit = options.batchVertices ?? 1_000_000;
    if (!Number.isSafeInteger(limit) || limit < 3 || limit > 1_000_000)
      fail('range', 'batchVertices must be an integer from 3 to 1,000,000');
    const instancing = options.instancing ?? 2;
    if (!Number.isSafeInteger(instancing) || instancing < 0) fail('range', 'instancing must be a non-negative integer');
    this.instancing = instancing;
    this.ghost = rgbOf(options.ghostColor, 'ghostColor', [0.62, 0.72, 0.86]).map(linear) as RGB;
    this.ghostOpacity = unit(options.ghostOpacity, 'ghostOpacity', 0.15);
    this.selection = rgbOf(options.selectionColor, 'selectionColor', [0.1, 0.55, 1]).map(linear) as RGB;
    this.data = options.data;
    this.origin = [origin[0], origin[1], origin[2]];
    const doubleSided = options.doubleSided ?? true;
    this.materials = {
      opaque: new Material({ roughness: 0.8, metalness: 0, doubleSided }),
      translucent: new Material({ roughness: 0.8, metalness: 0, doubleSided, transparent: true, depthWrite: false }),
    };
    this.opaque = new Batches(engine, this.materials.opaque, limit);
    this.translucent = new Batches(engine, this.materials.translucent, limit);
  }

  /** Draws readIFCMeshes' output on `engine`: the same as createIFCScene. Dispose the scene to free it. */
  static attach(engine: EngineKernel, meshes: IFCMeshes, options: IFCSceneOptions = {}): IFCScene {
    return new IFCScene(engine, meshes.origin, options).add(meshes);
  }

  /** Every element with geometry, by expressID, in the order they were added. */
  get elements(): number[] {
    return this.order.map((s) => s.id);
  }
  /** The meshes the scene draws (for shadows.add, clustered.add, ssao.add or picking filters). */
  get meshes(): readonly MaterialMesh[] {
    return [...this.opaque.list, ...this.translucent.list].map((b) => b.mesh).concat(this.groups.map((g) => g.mesh));
  }

  /**
   * Adds readIFCMeshes' output or a streamIFCMeshes chunk. Placements join the scene's existing instance groups and
   * batches: a geometry placed `instancing` times over all adds draws instanced (its earlier batched parts move into
   * the group), and batches grow before new ones open, so a streamed model ends with the draws of a whole load. A
   * chunk may name geometries an earlier add sent. Growing replaces meshes: read `meshes` again after the last add.
   */
  add(meshes: Pick<IFCMeshes, 'geometries' | 'placements'>): this {
    this.live();
    const limit = this.opaque.limit,
      list: { p: IFCPlacement; g: IFCMeshGeometry }[] = [];
    for (const p of meshes.placements)
      list.push({
        p,
        g: meshes.geometries.get(p.geometry) ?? this.known.get(p.geometry) ?? fail('range', `placement of #${p.element} names missing geometry ${p.geometry}`),
      });
    for (const [key, g] of meshes.geometries) {
      if (this.known.get(key) !== g) this.uses.delete(key);
      this.known.set(key, g);
    }
    const useOf = (key: number) => {
      let u = this.uses.get(key);
      if (!u) this.uses.set(key, (u = { uses: 0, batched: [] }));
      return u;
    };
    for (const { p } of list) if (p.color[3] >= 1) useOf(p.geometry).uses++;
    const want = { vertices: 0, indices: 0, items: 0 },
      wantT = { vertices: 0, indices: 0, items: 0 };
    for (const { p, g } of list) {
      const n = g.positions.length / 3,
        u = useOf(p.geometry);
      if (p.color[3] >= 1 && ((this.instancing > 0 && u.uses >= this.instancing) || n > limit)) {
        if (!u.group) {
          const white: MeshGeometry = { positions: g.positions, normals: g.normals, indices: g.indices },
            group: Group = { mesh: createInstancedMesh(this.engine, white, this.materials.opaque, u.uses), slots: [], white };
          group.mesh.instances.count = 0;
          this.groups.push(group);
          u.group = group;
          for (const part of u.batched.splice(0)) {
            this.opaque.remove(part.item!);
            part.item = undefined;
            this.instance(group, part);
          }
        } else this.reserve(u.group, u.uses);
        continue;
      }
      const w = p.color[3] < 1 ? wantT : want;
      w.vertices += n;
      w.indices += g.indices.length;
      w.items++;
    }
    for (const { p, g } of list) {
      const slot = this.slot(p.element),
        color: Part['color'] = [linear(p.color[0]), linear(p.color[1]), linear(p.color[2]), p.color[3]],
        part: Part = { owner: slot, geometry: g, matrix: Float32Array.from(p.matrix), color };
      const group = p.color[3] >= 1 ? this.uses.get(p.geometry)!.group : undefined;
      if (group) this.instance(group, part);
      else {
        const translucent = p.color[3] < 1,
          w = translucent ? wantT : want,
          n = g.positions.length / 3,
          alpha = p.color[3];
        part.item = (translucent ? this.translucent : this.opaque).add(() => this.copy(g, slot, alpha), part.matrix, [color[0], color[1], color[2]], w);
        if (!translucent) this.uses.get(p.geometry)!.batched.push(part);
        w.vertices -= n;
        w.indices -= g.indices.length;
        w.items--;
      }
      slot.parts.push(part);
      this.draw(slot, part);
    }
    return this;
  }

  /** The state of an element, or undefined when it has no geometry here. */
  stateOf(id: number): IFCElementState | undefined {
    const s = this.slots.get(id);
    return s && { hidden: s.hidden, ghosted: s.ghosted, selected: s.selected, ...(s.srgb && { color: [...s.srgb] as RGB }), ...(s.opacity !== undefined && { opacity: s.opacity }) };
  }
  /** Shows or hides elements. IDs without geometry are skipped. */
  setVisible(ids: Iterable<number>, visible: boolean): this {
    return this.each(ids, (s) => (s.hidden = !visible));
  }
  hide(ids: Iterable<number>): this {
    return this.setVisible(ids, false);
  }
  show(ids: Iterable<number>): this {
    return this.setVisible(ids, true);
  }
  /** Shows only `ids`: every other element is hidden, or with `{ghost: true}` ghosted, as an x-ray isolate. */
  isolate(ids: Iterable<number>, options: { ghost?: boolean } = {}): this {
    const keep = new Set(ids);
    return this.each(this.elements, (s) => {
      const inside = keep.has(s.id);
      if (options.ghost) {
        s.hidden = false;
        s.ghosted = !inside;
      } else {
        s.hidden = !inside;
        if (inside) s.ghosted = false;
      }
    });
  }
  /** Shows every element and clears ghosting (colours, opacity and selection stay). */
  showAll(): this {
    return this.each(this.elements, (s) => {
      s.hidden = false;
      s.ghosted = false;
    });
  }
  /** Draws elements as translucent ghosts (or back as themselves). */
  setGhosted(ids: Iterable<number>, ghosted: boolean): this {
    return this.each(ids, (s) => (s.ghosted = ghosted));
  }
  /** Overrides elements' colour (sRGB components 0..1), or with null restores the file's colours. */
  setColor(ids: Iterable<number>, color: readonly number[] | null): this {
    const srgb = color === null ? undefined : rgbOf(color, 'color', [1, 1, 1]);
    return this.each(ids, (s) => {
      s.srgb = srgb;
      s.color = srgb?.map(linear) as RGB | undefined;
    });
  }
  /** Overrides elements' opacity (0 to 1; 1 or null restores the file's). */
  setOpacity(ids: Iterable<number>, opacity: number | null): this {
    const value = opacity === null ? undefined : unit(opacity, 'opacity', 1);
    return this.each(ids, (s) => (s.opacity = value === undefined || value >= 1 ? undefined : value));
  }
  /** Selects exactly `ids`, drawn in the selection colour. */
  select(ids: Iterable<number>): this {
    const chosen = new Set(ids);
    return this.each(this.elements, (s) => (s.selected = chosen.has(s.id)));
  }
  /** The selected elements, in the order they were added. */
  get selected(): number[] {
    return this.order.filter((s) => s.selected).map((s) => s.id);
  }
  /** The hidden elements, in the order they were added. */
  get hidden(): number[] {
    return this.order.filter((s) => s.hidden).map((s) => s.id);
  }

  /**
   * The element a pick hit: an instanced mesh by its `instanceId`, a batch by the element slot in UV0 (pick with
   * `@margoengine/selection/hit-details`, whose hits carry `uv`). Undefined for a hit on anything else.
   */
  elementAt(hit: { model?: unknown; mesh?: unknown; instanceId?: number; uv?: readonly number[] } | null | undefined): number | undefined {
    if (!hit) return;
    const owner = hit.model ?? hit.mesh;
    const group = this.groups.find((g) => g.mesh === owner || (g.mesh as { root?: unknown }).root === owner);
    if (group) return hit.instanceId === undefined ? undefined : this.order[group.slots[hit.instanceId]]?.id;
    const batched = [...this.opaque.list, ...this.translucent.list].some((b) => b.mesh === owner || b.mesh.root === owner);
    if (!batched || !hit.uv) return;
    return this.order[Math.round(hit.uv[0])]?.id;
  }

  /**
   * Section planes `[a, b, c, d]` (what has `a x + b y + c z + d < 0` is cut away), at most 16, on every material.
   * `@margoengine/ifc/section` adds caps and cut edges.
   */
  get clippingPlanes(): number[][] {
    return this.planes.map((p) => [...p]);
  }
  set clippingPlanes(planes: readonly (readonly number[])[]) {
    this.live();
    if (!Array.isArray(planes) || planes.length > 16)
      fail('range', `clippingPlanes holds at most 16 planes (got ${Array.isArray(planes) ? planes.length : 'none'}); pass fewer`);
    this.materials.opaque.clippingPlanes = planes;
    this.materials.translucent.clippingPlanes = planes;
    this.planes = planes.map((p) => [...p]);
  }
  /** Cuts away everything outside the box from `min` to `max` (engine axes, meters) and returns its six planes. */
  sectionBox(min: readonly number[], max: readonly number[]): number[][] {
    if (![...min, ...max].every(Number.isFinite) || min.length !== 3 || max.length !== 3 || min.some((v, i) => v > max[i]))
      fail('range', 'sectionBox takes finite min and max corners with min <= max');
    const planes = [0, 1, 2].flatMap((axis) => {
      const lo = [0, 0, 0, -min[axis]],
        hi = [0, 0, 0, max[axis]];
      lo[axis] = 1;
      hi[axis] = -1;
      return [lo, hi];
    });
    this.clippingPlanes = planes;
    return planes;
  }
  /**
   * The placed geometries of element `id` (none for an unknown id): its triangles, its placement in the scene's
   * coordinates (rebased by `origin`) and its file colour (linear RGB and alpha). Read-only views of the scene's data.
   */
  placementsOf(id: number): readonly { geometry: IFCMeshGeometry; matrix: Float32Array; color: readonly [number, number, number, number] }[] {
    return (this.slots.get(id)?.parts ?? []).map((p) => ({ geometry: p.geometry, matrix: p.matrix, color: p.color }));
  }
  /** The world box [minX, minY, minZ, maxX, maxY, maxZ] of `ids` (default every shown element); empty is all Infinity. */
  bounds(ids?: Iterable<number>): Float64Array {
    const box = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (const id of ids ?? this.order.filter((s) => !s.hidden).map((s) => s.id))
      for (const part of this.slots.get(id)?.parts ?? []) {
        const p = part.geometry.positions,
          m = part.matrix;
        for (let i = 0; i < p.length; i += 3)
          for (let r = 0; r < 3; r++) {
            const v = m[r] * p[i] + m[4 + r] * p[i + 1] + m[8 + r] * p[i + 2] + m[12 + r];
            if (v < box[r]) box[r] = v;
            if (v > box[3 + r]) box[3 + r] = v;
          }
      }
    return box;
  }
  /**
   * A storey plan: shows only the storey's elements, cuts everything `cutHeight` meters (default 1.2) above the
   * storey's elevation (IfcBuildingStorey.Elevation in SI, rebased by `origin`, or `elevation`) and returns a
   * top-down orthographic camera over it. Needs the `data` option.
   */
  storeyPlan(storey: number, options: { cutHeight?: number; elevation?: number } = {}): IFCStoreyPlan {
    const data = this.data ?? fail('range', 'storeyPlan needs the model data; pass createIFCScene(engine, meshes, { data })');
    const element = data.elements.get(storey);
    if (!element || element.type.toUpperCase() !== 'IFCBUILDINGSTOREY') fail('range', `#${storey} is not an IfcBuildingStorey of this model`);
    const raw = element!.attributes.Elevation,
      scale = data.units.byType.LENGTHUNIT?.scale ?? 1;
    const elevation =
      options.elevation ??
      (typeof raw === 'number' ? raw * scale - this.origin[1] : fail('range', `storey #${storey} has no Elevation; pass elevation`));
    const height = options.cutHeight ?? 1.2;
    if (!Number.isFinite(elevation) || !Number.isFinite(height)) fail('range', 'elevation and cutHeight must be finite');
    const ids = [...data.elements.values()].filter((e) => e.storey === storey).map((e) => e.id);
    this.isolate(ids);
    const cut = elevation + height,
      planes = [[0, -1, 0, cut]];
    this.clippingPlanes = planes;
    const b = this.bounds(ids),
      empty = !(b[0] <= b[3]),
      cx = empty ? 0 : (b[0] + b[3]) / 2,
      cz = empty ? 0 : (b[2] + b[5]) / 2,
      size = empty ? 10 : Math.max(b[3] - b[0], b[5] - b[2]) * 1.1;
    return {
      elevation,
      cut,
      clippingPlanes: planes,
      camera: { type: 'orthogonal', position: [cx, cut + 1, cz], target: [cx, elevation, cz], up: [0, 0, -1], height: Math.max(size, 1e-3) },
    };
  }

  /**
   * Applies a viewFromBCF result: visibility, colours (alpha below 1 as opacity), selection and section planes, each
   * replacing the scene's. Returns the view's camera for the app to set (undefined when the viewpoint has none).
   */
  applyBCFView(view: BCFView): BCFView['camera'] {
    this.live();
    if (view.clippingPlanes.length > 16) fail('range', `the viewpoint has ${view.clippingPlanes.length} section planes; a scene clips with at most 16`);
    const hidden = new Set(view.hidden),
      selected = new Set(view.selected);
    this.each(this.elements, (s) => {
      const c = view.colors.get(s.id);
      s.hidden = hidden.has(s.id);
      s.ghosted = false;
      s.selected = selected.has(s.id);
      s.srgb = c && [c[0], c[1], c[2]];
      s.color = s.srgb?.map(linear) as RGB | undefined;
      s.opacity = c && c[3] < 1 ? c[3] : undefined;
    });
    this.clippingPlanes = view.clippingPlanes;
    return view.camera;
  }
  /** The scene's state for bcfFromView: hidden, selected, colours (with opacity as alpha) and section planes. */
  bcfView(): Required<Pick<BCFViewInput, 'hidden' | 'selected' | 'colors' | 'clippingPlanes'>> {
    const colors = new Map<number, number[]>();
    for (const s of this.order)
      if (s.srgb || s.opacity !== undefined) colors.set(s.id, [...(s.srgb ?? this.fileColor(s)), s.opacity ?? 1]);
    return { hidden: this.hidden, selected: this.selected, colors, clippingPlanes: this.clippingPlanes };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opaque.dispose();
    this.translucent.dispose();
    for (const g of this.groups.splice(0)) g.mesh.dispose();
    this.materials.opaque.dispose();
    this.materials.translucent.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  private live(): void {
    if (this.disposed) fail('range', 'the IFC scene is disposed; create a new one');
  }
  /** Places `part` as the next instance of `group`. */
  private instance(group: Group, part: Part): void {
    this.reserve(group, group.mesh.instances.count + 1);
    const index = group.mesh.instances.count++;
    group.slots[index] = part.owner.index;
    part.instance = { group, index };
    this.draw(part.owner, part);
  }
  /** Rebuilds a full group's mesh with room for `count` instances (at least twice as many), its rows kept. */
  private reserve(group: Group, count: number): void {
    const old = group.mesh.instances;
    if (count <= old.capacity) return;
    const mesh = createInstancedMesh(this.engine, group.white, this.materials.opaque, Math.min(1_000_000, Math.max(count, old.capacity * 2)));
    mesh.instances.data.set(old.data.subarray(0, old.count * 24));
    mesh.instances.count = old.count;
    mesh.instances.needsUpdate = true;
    group.mesh.dispose();
    group.mesh = mesh;
  }
  private slot(id: number): Slot {
    let s = this.slots.get(id);
    if (!s) {
      s = { id, index: this.order.length, parts: [], overlay: [], hidden: false, ghosted: false, selected: false };
      this.slots.set(id, s);
      this.order.push(s);
    }
    return s;
  }
  private fileColor(s: Slot): RGB {
    const c = s.parts[0]?.color ?? [1, 1, 1];
    const srgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
    return [srgb(c[0]), srgb(c[1]), srgb(c[2])];
  }
  /** A batch copy of `g`: white vertex colours with `alpha`, and the element's slot in UV0 for picking. */
  private copy(g: IFCMeshGeometry, slot: Slot, alpha: number): MeshGeometry {
    const n = g.positions.length / 3,
      index = slot.index,
      uvs = new Float32Array(n * 2),
      colors = new Float32Array(n * 4).fill(1);
    for (let i = 0; i < n; i++) {
      uvs[i * 2] = index;
      colors[i * 4 + 3] = alpha;
    }
    return { positions: g.positions, normals: g.normals, indices: g.indices, uvs, colors };
  }
  private each(ids: Iterable<number>, change: (s: Slot) => void): this {
    this.live();
    for (const id of ids) {
      const s = this.slots.get(id);
      if (!s) continue;
      change(s);
      for (const part of s.parts) this.draw(s, part);
      this.overlay(s);
    }
    return this;
  }
  /** Draws one part as the element's state says: shown, tinted, or hidden behind a translucent overlay. */
  private draw(s: Slot, part: Part): void {
    const shown = !s.hidden && !s.ghosted && s.opacity === undefined,
      rgb = s.selected ? this.selection : (s.color ?? part.color);
    if (part.item) part.item.batch.setVisible(part.item.item, shown).setColor(part.item.item, [rgb[0], rgb[1], rgb[2]]);
    else if (part.instance) {
      const { group, index } = part.instance;
      group.mesh.instances.setMatrixAt(index, shown ? part.matrix : ZERO).setColorAt(index, [rgb[0], rgb[1], rgb[2], 1]);
    }
  }
  private overlay(s: Slot): void {
    const wanted = !s.hidden && (s.ghosted || s.opacity !== undefined);
    const rgb = s.ghosted ? this.ghost : s.selected ? this.selection : s.color,
      alpha = s.ghosted ? this.ghostOpacity : (s.opacity ?? 1),
      key = wanted ? `${rgb ?? 'file'}/${alpha}` : undefined;
    if (key === s.overlayKey) return;
    for (const item of s.overlay.splice(0)) this.translucent.remove(item);
    s.overlayKey = key;
    if (!wanted) return;
    // Overlay batches open with room for later ghosts, not just this element's parts.
    const need = { vertices: 0, indices: 0, items: s.parts.length };
    for (const p of s.parts) {
      need.vertices += p.geometry.positions.length / 3;
      need.indices += p.geometry.indices.length;
    }
    for (const p of s.parts) {
      const tint = rgb ?? ([p.color[0], p.color[1], p.color[2]] as RGB);
      s.overlay.push(this.translucent.add(() => this.copy(p.geometry, s, alpha), p.matrix, tint, {
          vertices: Math.max(need.vertices, 65_536),
          indices: Math.max(need.indices, 196_608),
          items: Math.max(need.items, 4_096),
        }));
    }
  }
}

/**
 * Draws readIFCMeshes' output with @margoengine/materials: instanced meshes for geometry placed `instancing` times or
 * more, BatchedMesh draws for the rest, ready for per-element visibility, ghosting, colour, picking and clipping.
 */
export function createIFCScene(engine: EngineKernel, meshes: IFCMeshes, options: IFCSceneOptions = {}): IFCScene {
  return IFCScene.attach(engine, meshes, options);
}
