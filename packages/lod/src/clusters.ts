import { Geometry, type EngineKernel, type Mesh } from '@margoengine/core';
import { meshRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import type { MutableVec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { fadeTest } from './fade.js';

/** Build settings for a boundary-preserving meshlet tree. */
export interface ClusterBuildOptions {
  /** Maximum source triangles per leaf, from 4 to 256. Default 124. */
  leafTriangles?: number;
  /** Maximum distinct vertices per rendered meshlet, from 3 to 256. Default 64. */
  maxVertices?: number;
  /** Fraction of child triangles retained by each parent, in (0,1). Default 0.5. */
  ratio?: number;
  /** Cancels loading the optional simplifier and the hierarchy build. */
  signal?: AbortSignal;
}
/** One immutable hierarchy region. Children partition its surface; meshlets partition its approximation. */
export interface ClusterNode {
  /** Dense index in the hierarchy. */
  readonly id: number;
  /** Finer regions, or an empty array at a leaf. */
  readonly children: readonly ClusterNode[];
  /** Renderable meshlets, each within the requested vertex and triangle limits. */
  readonly meshlets: readonly Geometry[];
  /** Bounding sphere of the full source region, before simplification. */
  readonly bounds: readonly number[];
  /** Conservative accumulated displacement from the full source, in local units. */
  readonly error: number;
}
/** CPU-built cluster hierarchy. No device or core/stage changes are required. */
export interface ClusterHierarchy {
  /** Coarsest region. */
  readonly root: ClusterNode;
  /** All nodes in postorder. */
  readonly nodes: readonly ClusterNode[];
  /** Input triangles, retained at the leaves without omission or duplication. */
  readonly triangles: number;
}

/** Meshlets retain the source's positions and normals exactly, including split normal seams. */
function meshlets(source: Geometry, indices: readonly number[], maxVertices: number, maxTriangles: number): Geometry[] {
  const out: Geometry[] = [];
  let remap = new Map<number, number>(),
    positions: number[] = [],
    normals: number[] = [],
    faces: number[] = [];
  const flush = () => {
    if (faces.length) out.push(new Geometry(positions, normals, faces));
    remap = new Map();
    positions = [];
    normals = [];
    faces = [];
  };
  for (let t = 0; t < indices.length; t += 3) {
    const corners = indices.slice(t, t + 3);
    const extra = new Set(corners.filter((v) => !remap.has(v))).size;
    if (faces.length / 3 >= maxTriangles || remap.size + extra > maxVertices) flush();
    for (const v of corners) {
      if (!remap.has(v)) {
        remap.set(v, remap.size);
        for (let k = 0; k < 3; k++) {
          positions.push(source.vertices[v * 6 + k]);
          normals.push(source.vertices[v * 6 + 3 + k]);
        }
      }
      faces.push(remap.get(v)!);
    }
  }
  flush();
  return out;
}

/**
 * Builds a spatial meshlet hierarchy bottom up, simplifying joined child regions while pinning every region boundary.
 * Thus adjacent regions may choose different depths without opening cracks. The simplifier is loaded only here.
 * @throws RangeError for invalid limits; simplifier errors for nonmanifold input; the abort reason on cancellation.
 */
export async function buildClusterLOD(source: Geometry, options: ClusterBuildOptions = {}): Promise<ClusterHierarchy> {
  const { leafTriangles = 124, maxVertices = 64, ratio = 0.5, signal } = options;
  if (
    !Number.isInteger(leafTriangles) ||
    leafTriangles < 4 ||
    leafTriangles > 256 ||
    !Number.isInteger(maxVertices) ||
    maxVertices < 3 ||
    maxVertices > 256 ||
    !(ratio > 0 && ratio < 1)
  )
    throw new RangeError('Invalid cluster settings; use leafTriangles 4-256, maxVertices 3-256 and ratio in (0,1).');
  signal?.throwIfAborted();
  const { simplifyMesh } = await import('@margoengine/mesh-edit/modeling');
  signal?.throwIfAborted();
  const nodes: ClusterNode[] = [],
    v = source.vertices;
  const build = (triangles: number[]): { node: ClusterNode; indices: number[] } => {
    signal?.throwIfAborted();
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (const t of triangles)
      for (let c = 0; c < 3; c++)
        for (let k = 0; k < 3; k++) {
          const value = v[source.indices[t * 3 + c] * 6 + k];
          min[k] = Math.min(min[k], value);
          max[k] = Math.max(max[k], value);
        }
    const center = min.map((x, k) => (triangles.length ? (x + max[k]) / 2 : 0));
    let radius = 0;
    for (const t of triangles)
      for (let c = 0; c < 3; c++) {
        const o = source.indices[t * 3 + c] * 6;
        radius = Math.max(radius, Math.hypot(v[o] - center[0], v[o + 1] - center[1], v[o + 2] - center[2]));
      }
    let children: ClusterNode[] = [],
      indices: number[],
      error = 0;
    if (triangles.length <= leafTriangles)
      indices = triangles.flatMap((t) => Array.from(source.indices.subarray(t * 3, t * 3 + 3)));
    else {
      const axis = [0, 1, 2].sort((a, b) => max[b] - min[b] - (max[a] - min[a]))[0];
      const centroid = (t: number) =>
        (v[source.indices[t * 3] * 6 + axis] +
          v[source.indices[t * 3 + 1] * 6 + axis] +
          v[source.indices[t * 3 + 2] * 6 + axis]) /
        3;
      triangles.sort((a, b) => centroid(a) - centroid(b) || a - b);
      const mid = Math.ceil(triangles.length / 2),
        a = build(triangles.slice(0, mid)),
        b = build(triangles.slice(mid));
      children = [a.node, b.node];
      indices = [...a.indices, ...b.indices];
      const globals = [...new Set(indices)],
        remap = new Map(globals.map((g, i) => [g, i]));
      const vertices = globals.map((g) => [v[g * 6], v[g * 6 + 1], v[g * 6 + 2]] as MutableVec3);
      const faces = Array.from({ length: indices.length / 3 }, (_, t) => ({
        id: String(t),
        vertices: indices.slice(t * 3, t * 3 + 3).map((g) => remap.get(g)!),
        uv: [
          [0, 0],
          [0, 0],
          [0, 0],
        ] as [number, number][],
      }));
      const edges = new Map<string, { a: number; b: number; count: number }>();
      for (const f of faces)
        for (let k = 0; k < 3; k++) {
          const a = f.vertices[k],
            b = f.vertices[(k + 1) % 3],
            key = a < b ? `${a}:${b}` : `${b}:${a}`;
          const edge = edges.get(key);
          if (edge) edge.count++;
          else edges.set(key, { a, b, count: 1 });
        }
      const locked = new Set<number>();
      for (const edge of edges.values())
        if (edge.count !== 2) {
          locked.add(edge.a);
          locked.add(edge.b);
        }
      const simplified = simplifyMesh(
        { vertices, faces },
        {
          targetTriangles: Math.max(1, Math.floor(faces.length * ratio)),
          lockedVertices: [...locked],
          mergeCoplanar: false,
          signal,
        },
      );
      indices = simplified.mesh.faces.flatMap((f) => f.vertices.map((i) => globals[simplified.sourceVertices[i]]));
      error = Math.max(a.node.error, b.node.error) + simplified.maxDeviation;
    }
    const node: ClusterNode = Object.freeze({
      id: nodes.length,
      children: Object.freeze(children),
      meshlets: Object.freeze(meshlets(source, indices, maxVertices, leafTriangles)),
      bounds: Object.freeze([...center, radius]),
      error,
    });
    nodes.push(node);
    return { node, indices };
  };
  const { node: root } = build(Array.from({ length: source.indices.length / 3 }, (_, i) => i));
  return Object.freeze({ root, nodes: Object.freeze(nodes), triangles: source.indices.length / 3 });
}

/** A projected-error query. Coordinates and spheres must be in the same space. */
export interface ClusterView {
  /** Camera's world position. */
  position: ArrayLike<number>;
  /** Vertical projection scale (cotangent of half the field of view for perspective). */
  yScale: number;
  /** Backbuffer height in pixels. */
  height: number;
  /** Orthographic projection, where depth does not change the error. Default false. */
  orthographic?: boolean;
  /** World matrix of the hierarchy. Default identity; conservative for shear and nonuniform scale. */
  matrix?: ArrayLike<number>;
  /** View-projection matrix, for view-depth error including off-axis regions. Default sphere-distance estimate. */
  clip?: ArrayLike<number>;
}
/** Conservative projected error, using the closest point of a region's sphere, in pixels. */
export function clusterScreenError(node: ClusterNode, view: ClusterView): number {
  const m = view.matrix,
    b = node.bounds;
  let scale = 1,
    x = b[0],
    y = b[1],
    z = b[2];
  if (m) {
    const norm1 = Math.max(...[0, 4, 8].map((o) => Math.abs(m[o]) + Math.abs(m[o + 1]) + Math.abs(m[o + 2])));
    const normInf = Math.max(...[0, 1, 2].map((o) => Math.abs(m[o]) + Math.abs(m[o + 4]) + Math.abs(m[o + 8])));
    scale = Math.sqrt(norm1 * normInf);
    x = m[0] * b[0] + m[4] * b[1] + m[8] * b[2] + m[12];
    y = m[1] * b[0] + m[5] * b[1] + m[9] * b[2] + m[13];
    z = m[2] * b[0] + m[6] * b[1] + m[10] * b[2] + m[14];
  }
  const error = (node.error * scale * Math.abs(view.yScale) * view.height) / 2;
  if (error === 0 || view.orthographic) return error;
  const c = view.clip;
  const distance = c
    ? c[3] * x + c[7] * y + c[11] * z + c[15] - b[3] * scale * Math.hypot(c[3], c[7], c[11])
    : Math.hypot(x - view.position[0], y - view.position[1], z - view.position[2]) - b[3] * scale;
  return distance <= 0 ? Infinity : error / distance;
}
/** One node's interval of the shared pixel-noise pattern, [low, high). */
export interface ClusterSelection {
  /** Region to render. */
  node: ClusterNode;
  /** Inclusive noise threshold. */
  low: number;
  /** Exclusive noise threshold. */
  high: number;
}
/**
 * Selects a complete adaptive cut. A dither band returns multiple cuts with disjoint pixel intervals along each path.
 * `errorPixels` defaults to 1 and `fade` to 0.2 (fraction of that error). Pass fade 0 for a hard cut.
 */
export function selectClusterLOD(
  hierarchy: ClusterHierarchy,
  view: ClusterView,
  errorPixels = 1,
  fade = 0.2,
): ClusterSelection[] {
  if (
    !(errorPixels > 0 && errorPixels < Infinity) ||
    !(fade >= 0 && fade < 1) ||
    !(view.height > 0) ||
    !Number.isFinite(view.yScale)
  )
    throw new RangeError('Invalid cluster view; use positive height/errorPixels, finite yScale and fade in [0,1).');
  const out: ClusterSelection[] = [];
  const visit = (node: ClusterNode, high: number) => {
    const error = clusterScreenError(node, view);
    const low = node.children.length
      ? Math.min(
          high,
          fade ? Math.max(0, Math.min(1, (error / errorPixels - (1 - fade)) / (2 * fade))) : +(error > errorPixels),
        )
      : 0;
    if (low < high) out.push({ node, low, high });
    if (low > 0) for (const child of node.children) visit(child, low);
  };
  visit(hierarchy.root, 1);
  return out;
}

/** Settings for the renderable {@link ClusterLOD}. */
export interface ClusterLODOptions {
  /** Target projected displacement in backbuffer pixels. Default 1. */
  errorPixels?: number;
  /** Fractional transition band around the target, in [0,1). Default 0.2. */
  fade?: number;
}
/** Adds interval dithering to core's shader without changing core. Unmanaged mesh ids have an empty interval. */
export function clusterFadeShader(code: string): string {
  if (!code.includes('@location(3) material:vec4f') || code.includes('var<storage,read> cluster_fades:')) return code;
  const withId = code.includes('lod_id:u32')
    ? code
    : code
        .replace(
          '@location(3) material:vec4f }',
          '@location(3) material:vec4f,@location(14) @interpolate(flat) lod_id:u32 }',
        )
        .replace('o.color=i.color.rgb;', 'o.color=i.color.rgb;o.lod_id=u32(i.factors.w);');
  return withId.replace(
    /@fragment fn fragment\(i:Output,@builtin\(front_facing\) front:bool\)->@location\(0\) vec4f \{/,
    (head) =>
      `@group(0) @binding(94) var<storage,read> cluster_fades:array<vec2f>;\n${fadeTest.replaceAll('lod_', 'cluster_')}\nfn cluster_keep(p:vec2f,r:vec2f)->bool {return r.x==r.y||(cluster_fade_keep(p,r.y)&&(r.x==0.0||!cluster_fade_keep(p,r.x)));}\n${head}\nif(!cluster_keep(i.clip.xy,cluster_fades[i.lod_id])){discard;}`,
  );
}

let serial = 0;
const renderers = new WeakMap<Engine, Set<ClusterLOD>>();
/**
 * Renders a built hierarchy with independently chosen meshlet regions and continuous complementary dither transitions.
 * All meshes inherit the supplied anchor's transform and material; the anchor itself should have no geometry.
 * Supports native WebGPU and the full WebGL2 compatibility device. The small preview requires promotion first.
 */
export class ClusterLOD implements EnginePlugin {
  readonly name = 'cluster-lod:' + serial++;
  private engine?: Engine;
  private meshes: Mesh[][] = [];
  private buffer?: GPUBuffer;
  private values = new Float32Array(0);
  private readonly shaders = new Map<string, string>();
  private selection: readonly ClusterSelection[] = [];
  /** Target projected displacement, in pixels. */
  errorPixels: number;
  /** Transition band as a fraction of the error target. */
  fade: number;
  constructor(
    readonly hierarchy: ClusterHierarchy,
    readonly anchor: Mesh,
    { errorPixels = 1, fade = 0.2 }: ClusterLODOptions = {},
  ) {
    if (!(errorPixels > 0 && errorPixels < Infinity) || !(fade >= 0 && fade < 1))
      throw new RangeError('Invalid cluster options; use positive errorPixels and fade in [0,1).');
    this.errorPixels = errorPixels;
    this.fade = fade;
  }
  /** Attaches the hierarchy renderer to an engine. */
  static attach(
    engine: EngineKernel,
    hierarchy: ClusterHierarchy,
    anchor: Mesh,
    options?: ClusterLODOptions,
  ): ClusterLOD {
    const value = new ClusterLOD(hierarchy, anchor, options);
    engine.use(value);
    return value;
  }
  setup(engine: Engine): void {
    requireWebGPU(engine, 'ClusterLOD');
    if (this.engine || meshRuntime(this.anchor).engine !== engine)
      throw new MargoError(
        'state',
        'ClusterLOD needs an unused renderer and an anchor from this engine; create a new renderer.',
      );
    this.engine = engine;
    let group = renderers.get(engine);
    if (!group) renderers.set(engine, (group = new Set()));
    group.add(this);
    this.meshes = this.hierarchy.nodes.map((node) =>
      node.meshlets.map((geometry) => {
        const mesh = engine
          .createMesh()
          .setGeometry(geometry)
          .setMaterial(this.anchor.material)
          .setParent(meshRuntime(this.anchor));
        mesh.visible = false;
        return mesh;
      }),
    );
  }
  /** Most recent adaptive cut, including dither intervals. */
  get selected(): readonly ClusterSelection[] {
    return this.selection;
  }
  onPreUpdate(): void {
    const e = this.engine;
    if (!e) return;
    e.store.tick(false);
    const c = e.camera.matrix;
    this.selection = selectClusterLOD(
      this.hierarchy,
      {
        position: e.camera.position,
        height: e.canvas.height,
        yScale: Math.hypot(c[1], c[5], c[9]) || 1 / Math.tan((e.camera.fov * Math.PI) / 360),
        orthographic: !!e.camera.project && c[3] === 0 && c[7] === 0 && c[11] === 0,
        matrix: meshRuntime(this.anchor).matrix,
        clip: c.some((x) => x !== 0) ? c : undefined,
      },
      this.errorPixels,
      this.fade,
    );
    if (this.values.length < e.store.capacity * 2) this.values = new Float32Array(e.store.capacity * 2);
    this.values.fill(0);
    for (const meshes of this.meshes) for (const mesh of meshes) mesh.visible = false;
    for (const { node, low, high } of this.selection)
      for (const mesh of this.meshes[node.id]) {
        mesh.visible = true;
        mesh.setMaterial(this.anchor.material);
        this.values.set([low, high], meshRuntime(mesh).id * 2);
      }
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name,
      order: -1,
      execute: (c) => {
        if (!this.engine || c.backend !== 'webgpu') return;
        let code = this.shaders.get(c.shader);
        if (!code) {
          if (this.shaders.size >= 64) this.shaders.clear();
          this.shaders.set(c.shader, (code = clusterFadeShader(c.shader)));
        }
        if (code === c.shader) return;
        c.shader = code;
        const combined = new Float32Array(this.engine!.store.capacity * 2);
        for (const renderer of renderers.get(this.engine!)!)
          for (const meshes of renderer.meshes)
            for (const mesh of meshes) {
              const at = meshRuntime(mesh).id * 2;
              combined[at] = renderer.values[at] ?? 0;
              combined[at + 1] = renderer.values[at + 1] ?? 0;
            }
        if (!this.buffer || this.buffer.size < combined.byteLength) {
          this.buffer?.destroy();
          this.buffer = c.device.createBuffer({ size: Math.max(8, combined.byteLength), usage: 128 | 8 });
        }
        c.device.queue.writeBuffer(this.buffer, 0, combined);
        c.bindings.push({ binding: 94, resource: { buffer: this.buffer } });
      },
    });
  }
  onDeviceRestored(): void {
    this.buffer = undefined;
  }
  /** Frees only the renderer's meshes and buffers; the input anchor and hierarchy remain caller-owned. */
  dispose(): void {
    const engine = this.engine;
    if (this.engine) renderers.get(this.engine)?.delete(this);
    for (const meshes of this.meshes) for (const mesh of meshes) mesh.dispose();
    this.meshes = [];
    this.selection = [];
    this.buffer?.destroy();
    this.buffer = undefined;
    this.engine = undefined;
    engine?.sceneOf(this)?.removePlugin(this.name);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
