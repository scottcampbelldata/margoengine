import type { ExportNode, GeometryData } from '@margoengine/exporters';
import {
  array,
  findChild,
  property,
  objectName,
  type FBXDocument,
  type FBXNode,
  type FBXConnection,
} from './document.js';
import {
  identity,
  inverse,
  multiply,
  decomposeTRS,
  fbxLocalTransform,
  fbxGeometricTransform,
  determinant3,
} from './math.js';
import { buildGeometry, type BuiltGeometry } from './geometry.js';

/** Cumulative import allocations and work, including repeated mesh instances. */
export class SceneBudget {
  private bytes = 0;
  private steps = 0;
  private morphBytes = 0;
  constructor(private readonly signal?: AbortSignal) {}
  reserve(bytes: number): void {
    this.signal?.throwIfAborted();
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 128 * 1024 * 1024 - this.bytes)
      throw new RangeError('FBX scene allocation budget exceeded');
    this.bytes += bytes;
  }
  work(steps = 1): void {
    this.signal?.throwIfAborted();
    if (!Number.isSafeInteger(steps) || steps < 0 || steps > 128_000_000 - this.steps)
      throw new RangeError('FBX scene work budget exceeded');
    this.steps += steps;
  }
  morph(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * 1024 * 1024 - this.morphBytes)
      throw new RangeError('FBX morph byte budget exceeded');
    this.reserve(bytes);
    this.morphBytes += bytes;
  }
}

export interface MeshBinding {
  node: ExportNode;
  geometry: GeometryData;
  controlPoints: Uint32Array;
  source: FBXNode;
  model: FBXNode;
  geometric: Float64Array;
  geometricInverse?: Float64Array;
  materialIndex: number;
}
export interface SceneContext {
  document: FBXDocument;
  nodes: Map<bigint, ExportNode>;
  models: Map<bigint, FBXNode>;
  incoming: Map<bigint, FBXConnection[]>;
  outgoing: Map<bigint, FBXConnection[]>;
  meshes: MeshBinding[];
  roots: ExportNode[];
  basis: Float64Array;
  basisInverse: Float64Array;
  signal?: AbortSignal;
  budget: SceneBudget;
}

export function context(document: FBXDocument, signal?: AbortSignal): SceneContext {
  const budget = new SceneBudget(signal);
  budget.work(document.connections.length + document.roots.length);
  budget.reserve(document.connections.length * 64 + 512);
  const incoming = new Map<bigint, FBXConnection[]>(),
    outgoing = new Map<bigint, FBXConnection[]>();
  for (const c of document.connections) {
    const a = incoming.get(c.parent) ?? [],
      b = outgoing.get(c.child) ?? [];
    a.push(c);
    b.push(c);
    incoming.set(c.parent, a);
    outgoing.set(c.child, b);
  }
  const settings = document.roots.find((n) => n.name === 'GlobalSettings'),
    basis = identity();
  if (settings) {
    const axes = [
      Number(property(settings, 'CoordAxis', 0)),
      Number(property(settings, 'UpAxis', 1)),
      Number(property(settings, 'FrontAxis', 2)),
    ];
    const signs = [
      Number(property(settings, 'CoordAxisSign', 1)),
      Number(property(settings, 'UpAxisSign', 1)),
      Number(property(settings, 'FrontAxisSign', 1)),
    ];
    const unit = Number(property(settings, 'UnitScaleFactor', 1)) * 0.01;
    if (
      !Number.isFinite(unit) ||
      unit <= 0 ||
      new Set(axes).size !== 3 ||
      axes.some((a) => !Number.isInteger(a) || a < 0 || a > 2) ||
      signs.some((s) => s !== 1 && s !== -1)
    )
      throw new TypeError('Invalid FBX axis or unit settings');
    basis.fill(0);
    basis[15] = 1;
    for (let row = 0; row < 3; row++) basis[axes[row] * 4 + row] = signs[row] * unit;
  }
  return {
    document,
    nodes: new Map(),
    models: new Map(),
    incoming,
    outgoing,
    meshes: [],
    roots: [],
    basis,
    basisInverse: inverse(basis),
    signal,
    budget,
  };
}

export function children(ctx: SceneContext, parent: bigint, kind = 'OO'): FBXNode[] {
  const list = ctx.incoming.get(parent) ?? [];
  ctx.budget.work(list.length);
  ctx.budget.reserve(list.length * 16);
  const out: FBXNode[] = [];
  for (const c of list) if (c.kind === kind) out.push(ctx.document.objects.get(c.child)!);
  return out;
}
export function convertedMatrix(ctx: SceneContext, m: ArrayLike<number>): Float64Array {
  ctx.budget.reserve(256);
  ctx.budget.work(128);
  return multiply(multiply(ctx.basis, m), ctx.basisInverse);
}
export function localParts(
  ctx: SceneContext,
  model: FBXNode,
  overrides?: { translation?: number[]; rotation?: number[]; scale?: number[] },
) {
  // The pivot chain allocates fixed-size matrices; property lookup scans also
  // count when animation repeatedly evaluates the same model.
  ctx.budget.reserve(8192);
  ctx.budget.work(4096 + model.children.length * 32 + (findChild(model, 'Properties70')?.children.length ?? 0) * 32);
  try {
    return decomposeTRS(convertedMatrix(ctx, fbxLocalTransform(model, overrides)));
  } catch (error) {
    throw new TypeError(`FBX model ${objectName(model)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function transformGeometry(
  geometry: GeometryData,
  m: Float64Array,
  budget?: SceneBudget,
  normalMatrix?: Float64Array,
): void {
  const p = geometry.positions as Float32Array,
    n = geometry.normals as Float32Array;
  budget?.work(p.length * 2 + (geometry.indices?.length ?? 0) + (geometry.tangents?.length ?? 0));
  if (!normalMatrix) budget?.reserve(128);
  const inv = normalMatrix ?? inverse(m);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i],
      y = p[i + 1],
      z = p[i + 2],
      nx = n[i],
      ny = n[i + 1],
      nz = n[i + 2];
    p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const a = inv[0] * nx + inv[1] * ny + inv[2] * nz,
      b = inv[4] * nx + inv[5] * ny + inv[6] * nz,
      c = inv[8] * nx + inv[9] * ny + inv[10] * nz,
      l = Math.hypot(a, b, c);
    if (!l || !Number.isFinite(l)) throw new RangeError('FBX normal must be nonzero');
    n[i] = a / l;
    n[i + 1] = b / l;
    n[i + 2] = c / l;
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2]))
      throw new RangeError('FBX position overflow');
  }
  const flip = determinant3(m) < 0 ? -1 : 1,
    t = geometry.tangents as Float32Array | undefined;
  if (t)
    for (let i = 0; i < t.length; i += 4) {
      const x = t[i],
        y = t[i + 1],
        z = t[i + 2],
        a = m[0] * x + m[4] * y + m[8] * z,
        b = m[1] * x + m[5] * y + m[9] * z,
        c = m[2] * x + m[6] * y + m[10] * z,
        l = Math.hypot(a, b, c);
      if (!l || !Number.isFinite(l)) throw new RangeError('Invalid FBX tangent transform');
      t[i] = a / l;
      t[i + 1] = b / l;
      t[i + 2] = c / l;
      t[i + 3] *= flip;
    }
  const indices = geometry.indices as Uint32Array;
  if (flip < 0)
    for (let i = 0; i < indices.length; i += 3) {
      const b = indices[i + 1];
      indices[i + 1] = indices[i + 2];
      indices[i + 2] = b;
    }
}

/** Charge before geometry's large generated-normal, topology and builder buffers. */
function preflight(ctx: SceneContext, source: FBXNode): void {
  const positions = array(source, 'Vertices'),
    indices = array(source, 'PolygonVertexIndex');
  if (positions.length > 3_000_000 || indices.length > 3_000_000) throw new RangeError('FBX geometry budget exceeded');
  ctx.budget.work(positions.length + indices.length * 4);
  let polygon = 0,
    triangles = 0;
  for (let i = 0; i < indices.length; i++) {
    polygon++;
    if (polygon > 4096) throw new RangeError('FBX geometry budget exceeded');
    if (indices[i] < 0) {
      ctx.budget.work(polygon * polygon);
      triangles += (polygon - 2) * 3;
      polygon = 0;
    }
  }
  if (polygon) throw new RangeError('FBX polygon is missing its terminator');
  if (triangles > 3_000_000) throw new RangeError('FBX geometry budget exceeded');
  const uv = findChild(source, 'LayerElementUV') ? 2 : 0,
    tangent = findChild(source, 'LayerElementTangent') ? 4 : 0,
    color = findChild(source, 'LayerElementColor') ? 4 : 0;
  const vertices = Math.min(indices.length, 1_000_000),
    width = 7 + uv + tangent + color;
  // Numeric JS builders and vertex-key maps coexist with the final typed arrays.
  ctx.budget.reserve(positions.length * 8 + indices.length * 32 + triangles * 12 + vertices * (128 + width * 12));
  ctx.budget.work(triangles * 32);
}

function cloneGeometry(ctx: SceneContext, baked: BuiltGeometry): BuiltGeometry {
  const arrays = ['positions', 'normals', 'uvs', 'tangents', 'colors', 'indices'] as const;
  let bytes = 0;
  for (const p of baked.primitives) for (const key of arrays) bytes += (p.geometry[key]?.length ?? 0) * 4;
  ctx.budget.reserve(bytes);
  ctx.budget.work(bytes / 4);
  return {
    ...baked,
    primitives: baked.primitives.map((p) => {
      const geometry: GeometryData = {
        positions: new Float32Array(p.geometry.positions),
        normals: new Float32Array(p.geometry.normals),
      };
      for (const key of ['uvs', 'tangents', 'colors'] as const)
        if (p.geometry[key]) geometry[key] = new Float32Array(p.geometry[key]!);
      geometry.indices = new Uint32Array(p.geometry.indices!);
      return { materialIndex: p.materialIndex, geometry };
    }),
  };
}

export function buildScene(ctx: SceneContext): void {
  ctx.budget.work(ctx.document.objects.size);
  ctx.budget.reserve(ctx.document.objects.size * 64);
  for (const [key, model] of ctx.document.objects) {
    if (model.name !== 'Model') continue;
    ctx.signal?.throwIfAborted();
    const parts = localParts(ctx, model),
      node: ExportNode = { name: objectName(model), ...parts, children: [] };
    ctx.nodes.set(key, node);
    ctx.models.set(key, model);
  }
  const parentIds = new Map<bigint, bigint>();
  for (const [key, node] of ctx.nodes) {
    ctx.budget.work((ctx.outgoing.get(key) ?? []).length);
    const parents = (ctx.outgoing.get(key) ?? []).filter((c) => c.kind === 'OO' && ctx.nodes.has(c.parent));
    if (parents.length > 1) throw new TypeError(`FBX model ${node.name} has multiple parents`);
    if (parents.length) {
      parentIds.set(key, parents[0].parent);
      (ctx.nodes.get(parents[0].parent)!.children as ExportNode[]).push(node);
    } else ctx.roots.push(node);
  }
  for (const [key, node] of ctx.nodes) {
    let depth = 0;
    for (let parent = parentIds.get(key); parent !== undefined; parent = parentIds.get(parent)) {
      ctx.budget.work();
      if (++depth > 60) throw new RangeError('FBX hierarchy is too deep');
      const s = ctx.nodes.get(parent)!.scale ?? [1, 1, 1];
      // RrSs inheritance is not parent*local when ancestors have nonuniform scale.
      if (Math.abs(s[0] - s[1]) > 1e-7 || Math.abs(s[1] - s[2]) > 1e-7)
        throw new TypeError(`Unsupported FBX nonuniform parent scale: ${node.name}`);
    }
  }
  let vertices = 0;
  const instances = new Map<FBXNode, number>(),
    cache = new Map<FBXNode, BuiltGeometry>();
  ctx.budget.work(ctx.document.connections.length);
  for (const c of ctx.document.connections) {
    const source = ctx.document.objects.get(c.child);
    if (c.kind === 'OO' && ctx.models.has(c.parent) && source?.name === 'Geometry' && source.properties[2] === 'Mesh')
      instances.set(source, (instances.get(source) ?? 0) + 1);
  }
  for (const [key, model] of ctx.models) {
    const node = ctx.nodes.get(key)!,
      sources = children(ctx, key).filter((n) => n.name === 'Geometry' && n.properties[2] === 'Mesh');
    if (sources.length > 1) throw new TypeError(`Multiple FBX geometries on model ${node.name}`);
    for (const source of sources) {
      ctx.signal?.throwIfAborted();
      let base = cache.get(source);
      if (!base) {
        preflight(ctx, source);
        base = buildGeometry(source);
        if ((instances.get(source) ?? 0) > 1) cache.set(source, base);
      }
      vertices += base.vertexCount;
      if (vertices > 1_000_000) throw new RangeError('FBX geometry budget exceeded');
      const baked = (instances.get(source) ?? 0) > 1 ? cloneGeometry(ctx, base) : base;
      ctx.budget.reserve(2304 + baked.primitives.length * 512);
      ctx.budget.work(1024 + baked.primitives.length);
      const geo = fbxGeometricTransform(model),
        m = multiply(ctx.basis, geo),
        normalMatrix = inverse(m);
      for (let i = 0; i < baked.primitives.length; i++) {
        const primitive = baked.primitives[i];
        transformGeometry(primitive.geometry, m, ctx.budget, normalMatrix);
        const target =
          baked.primitives.length === 1
            ? node
            : ({ name: `${node.name ?? 'Mesh'} material ${primitive.materialIndex}`, children: [] } as ExportNode);
        if (target !== node) (node.children as ExportNode[]).push(target);
        target.geometry = primitive.geometry;
        ctx.meshes.push({
          node: target,
          geometry: primitive.geometry,
          controlPoints: baked.controlPoints[i],
          source,
          model,
          geometric: m,
          geometricInverse: normalMatrix,
          materialIndex: primitive.materialIndex,
        });
      }
    }
  }
  if (!vertices) throw new RangeError('FBX has no mesh geometry');
}
