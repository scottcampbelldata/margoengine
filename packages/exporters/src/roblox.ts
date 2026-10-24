// Roblox GLB: the ordinary GLB writer, with every mesh primitive split into parts of at most 20,000 triangles.
import { writeGLB } from './gltf.js';
import type { ExportSource, Geo, Mat, Node, SceneOptions } from './scene.js';

/** Options for {@link exportRobloxGLB}. */
export interface RobloxGLBOptions extends SceneOptions {
  /** Most triangles in one part, 1 to 20,000 (Roblox's MeshPart limit). Default 20,000. */
  maxTrianglesPerPart?: number;
  /**
   * `'strict'` (default) throws for material fields beyond base color, base color texture, roughness, metalness and
   * emissive color; `'preserve'` writes them as the ordinary GLB writer does.
   */
  materialPolicy?: 'strict' | 'preserve';
  /** Collision the import settings ask Studio for: `'none'` (default) or `'studio'` (Studio-generated). */
  collision?: 'none' | 'studio';
  /** Keep the scene's node translation, rotation and scale clips. Default false: a scene with clips throws. */
  animations?: boolean;
  /** `asset.generator`. Default 'Margo Engine exporters'. */
  generator?: string;
}

/** One split piece of a source primitive, written as its own glTF primitive (one Studio MeshPart). */
export interface RobloxPart {
  /** The part's first triangle in its source primitive's triangle list. */
  firstTriangle: number;
  /** Triangles in the part, at most `maxTrianglesPerPart`. */
  triangleCount: number;
  /** For each part vertex, the source primitive's vertex index it copies. */
  sourceVertices: number[];
}

/** Where a part is used: one per glTF primitive written. */
export interface RobloxPartUse {
  /** glTF node index. */
  node: number;
  /** Primitive index in that node's mesh. */
  primitive: number;
  /** Index into the source node's `primitives` (0 for a node with `geometry`). */
  sourcePrimitive: number;
  /** Index into {@link RobloxMapping.parts}. */
  part: number;
}

/** Studio 3D Importer settings that keep the parts as exported. */
export interface RobloxImportSettings {
  /** Merging would join the parts back over the triangle limit. */
  mergeMeshes: false;
  /** One Model holding a MeshPart per part. */
  importAs: 'Model';
  /** One scene unit is one stud. */
  scaleUnit: 'Studs';
  /** Keep the node transforms as part pivots. */
  useImportedPivots: true;
  /** Keep `COLOR_0`. */
  ignoreVertexColors: false;
  /** Full-detail MeshPart rendering. */
  renderFidelity: 'Precise';
  /** `'none'`: set CanCollide, CanTouch and CanQuery false on the parts; `'studio'`: let Studio generate collision. */
  collision: 'none' | 'studio';
}

/** The JSON-ready sidecar of a Roblox export: parts back to source geometry, and import settings. */
export interface RobloxMapping {
  /** Every part written, in the order first written. */
  parts: RobloxPart[];
  /** Every glTF primitive written, in node and primitive order. */
  uses: RobloxPartUse[];
  importSettings: RobloxImportSettings;
}

/** The GLB and its mapping. */
export interface RobloxGLBResult {
  /** The `.glb` file. */
  glb: Uint8Array;
  /** Save next to the GLB with `JSON.stringify`. */
  mapping: RobloxMapping;
}

const MAX_TRIANGLES = 20_000;
const CAGE = /_(inner|outer)cage$/i;
const ROLES = /^(collision|cage|innercage|outercage|inner-cage|outer-cage|wraplayer|wraptarget)$/i;

/**
 * Exports a GLB for Roblox Studio's 3D Importer: the ordinary GLB writer's output, except that every mesh primitive
 * over `maxTrianglesPerPart` triangles is split into parts that keep every triangle and every vertex attribute value
 * (only vertices a part uses are copied). Parts of shared geometry are written once. `mapping` records each part's
 * source triangles and vertices and suggested Studio import settings; write it next to the GLB as JSON. Studio's
 * acceptance of the result is not tested by this package.
 * @throws TypeError for a feature Roblox meshes cannot hold, each naming the fix: skins, morph targets, cameras,
 * lights, a second UV set, lightmaps, material animations, node clips without `animations: true`, layered-clothing cage
 * names (`_InnerCage`, `_OuterCage`), collision or cage roles in `extras.margo.role` (or `extras.margo_collision`), and
 * with `materialPolicy: 'strict'`, material fields beyond the base set; RangeError for a `maxTrianglesPerPart` outside
 * 1 to 20,000; plus everything {@link exportGLB} throws.
 */
export function exportRobloxGLB(source: ExportSource, options: RobloxGLBOptions = {}): RobloxGLBResult {
  const {
    maxTrianglesPerPart: cap = MAX_TRIANGLES,
    materialPolicy = 'strict',
    collision = 'none',
    animations = false,
  } = options;
  if (!Number.isInteger(cap) || cap < 1 || cap > MAX_TRIANGLES)
    throw new RangeError(`maxTrianglesPerPart must be a whole number from 1 to ${MAX_TRIANGLES}`);
  if (materialPolicy !== 'strict' && materialPolicy !== 'preserve')
    throw new TypeError("materialPolicy must be 'strict' or 'preserve'");
  if (collision !== 'none' && collision !== 'studio') throw new TypeError("collision must be 'none' or 'studio'");
  if (typeof animations !== 'boolean') throw new TypeError('animations must be boolean');
  const scene = source as { lightmap?: unknown; animations?: unknown[]; materialAnimations?: unknown[] };
  if (scene.lightmap !== undefined) throw new TypeError('Roblox export cannot hold a lightmap; use exportGLB');
  if (scene.materialAnimations?.length)
    throw new TypeError('Roblox export cannot hold material animations; leave them out or use exportGLB');
  if (scene.animations?.length && !animations)
    throw new TypeError('The scene has animation clips; pass animations: true to keep them, or leave them out');
  const parts: RobloxPart[] = [],
    uses: RobloxPartUse[] = [],
    split = new Map<Geo, { geometry: Geo; part: number }[]>(),
    shared = new Map<object, { primitives: NonNullable<Node['primitives']>; from: number[] }>(),
    single = new Map<Geo, Map<Mat | null, object>>();

  const check = (node: Node): void => {
    const label = `Node ${node.name ?? '(unnamed)'}`;
    if (node.skin || node.morphWeights) throw new TypeError(`${label}: Roblox export has no skins or morph targets`);
    if (node.camera || node.light) throw new TypeError(`${label}: Roblox export has no cameras or lights`);
    for (const name of [node.name, node.meshName])
      if (name !== undefined && CAGE.test(name))
        throw new TypeError(`${label}: Studio reads ${name} as a layered-clothing cage; rename it`);
    for (const extras of [node.extras, node.meshExtras] as (Record<string, unknown> | undefined)[]) {
      const role = (extras?.margo as { role?: unknown } | undefined)?.role;
      if (extras?.margo_collision !== undefined || (typeof role === 'string' && ROLES.test(role)))
        throw new TypeError(`${label}: a collision or cage proxy is not a visual mesh; leave it out of the scene`);
    }
  };
  const checkPrimitive = (label: string, geo: Geo, mat: Mat | undefined): void => {
    if (geo.joints || geo.morphs) throw new TypeError(`${label}: Roblox export has no skins or morph targets`);
    if (geo.uvs1 || mat?.baseColorTexture?.texCoord === 1)
      throw new TypeError(`${label}: Roblox export has one UV set; drop uvs1`);
    if (
      materialPolicy === 'strict' &&
      mat &&
      (mat.metallicRoughnessTexture ||
        mat.normalTexture ||
        mat.occlusionTexture ||
        mat.emissiveTexture ||
        mat.baseColorTextureTransform ||
        mat.unlit ||
        mat.shading !== 'standard' ||
        mat.transmission !== 0 ||
        mat.ior !== 1.5 ||
        mat.emissiveStrength !== 1)
    )
      throw new TypeError(
        `${label}: material ${mat.name ?? ''} uses fields beyond base color, roughness, metalness and emissive; pass materialPolicy: 'preserve' to write them`,
      );
  };
  // The geometry's triangles in parts of at most `cap`, each with its own compact vertex streams.
  const partsOf = (geo: Geo): { geometry: Geo; part: number }[] => {
    let out = split.get(geo);
    if (out) return out;
    out = [];
    const owner = geo.base ?? geo,
      remap = new Int32Array(owner.count).fill(-1);
    for (let start = 0; start < geo.indices.length; start += cap * 3) {
      const end = Math.min(start + cap * 3, geo.indices.length),
        indices = new Uint32Array(end - start),
        sourceVertices: number[] = [];
      for (let i = start; i < end; i++) {
        const v = geo.indices[i];
        if (remap[v] < 0) remap[v] = sourceVertices.push(v) - 1;
        indices[i - start] = remap[v];
      }
      for (const v of sourceVertices) remap[v] = -1;
      const stream = (values: Float32Array, width: number): Float32Array => {
        const copy = new Float32Array(sourceVertices.length * width);
        sourceVertices.forEach((v, i) => copy.set(values.subarray(v * width, v * width + width), i * width));
        return copy;
      };
      const part: Geo = {
        positions: stream(owner.positions, 3),
        normals: stream(owner.normals, 3),
        indices,
        count: sourceVertices.length,
        colorSize: owner.colorSize,
      };
      if (owner.uvs) part.uvs = stream(owner.uvs, 2);
      if (owner.tangents) part.tangents = stream(owner.tangents, 4);
      if (owner.colors) part.colors = stream(owner.colors, owner.colorSize);
      out.push({ geometry: part, part: parts.length });
      parts.push({ firstTriangle: start / 3, triangleCount: (end - start) / 3, sourceVertices });
    }
    split.set(geo, out);
    return out;
  };
  let index = 0;
  // Visits in the writer's node order (depth first, parent before children), so `index` is the glTF node index.
  const visit = (node: Node): void => {
    const at = index++;
    check(node);
    const items = node.primitives ?? (node.geometry ? [{ geometry: node.geometry, material: node.material }] : []);
    if (items.length) {
      let key: object | undefined = node.primitivesKey;
      if (!node.primitives) {
        let byMaterial = single.get(node.geometry!);
        if (!byMaterial) single.set(node.geometry!, (byMaterial = new Map()));
        key = byMaterial.get(node.material ?? null);
        if (!key) byMaterial.set(node.material ?? null, (key = {}));
      }
      let entry = key && shared.get(key);
      if (!entry) {
        entry = { primitives: [], from: [] };
        for (const [i, item] of items.entries()) {
          checkPrimitive(`Node ${node.name ?? '(unnamed)'} primitive ${i}`, item.geometry, item.material);
          for (const { geometry, part } of partsOf(item.geometry)) {
            entry.primitives.push({ geometry, material: item.material, extras: item.extras });
            entry.from.push(i, part);
          }
        }
        if (key) shared.set(key, entry);
      }
      node.primitives = entry.primitives;
      node.primitivesKey = key;
      node.geometry = entry.primitives[0].geometry;
      for (let p = 0; p < entry.from.length / 2; p++)
        uses.push({ node: at, primitive: p, sourcePrimitive: entry.from[p * 2], part: entry.from[p * 2 + 1] });
    }
    node.children.forEach(visit);
  };
  const { onlyVisible, root, geometryData, materialData, generator } = options;
  return {
    glb: writeGLB(source, { onlyVisible, root, geometryData, materialData, generator }, (roots) =>
      roots.forEach(visit),
    ),
    mapping: {
      parts,
      uses,
      importSettings: {
        mergeMeshes: false,
        importAs: 'Model',
        scaleUnit: 'Studs',
        useImportedPivots: true,
        ignoreVertexColors: false,
        renderFidelity: 'Precise',
        collision,
      },
    },
  };
}
